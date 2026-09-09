/**
 * Make a freshly extracted MCP-kind artifact runnable.
 *
 * The registry pins every artifact to a Git SHA and the installer
 * downloads that tree as a tarball, which is exactly the code the eval
 * ran against. For most MCP servers that tree is *source*: a
 * TypeScript project whose `bin` points at `dist/index.js`, with no
 * `dist/` and no `node_modules/` checked in. Wiring `node dist/index.js`
 * into every client then fails silently the first time the client
 * launches it.
 *
 * This module runs the two steps a human would: `npm install` (with
 * lifecycle scripts disabled — the tree is untrusted until it runs as a
 * server anyway) and `npm run build` when the package declares one,
 * then confirms the entry point exists. Anything that still cannot be
 * resolved is reported as a warning so `wireHook` refuses to write a
 * launch command that would not start.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export interface McpPackageJson {
  name?: string;
  bin?: string | Record<string, string>;
  main?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface McpLaunch {
  command: string;
  args: string[];
}

export interface McpPrepareResult {
  /** Human-readable steps that ran, in order (empty when nothing was needed). */
  steps: string[];
  /** Set when the server still cannot be launched after preparation. */
  warning?: string;
  /**
   * Set when the pinned source tree could not be made runnable but the
   * package is published on npm: the client should launch that instead.
   * `note` explains the substitution to the user.
   */
  launchOverride?: McpLaunch;
  note?: string;
}

export interface McpPrepareOptions {
  /** Called before each step runs, for progress rendering. */
  onStep?: (step: string) => void;
  /** Per-step timeout. Defaults to five minutes. */
  timeoutMs?: number;
}

export function readMcpPackageJson(installDir: string): McpPackageJson | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(installDir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * The file `node` would be pointed at for this package, or null when
 * the package launches some other way (`scripts.start`) or declares
 * nothing at all.
 */
export function resolveMcpEntry(installDir: string, pkg: McpPackageJson | null): string | null {
  if (pkg?.bin) {
    const binFile = typeof pkg.bin === "string" ? pkg.bin : Object.values(pkg.bin)[0];
    if (binFile) return path.join(installDir, binFile);
  }
  if (pkg?.main) return path.join(installDir, pkg.main);
  return null;
}

function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function npmBinary(): string {
  if (process.env.METAHUB_NPM_BIN) return process.env.METAHUB_NPM_BIN;
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

/**
 * A source tree that depends on `workspace:` / `catalog:` siblings is a
 * monorepo member; npm cannot resolve those specifiers outside the
 * monorepo, so `npm install` is guaranteed to fail.
 */
function hasWorkspaceDeps(pkg: McpPackageJson): boolean {
  const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  return Object.values(all).some((v) => /^(workspace|catalog):/.test(v));
}

/**
 * Look the package up on npm. Returns the published version, or null
 * when the name is unknown or the registry could not be reached.
 */
function publishedVersion(name: string, cwd: string, timeoutMs: number): string | null {
  const res = spawnSync(npmBinary(), ["view", name, "version", "--json"], {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
    shell: process.platform === "win32",
  });
  if (res.error || res.status !== 0) return null;
  try {
    const parsed: unknown = JSON.parse(res.stdout.trim());
    const v = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed;
    return typeof v === "string" && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * Decide what to do when the pinned tree cannot run: point the client at
 * the published package (pinned to the version seen now) when there is
 * one, otherwise surface `reason` as the warning.
 */
function fallback(
  pkg: McpPackageJson,
  installDir: string,
  steps: string[],
  reason: string,
  timeoutMs: number,
): McpPrepareResult {
  const name = pkg.name;
  const version = name ? publishedVersion(name, installDir, timeoutMs) : null;
  if (name && version) {
    return {
      steps,
      launchOverride: { command: "npx", args: ["-y", `${name}@${version}`] },
      note:
        `${reason}, so clients launch the published package ${name}@${version} ` +
        `via npx instead of the pinned source tree.`,
    };
  }
  return {
    steps,
    warning: `${reason}. The server was not wired into any client — build it in ${installDir} and re-run mh install, or wire it by hand.`,
  };
}

function runNpm(
  args: string[],
  cwd: string,
  timeoutMs: number,
): { ok: true } | { ok: false; detail: string } {
  const res = spawnSync(npmBinary(), args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1", NPM_CONFIG_COLOR: "false" },
    shell: process.platform === "win32",
  });
  if (res.error) return { ok: false, detail: res.error.message };
  if (res.status === 0) return { ok: true };
  const out = `${res.stderr ?? ""}\n${res.stdout ?? ""}`.trim();
  const tail = out.split("\n").filter(Boolean).slice(-4).join(" · ");
  return { ok: false, detail: tail || `exit ${res.status}` };
}

export function prepareMcpInstall(
  installDir: string,
  opts: McpPrepareOptions = {},
): McpPrepareResult {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const pkg = readMcpPackageJson(installDir);
  if (!pkg) return { steps: [] };

  const entry = resolveMcpEntry(installDir, pkg);
  const entryExists = entry ? exists(entry) : true;
  const depCount = Object.keys(pkg.dependencies ?? {}).length;
  const devDepCount = Object.keys(pkg.devDependencies ?? {}).length;
  const hasBuild = typeof pkg.scripts?.build === "string";
  const needsBuild = !entryExists && hasBuild;
  const hasNodeModules = exists(path.join(installDir, "node_modules"));
  const needsInstall = !hasNodeModules && (depCount > 0 || (needsBuild && devDepCount > 0));

  const steps: string[] = [];

  if (needsInstall && hasWorkspaceDeps(pkg)) {
    return fallback(
      pkg,
      installDir,
      steps,
      "The pinned source is a monorepo member with workspace: dependencies that npm cannot install on its own",
      timeoutMs,
    );
  }

  if (needsInstall) {
    // A pre-built server only needs its runtime deps; a source tree
    // needs the dev toolchain (tsc etc.) to build.
    const args = ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"];
    if (!needsBuild) args.push("--omit=dev");
    const label = needsBuild
      ? `npm install (${depCount + devDepCount} deps, for build)`
      : `npm install (${depCount} deps)`;
    opts.onStep?.(label);
    const res = runNpm(args, installDir, timeoutMs);
    if (!res.ok) {
      return fallback(pkg, installDir, steps, `npm install failed (${res.detail})`, timeoutMs);
    }
    steps.push(label);
  }

  if (needsBuild) {
    const label = "npm run build";
    opts.onStep?.(label);
    const res = runNpm(["run", "build"], installDir, timeoutMs);
    if (!res.ok) {
      return fallback(pkg, installDir, steps, `npm run build failed (${res.detail})`, timeoutMs);
    }
    steps.push(label);
  }

  if (entry && !exists(entry)) {
    const reason =
      `${path.relative(installDir, entry)} is missing from the source tree` +
      (hasBuild ? " even after npm run build" : " and the package declares no build script");
    return fallback(pkg, installDir, steps, reason, timeoutMs);
  }

  return { steps };
}
