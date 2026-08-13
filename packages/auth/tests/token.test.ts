/**
 * Tests for the persisted-token helpers shared between the CLI and the
 * MCP server. The session token + the small bit of user metadata round
 * trip through `~/.metahub/config.json`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearPersistedToken, persistToken, readPersistedToken } from "../src/token";

let tmpHome: string;
let origHome: string | undefined;
let origUserProfile: string | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
  origUserProfile = process.env.USERPROFILE;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "mh-auth-token-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  process.env.HOME = origHome;
  process.env.USERPROFILE = origUserProfile;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("readPersistedToken", () => {
  it("returns null when no token has been persisted", () => {
    expect(readPersistedToken()).toBeNull();
  });
});

describe("persistToken + readPersistedToken", () => {
  it("round-trips the token through the on-disk config", () => {
    persistToken({ token: "tok_abc", userId: "u_1", userHandle: "alice" });
    const got = readPersistedToken();
    expect(got).not.toBeNull();
    expect(got?.token).toBe("tok_abc");
    expect(got?.userHandle).toBe("alice");
  });

  it("preserves optional expiresAt when provided", () => {
    persistToken({
      token: "tok_xyz",
      userId: "u_1",
      userHandle: "bob",
      expiresAt: 1_700_000_000_000,
    });
    expect(readPersistedToken()?.expiresAt).toBe(1_700_000_000_000);
  });
});

describe("clearPersistedToken", () => {
  it("returns null on a fresh read after clear", () => {
    persistToken({ token: "tok_1", userId: "u", userHandle: "h" });
    clearPersistedToken();
    expect(readPersistedToken()).toBeNull();
  });

  it("does not throw when called without a prior token", () => {
    expect(() => clearPersistedToken()).not.toThrow();
  });
});
