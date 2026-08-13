/**
 * Tests for the signout tool. Confirms it calls the auth library's
 * clear function and reports success.
 */
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { signout } from "../src/tools/signout";

describe("signout", () => {
  it("calls clearPersistedToken from @metahub/auth and reports cleared=true", () => {
    const clear = vi.fn();
    const result = signout({ clear });
    expect(clear).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ cleared: true });
  });

  it("is idempotent — succeeds even when nothing was on disk", () => {
    const clear = vi.fn();
    signout({ clear });
    signout({ clear });
    expect(clear).toHaveBeenCalledTimes(2);
  });

  it("falls back to @metahub/auth's clearPersistedToken when no override is given", () => {
    // Exercise the `?? clearPersistedToken` default branch. Point HOME at a
    // throwaway temp dir so the real library writes there, never the dev's
    // `~/.metahub/config.json`.
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "mh-signout-test-"));
    const ORIGINAL_HOME = process.env.METAHUB_E2E_HOME;
    process.env.METAHUB_E2E_HOME = tmpHome;
    try {
      const result = signout();
      expect(result).toEqual({ cleared: true });
      // The config file now exists with the token cleared.
      const cfg = JSON.parse(
        fs.readFileSync(path.join(tmpHome, ".metahub", "config.json"), "utf8"),
      );
      expect(cfg.sessionToken).toBeUndefined();
    } finally {
      if (ORIGINAL_HOME === undefined) delete process.env.METAHUB_E2E_HOME;
      else process.env.METAHUB_E2E_HOME = ORIGINAL_HOME;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
