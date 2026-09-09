/**
 * Tests for the MCP preparation step: a freshly extracted server tree
 * gets `npm install` (lifecycle scripts off) and `npm run build` when
 * that is what it takes to make the declared entry point exist.
 *
 * `npm` is replaced by a shell stub via METAHUB_NPM_BIN that records
 * its argv and, on `run build`, creates the entry file — so the tests
 * assert the exact commands without touching the network.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareMcpInstall, resolveMcpEntry } from "../src/mcp-build.js";

const posix = process.platform !== "win32";
let tmp: string;
let log: string;

function stubNpm(opts: { failOn?: string; buildCreates?: string } = {}): void {
  const bin = path.join(tmp, "npm");
  const lines = ["#!/bin/sh", `printf '%s\\n' "$*" >> "${log}"`];
  if (opts.failOn)
    lines.push(`case "$*" in *"${opts.failOn}"*) echo 'stub failure' >&2; exit 1;; esac`);
  if (opts.buildCreates) {
    lines.push(
      `case "$*" in "run build"*) mkdir -p "$(dirname "${opts.buildCreates}")"; echo ok > "${opts.buildCreates}";; esac`,
    );
  }
  lines.push('case "$*" in install*) mkdir -p node_modules;; esac', "exit 0");
  fs.writeFileSync(bin, lines.join("\n") + "\n", { mode: 0o755 });
  process.env.METAHUB_NPM_BIN = bin;
}

function server(files: Record<string, string>): string {
  const dir = path.join(tmp, "srv");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
}

function calls(): string[] {
  return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-mcp-build-"));
  log = path.join(tmp, "npm.log");
});

afterEach(() => {
  delete process.env.METAHUB_NPM_BIN;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("resolveMcpEntry", () => {
  it("prefers bin, then main, else null", () => {
    expect(resolveMcpEntry("/d", { bin: "cli.js", main: "x.js" })).toBe(path.join("/d", "cli.js"));
    expect(resolveMcpEntry("/d", { bin: { a: "a.js", b: "b.js" } })).toBe(path.join("/d", "a.js"));
    expect(resolveMcpEntry("/d", { main: "lib/index.js" })).toBe(path.join("/d", "lib/index.js"));
    expect(resolveMcpEntry("/d", { scripts: { start: "node x" } })).toBeNull();
    expect(resolveMcpEntry("/d", null)).toBeNull();
  });
});

describe("prepareMcpInstall", () => {
  it("does nothing for a tree without package.json", () => {
    stubNpm();
    const dir = server({ "server.py": "" });
    expect(prepareMcpInstall(dir)).toEqual({ steps: [] });
    expect(calls()).toEqual([]);
  });

  it("does nothing when the entry exists and there are no dependencies", () => {
    stubNpm();
    const dir = server({
      "package.json": JSON.stringify({ bin: "dist/index.js" }),
      "dist/index.js": "",
    });
    expect(prepareMcpInstall(dir)).toEqual({ steps: [] });
    expect(calls()).toEqual([]);
  });

  it("installs runtime deps only for a pre-built server", () => {
    if (!posix) return;
    stubNpm();
    const dir = server({
      "package.json": JSON.stringify({ bin: "dist/index.js", dependencies: { zod: "^3" } }),
      "dist/index.js": "",
    });
    const res = prepareMcpInstall(dir);
    expect(res.warning).toBeUndefined();
    expect(res.steps).toEqual(["npm install (1 deps)"]);
    expect(calls()).toEqual([
      "install --ignore-scripts --no-audit --no-fund --loglevel=error --omit=dev",
    ]);
  });

  it("installs dev deps and builds a source tree, then confirms the entry exists", () => {
    if (!posix) return;
    const dir = path.join(tmp, "srv");
    stubNpm({ buildCreates: path.join(dir, "dist", "index.js") });
    const steps: string[] = [];
    server({
      "package.json": JSON.stringify({
        bin: { "pare-github": "./dist/index.js" },
        scripts: { build: "tsc" },
        dependencies: { zod: "^3" },
        devDependencies: { typescript: "^5" },
      }),
      "src/index.ts": "",
    });
    const res = prepareMcpInstall(dir, { onStep: (s) => steps.push(s) });
    expect(res.warning).toBeUndefined();
    expect(res.steps).toEqual(["npm install (2 deps, for build)", "npm run build"]);
    expect(steps).toEqual(res.steps);
    expect(calls()).toEqual([
      "install --ignore-scripts --no-audit --no-fund --loglevel=error",
      "run build",
    ]);
    expect(fs.existsSync(path.join(dir, "dist", "index.js"))).toBe(true);
  });

  it("skips npm install when node_modules is already present", () => {
    if (!posix) return;
    const dir = path.join(tmp, "srv");
    stubNpm({ buildCreates: path.join(dir, "dist", "index.js") });
    server({
      "package.json": JSON.stringify({ main: "dist/index.js", scripts: { build: "tsc" } }),
      "node_modules/.keep": "",
    });
    const res = prepareMcpInstall(dir);
    expect(res.steps).toEqual(["npm run build"]);
    expect(calls()).toEqual(["run build"]);
  });

  it("reports a warning and stops when npm install fails", () => {
    if (!posix) return;
    stubNpm({ failOn: "install" });
    const dir = server({
      "package.json": JSON.stringify({
        main: "dist/index.js",
        scripts: { build: "tsc" },
        dependencies: { a: "1" },
      }),
    });
    const res = prepareMcpInstall(dir);
    expect(res.steps).toEqual([]);
    expect(res.warning).toMatch(/npm install failed/);
    expect(res.warning).toMatch(/stub failure/);
    expect(calls()).toHaveLength(1);
  });

  it("warns when the build ran but the entry point is still missing", () => {
    if (!posix) return;
    stubNpm(); // build creates nothing
    const dir = server({
      "package.json": JSON.stringify({ bin: "dist/index.js", scripts: { build: "tsc" } }),
    });
    const res = prepareMcpInstall(dir);
    expect(res.steps).toEqual(["npm run build"]);
    expect(res.warning).toMatch(/dist\/index\.js is missing/);
    expect(res.warning).toMatch(/even after npm run build/);
  });

  it("warns when the entry is missing and there is no build script", () => {
    stubNpm();
    const dir = server({ "package.json": JSON.stringify({ bin: "dist/index.js" }) });
    const res = prepareMcpInstall(dir);
    expect(res.steps).toEqual([]);
    expect(res.warning).toMatch(/declares no build script/);
    expect(calls()).toEqual([]);
  });
});

describe("prepareMcpInstall — published-package fallback", () => {
  function stubNpmWithView(opts: { version?: string; failInstall?: boolean }): void {
    const bin = path.join(tmp, "npm");
    const lines = ["#!/bin/sh", `printf '%s\\n' "$*" >> "${log}"`];
    if (opts.version) lines.push(`case "$*" in view*) echo '"${opts.version}"'; exit 0;; esac`);
    else lines.push(`case "$*" in view*) echo 'npm error 404' >&2; exit 1;; esac`);
    if (opts.failInstall) lines.push(`case "$*" in install*) echo 'boom' >&2; exit 1;; esac`);
    lines.push("exit 0");
    fs.writeFileSync(bin, lines.join("\n") + "\n", { mode: 0o755 });
    process.env.METAHUB_NPM_BIN = bin;
  }

  it("skips npm install for a workspace member and launches the published package", () => {
    if (!posix) return;
    stubNpmWithView({ version: "2.3.1" });
    const dir = server({
      "package.json": JSON.stringify({
        name: "@paretools/github",
        bin: { "pare-github": "./dist/index.js" },
        scripts: { build: "tsc" },
        dependencies: { "@paretools/core": "workspace:*", zod: "^3" },
      }),
      "src/index.ts": "",
    });
    const res = prepareMcpInstall(dir);
    expect(res.warning).toBeUndefined();
    expect(res.steps).toEqual([]);
    expect(res.launchOverride).toEqual({ command: "npx", args: ["-y", "@paretools/github@2.3.1"] });
    expect(res.note).toMatch(/workspace: dependencies/);
    expect(res.note).toMatch(/@paretools\/github@2\.3\.1/);
    // No install was attempted; only the registry lookup ran.
    expect(calls()).toEqual(["view @paretools/github version --json"]);
  });

  it("falls back to the published package when the build fails", () => {
    if (!posix) return;
    stubNpmWithView({ version: "1.0.0", failInstall: true });
    const dir = server({
      "package.json": JSON.stringify({
        name: "some-server",
        main: "dist/index.js",
        scripts: { build: "tsc" },
        dependencies: { zod: "^3" },
      }),
    });
    const res = prepareMcpInstall(dir);
    expect(res.launchOverride).toEqual({ command: "npx", args: ["-y", "some-server@1.0.0"] });
    expect(res.note).toMatch(/npm install failed/);
    expect(res.warning).toBeUndefined();
  });

  it("warns, without an override, when the package is not on npm either", () => {
    if (!posix) return;
    stubNpmWithView({ failInstall: true });
    const dir = server({
      "package.json": JSON.stringify({
        name: "private-thing",
        main: "dist/index.js",
        scripts: { build: "tsc" },
        dependencies: { zod: "^3" },
      }),
    });
    const res = prepareMcpInstall(dir);
    expect(res.launchOverride).toBeUndefined();
    expect(res.warning).toMatch(/npm install failed/);
    expect(res.warning).toMatch(/not wired into any client/);
  });
});
