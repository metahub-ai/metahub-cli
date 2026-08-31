/**
 * Build a self-contained, npm-publish-shaped tarball of the CLI that
 * carries every workspace dep inline. The output is a single .tgz
 * the install.sh script can fetch from registry.metahub.ai/cli/
 * and install directly via `npm install -g <url>` — no dependency on
 * the npm registry having the @metahub-ai/mh package published yet.
 *
 * What this produces:
 *
 *   packages/cli/standalone/metahub-cli-<version>.tgz
 *
 * Tarball layout:
 *
 *   package/
 *     package.json            ← stripped of workspace:* deps (bundled inline)
 *     bin/mh.js               ← CLI entry shim
 *     bin/metahub-mcp.js      ← MCP server entry shim
 *     dist/cli.js             ← single ESM bundle of CLI + workspace deps
 *     dist/mcp/server.js      ← single ESM bundle of @metahub/mcp-server
 *     README.md               ← if present
 *
 * Both bin scripts are wired up via `bin` in package.json so a global
 * install (npm/pnpm/yarn/bun) places BOTH `mh` and `metahub-mcp` on
 * PATH, and findMetahubMcpBin() can resolve the MCP server via
 * `require.resolve('@metahub-ai/mh/bin/metahub-mcp.js')`.
 *
 * `npm install -g` understands this shape and creates the `mh` binary
 * on PATH the same way a normal global install does.
 *
 * Run:
 *   pnpm --filter @metahub-ai/mh bundle
 *
 * Or as part of the registry build (so the tarball is served from
 * apps/registry/public/cli/mh-latest.tgz):
 *   pnpm --filter @metahub-ai/mh bundle && cp standalone/*.tgz \
 *     ../../apps/registry/public/cli/
 */
import esbuild from "esbuild";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const PKG_DIR = path.resolve(HERE, "..");
const OUT_ROOT = path.join(PKG_DIR, "standalone");
const STAGE = path.join(OUT_ROOT, "package");

async function main() {
  const pkgRaw = await fs.readFile(path.join(PKG_DIR, "package.json"), "utf8");
  const pkg = JSON.parse(pkgRaw);

  console.log(`[bundle] cleaning ${OUT_ROOT}`);
  await fs.rm(OUT_ROOT, { recursive: true, force: true });
  await fs.mkdir(path.join(STAGE, "bin"), { recursive: true });
  await fs.mkdir(path.join(STAGE, "dist", "mcp"), { recursive: true });

  // Shared esbuild options. External stays empty so workspace deps
  // bake into the bundle — that's the whole point of "standalone".
  const sharedEsbuild = {
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    external: [],
    resolveExtensions: [".ts", ".tsx", ".mjs", ".cjs", ".js"],
    banner: { js: "#!/usr/bin/env node" },
    legalComments: "none",
    minify: false,
  };

  console.log(`[bundle] esbuild → dist/cli.js (the mh entry)`);
  await esbuild.build({
    ...sharedEsbuild,
    entryPoints: [path.join(PKG_DIR, "src/cli.ts")],
    outfile: path.join(STAGE, "dist/cli.js"),
    // Inline the version so cliVersion()'s filesystem lookup —
    // which expects `dist/lib/version.js` next to its package.json
    // — doesn't try to walk a structure that doesn't exist in the
    // flat bundled layout (everything is in dist/cli.js).
    define: {
      __METAHUB_CLI_VERSION__: JSON.stringify(pkg.version),
    },
  });

  // Bundle the MCP server too so `mh bootstrap` can wire it without
  // needing @metahub/mcp-server on disk as a sibling. Entry point is
  // the MCP server's own bin script (a tiny `#!/usr/bin/env node` +
  // import-its-cli shim); we resolve it relative to PKG_DIR/.. so
  // the workspace layout is the source of truth.
  const MCP_ROOT = path.resolve(PKG_DIR, "..", "mcp-server");
  console.log(`[bundle] esbuild → dist/mcp/server.js (the metahub-mcp entry)`);
  await esbuild.build({
    ...sharedEsbuild,
    entryPoints: [path.join(MCP_ROOT, "src/cli.ts")],
    outfile: path.join(STAGE, "dist/mcp/server.js"),
  });

  // CLI bin shim → bundled CLI.
  await fs.writeFile(
    path.join(STAGE, "bin/mh.js"),
    `#!/usr/bin/env node\nimport "../dist/cli.js";\n`,
    { mode: 0o755 },
  );
  // MCP bin shim → bundled MCP. This is what findMetahubMcpBin()
  // resolves via `require.resolve('@metahub-ai/mh/bin/metahub-mcp.js')`.
  await fs.writeFile(
    path.join(STAGE, "bin/metahub-mcp.js"),
    `#!/usr/bin/env node\nimport "../dist/mcp/server.js";\n`,
    { mode: 0o755 },
  );

  // Stripped package.json — all deps were bundled, so npm install sees
  // a zero-dep package and resolves nothing at install time. That's
  // what makes the tarball install reliable when the workspace deps
  // aren't on the npm registry.
  //
  // `bin` lists BOTH `mh` and `metahub-mcp` so a global install drops
  // both binaries on PATH. `metahub-mcp` is what every MCP-capable
  // client launches as its server command after `mh bootstrap`.
  const stripped = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    license: pkg.license,
    homepage: pkg.homepage,
    repository: pkg.repository,
    keywords: pkg.keywords,
    type: pkg.type,
    bin: {
      mh: "bin/mh.js",
      "metahub-mcp": "bin/metahub-mcp.js",
    },
    engines: pkg.engines,
    publishConfig: pkg.publishConfig,
    // `dependencies` intentionally omitted (everything bundled).
  };
  await fs.writeFile(path.join(STAGE, "package.json"), JSON.stringify(stripped, null, 2) + "\n");

  // README is optional. Copy if present so `npm view` etc. has docs.
  try {
    await fs.copyFile(path.join(PKG_DIR, "README.md"), path.join(STAGE, "README.md"));
  } catch {
    // No README — fine.
  }
  await fs.copyFile(path.resolve(PKG_DIR, "..", "..", "LICENSE"), path.join(STAGE, "LICENSE"));

  // Install-source marker. `mh upgrade` reads this to decide whether
  // to re-run install.sh (tarball install) or hand off to npm/pnpm/bun
  // (registry install). The file is intentionally tiny so the only
  // contract is "exists ⇒ tarball install".
  await fs.writeFile(path.join(STAGE, "dist", ".install-source"), "tarball\n");

  console.log(`[bundle] packing tarball`);
  // Use `npm pack` so the tarball matches the exact shape `npm install`
  // expects. Run from the staging dir; npm reads the local package.json
  // and pinches the filename from it.
  execSync(`npm pack --pack-destination ${JSON.stringify(OUT_ROOT)}`, {
    cwd: STAGE,
    stdio: "inherit",
  });

  // npm pack names the file by package name → metahub-cli-x.y.z.tgz when
  // the scope is stripped, or @metahub-cli-x.y.z.tgz otherwise. Resolve
  // whatever it produced and also write a stable mh-latest.tgz alongside
  // so install.sh can ignore the version.
  const tarballs = (await fs.readdir(OUT_ROOT)).filter((f) => f.endsWith(".tgz"));
  const versioned = tarballs.find((f) => f.includes(pkg.version)) ?? tarballs[0];
  if (!versioned) {
    throw new Error("npm pack did not produce a .tgz");
  }
  const latest = path.join(OUT_ROOT, "mh-latest.tgz");
  await fs.copyFile(path.join(OUT_ROOT, versioned), latest);

  // The packed tarball keeps the marker because install.sh owns upgrades for
  // that distribution. The directory itself is the npm publish target, so
  // remove the marker there: npm-installed copies must upgrade through npm.
  await fs.rm(path.join(STAGE, "dist", ".install-source"));

  const size = (await fs.stat(latest)).size;
  console.log(`[bundle] ok — ${versioned} (${(size / 1024).toFixed(1)} KiB) + mh-latest.tgz`);
}

main().catch((err) => {
  console.error("[bundle] failed:", err);
  process.exit(1);
});
