/**
 * `mh upgrade` (alias `mh self-update`) — re-install the CLI in place.
 *
 * The upgrade path depends on how the CLI was installed:
 *
 *   - Tarball install (registry.metahub.ai/install.sh) — we re-run the
 *     same shell installer. The presence of `dist/.install-source` next
 *     to the bundled CLI is the marker; the standalone bundler writes
 *     it during `pnpm bundle`.
 *
 *   - npm / pnpm / bun global install — we DON'T touch their global
 *     store. Instead we print the appropriate `<pm> add -g @metahub-ai/mh`
 *     command and exit. The user runs it from a shell with the right
 *     credentials.
 *
 *   - Unknown source — we print both options so the user can pick.
 *
 * Tested via the marker-detection logic. The actual `curl … | sh` round
 * trip is best-exercised by hand on a fresh machine; we don't fork a
 * real subprocess in unit tests.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { c, glyph, header } from "../lib/ui.js";

/**
 * Walk up from THIS file (transpiled into dist/) to find the bundled
 * `dist/.install-source` marker. We try a few candidates because the
 * file lives at different relative depths depending on whether the
 * CLI was bundled into a single dist/cli.js or built into dist/lib/.
 */
export function detectInstallSource(): "tarball" | "package-manager" | "unknown" {
  const candidates = installSourceCandidates();
  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, "utf8").trim();
      if (raw === "tarball") return "tarball";
    } catch {
      /* try next */
    }
  }
  // No marker — could be a workspace dev build or a pkg-mgr global.
  // We err on the side of "unknown" so the user gets both options.
  return "unknown";
}

/**
 * Where to look for the install-source marker file. Public for tests.
 */
export function installSourceCandidates(): string[] {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // The bundler stages the marker under `dist/.install-source`.
    // From `dist/cli.js` that's `<here>/.install-source`; from
    // `dist/commands/upgrade.js` it's `<here>/../.install-source`.
    return [
      path.resolve(here, ".install-source"),
      path.resolve(here, "..", ".install-source"),
      path.resolve(here, "..", "..", ".install-source"),
    ];
  } catch {
    return [];
  }
}

const INSTALL_SH = "https://registry.metahub.ai/install.sh";

export async function upgrade(): Promise<number> {
  const source = detectInstallSource();

  console.log(header("upgrade"));
  console.log();

  if (source === "tarball") {
    console.log(`  ${c.dim(glyph.step)} install source: ${c.bold("tarball")}`);
    console.log(`  ${c.dim(glyph.step)} re-running ${c.cyan(INSTALL_SH)}`);
    console.log();
    return runShellInstaller();
  }

  if (source === "package-manager") {
    // Reserved — once we have the registry-published package, the
    // bundler can stamp a different marker and we branch here. Until
    // then "unknown" covers the same case.
    return suggestPackageManagers();
  }

  // unknown
  console.log(`  ${c.yellow(glyph.warn)} ${c.bold("can't determine install source")}`);
  console.log(`  ${c.dim("To upgrade, run one of:")}`);
  console.log();
  console.log(`    ${c.cyan("curl -fsSL " + INSTALL_SH + " | sh")}`);
  console.log(`    ${c.dim("# or with npm:")}`);
  console.log(`    ${c.cyan("npm install -g @metahub-ai/mh")}`);
  console.log(`    ${c.cyan("pnpm add -g @metahub-ai/mh")}`);
  console.log(`    ${c.cyan("bun add -g @metahub-ai/mh")}`);
  return 0;
}

/**
 * Spawn `sh -c "curl -fsSL <url> | sh"` and inherit stdio so the
 * installer's own progress output streams to the user. Returns 0 on
 * exit-success, 1 otherwise.
 */
function runShellInstaller(): Promise<number> {
  return new Promise((resolve) => {
    const cmd = `curl -fsSL ${INSTALL_SH} | sh`;
    const child = spawn("sh", ["-c", cmd], { stdio: "inherit" });
    child.on("error", (err) => {
      console.error(`${c.red(glyph.cross)} ${err.message}`);
      resolve(1);
    });
    child.on("exit", (code) => {
      if (code === 0) {
        console.log();
        console.log(`  ${c.green(glyph.check)} ${c.bold("upgrade complete")}`);
        resolve(0);
      } else {
        console.error(`  ${c.red(glyph.cross)} installer exited ${code ?? "with signal"}`);
        resolve(1);
      }
    });
  });
}

function suggestPackageManagers(): number {
  console.log(`  ${c.dim(glyph.step)} install source: ${c.bold("package manager")}`);
  console.log(`  ${c.dim("Run the global-update for the package manager you used:")}`);
  console.log();
  console.log(`    ${c.cyan("npm install -g @metahub-ai/mh")}`);
  console.log(`    ${c.cyan("pnpm add -g @metahub-ai/mh")}`);
  console.log(`    ${c.cyan("bun add -g @metahub-ai/mh")}`);
  return 0;
}
