/**
 * CLI version. Two resolution paths:
 *
 *   1. The standalone bundler (scripts/build-standalone.mjs) inlines
 *      the version via esbuild's `define` as the global
 *      `__METAHUB_CLI_VERSION__`. When that's present we use it
 *      directly — no filesystem lookup needed, no risk of finding
 *      the wrong package.json.
 *
 *   2. The dev / tsc-built layout has no inlined constant; we read
 *      package.json by walking up from this file's location. We try
 *      two candidates so both `dist/lib/version.js` (tsc layout, up
 *      two levels) and any future flat `dist/version.js` (up one
 *      level) resolve correctly.
 *
 * Single source of truth: package.json's `version` field.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The bundler defines this; in non-bundled execution it's undefined
// at runtime and the typeof guard below skips the branch.
declare const __METAHUB_CLI_VERSION__: string | undefined;

let cached: string | null = null;

export function cliVersion(): string {
  if (cached) return cached;
  // Path 1: bundler-injected constant. typeof-guarded so non-bundled
  // execution doesn't throw on the missing global.
  try {
    if (typeof __METAHUB_CLI_VERSION__ === "string" && __METAHUB_CLI_VERSION__.length > 0) {
      cached = __METAHUB_CLI_VERSION__;
      return cached;
    }
  } catch {
    /* not bundled — fall through */
  }
  // Path 2: walk up to find the nearest package.json.
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(here, "..", "..", "package.json"), // dist/lib/version.js
      path.resolve(here, "..", "package.json"), // dist/version.js
    ];
    for (const candidate of candidates) {
      try {
        const raw = fs.readFileSync(candidate, "utf8");
        const pkg = JSON.parse(raw) as { version?: string };
        if (pkg.version) {
          cached = pkg.version;
          return cached;
        }
      } catch {
        /* try next */
      }
    }
  } catch {
    /* fall through */
  }
  cached = "0.0.0";
  return cached;
}
