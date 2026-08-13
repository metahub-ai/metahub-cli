/**
 * Tests for the lazy package-version resolver. The CLI sends it as
 * cliVersion on every install + `mh --version` returns it; a broken
 * resolver leaks "0.0.0" to telemetry.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { cliVersion } from "../src/lib/version";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cliVersion", () => {
  it("returns a non-empty string", () => {
    const v = cliVersion();
    expect(typeof v).toBe("string");
    expect(v.length).toBeGreaterThan(0);
  });

  it("caches the resolved value — second call returns the same string", () => {
    expect(cliVersion()).toBe(cliVersion());
  });

  it("falls back to 0.0.0 when the package.json can't be read", async () => {
    vi.resetModules();
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const { cliVersion: fresh } = await import("../src/lib/version");
    expect(fresh()).toBe("0.0.0");
  });

  it("falls back to 0.0.0 when the package.json has no version field", async () => {
    vi.resetModules();
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ name: "x" }));
    const { cliVersion: fresh } = await import("../src/lib/version");
    expect(fresh()).toBe("0.0.0");
  });

  it("uses the bundler-injected __METAHUB_CLI_VERSION__ constant when present", async () => {
    vi.resetModules();
    // Emulate esbuild's `define` by planting the global the bundler
    // would inline. The resolver should short-circuit on it and never
    // touch the filesystem.
    (globalThis as Record<string, unknown>).__METAHUB_CLI_VERSION__ = "9.9.9";
    const readSpy = vi.spyOn(fs, "readFileSync");
    try {
      const { cliVersion: fresh } = await import("../src/lib/version");
      expect(fresh()).toBe("9.9.9");
      // Bundler path resolved without any package.json lookup.
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      delete (globalThis as Record<string, unknown>).__METAHUB_CLI_VERSION__;
    }
  });

  it("ignores an empty bundler constant and falls through to package.json", async () => {
    vi.resetModules();
    (globalThis as Record<string, unknown>).__METAHUB_CLI_VERSION__ = "";
    try {
      const { cliVersion: fresh } = await import("../src/lib/version");
      // Empty string fails the length guard, so the real package.json
      // (a non-empty version) is read instead.
      const v = fresh();
      expect(v).not.toBe("");
      expect(v).not.toBe("9.9.9");
    } finally {
      delete (globalThis as Record<string, unknown>).__METAHUB_CLI_VERSION__;
    }
  });
});
