/**
 * Tests for the whoami tool.
 */
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { whoami } from "../src/tools/whoami";

describe("whoami", () => {
  it("falls back to @metahub/auth's readPersistedToken when no override is given", async () => {
    // Exercise the `?? readPersistedToken` default. A throwaway HOME with
    // no config.json means the real reader returns null → signedIn false.
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "mh-whoami-test-"));
    const ORIGINAL_HOME = process.env.METAHUB_E2E_HOME;
    process.env.METAHUB_E2E_HOME = tmpHome;
    try {
      const result = await whoami();
      expect(result).toEqual({ signedIn: false, userHandle: null, userId: null });
    } finally {
      if (ORIGINAL_HOME === undefined) delete process.env.METAHUB_E2E_HOME;
      else process.env.METAHUB_E2E_HOME = ORIGINAL_HOME;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("returns signedIn=false when no token is on disk", async () => {
    const read = vi.fn(() => null);
    const result = await whoami({ read });
    expect(result).toEqual({ signedIn: false, userHandle: null, userId: null });
  });

  it("returns the cached handle and id without calling the portal", async () => {
    const read = vi.fn(() => ({
      token: "sess_abc",
      userId: "u_1",
      userHandle: "alice",
    }));
    const fetchUser = vi.fn();
    const result = await whoami({ read, fetchUser });
    expect(result).toEqual({ signedIn: true, userHandle: "alice", userId: "u_1" });
    expect(fetchUser).not.toHaveBeenCalled();
  });

  it("falls back to /me when the cached handle is empty", async () => {
    const read = vi.fn(() => ({ token: "sess_abc", userId: "", userHandle: "" }));
    const fetchUser = vi.fn(async () => ({
      user: { id: "u_2", githubLogin: "bob", name: null, avatarUrl: null },
    }));
    const result = await whoami({ read, fetchUser });
    expect(result).toEqual({ signedIn: true, userHandle: "bob", userId: "u_2" });
    expect(fetchUser).toHaveBeenCalledWith("sess_abc");
  });

  it("returns signedIn=true with whatever cached data exists if /me fails", async () => {
    const read = vi.fn(() => ({ token: "sess_abc", userId: "", userHandle: "" }));
    const fetchUser = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await whoami({ read, fetchUser });
    expect(result).toEqual({ signedIn: true, userHandle: null, userId: null });
  });
});
