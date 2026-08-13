/**
 * Tests for the device-code helpers. We mock fetch + redirect HOME so
 * persistence is sandboxed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pollDeviceCode, startDeviceCodeFlow } from "../src/device-code";
import { readPersistedToken } from "../src/token";
import { saveAuthConfig } from "../src/config";

let tmpHome: string;
let origHome: string | undefined;
let origUserProfile: string | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
  origUserProfile = process.env.USERPROFILE;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "mh-auth-dc-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.METAHUB_PORTAL_URL = "http://portal.test";
  saveAuthConfig({ portalUrl: "http://portal.test" });
});

afterEach(() => {
  process.env.HOME = origHome;
  process.env.USERPROFILE = origUserProfile;
  delete process.env.METAHUB_PORTAL_URL;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("startDeviceCodeFlow", () => {
  it("returns the verification URL + user code from the portal", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        deviceCode: "dev_1",
        userCode: "ABC-123",
        verificationUri: "https://github.com/login/device",
        expiresIn: 900,
        interval: 5,
      }),
    );
    const out = await startDeviceCodeFlow();
    expect(out.deviceCode).toBe("dev_1");
    expect(out.userCode).toBe("ABC-123");
    expect(out.verificationUrl).toBe("https://github.com/login/device");
    expect(out.interval).toBe(5);
  });
});

describe("pollDeviceCode", () => {
  it("returns { state: 'pending' } while the portal says pending", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ state: "pending" }));
    const out = await pollDeviceCode("dev_1");
    expect(out.state).toBe("pending");
  });

  it("returns { state: 'pending', interval } when the portal says slow_down", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ state: "slow_down", interval: 10 }),
    );
    const out = await pollDeviceCode("dev_1");
    expect(out.state).toBe("pending");
    if (out.state === "pending") expect(out.interval).toBe(10);
  });

  it("persists the token + returns it on { state: 'complete' }", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        state: "complete",
        token: "tok_session",
        user: { id: "u_1", githubLogin: "alice", githubId: 42 },
      }),
    );
    const out = await pollDeviceCode("dev_1");
    expect(out.state).toBe("complete");
    if (out.state === "complete") {
      expect(out.token.token).toBe("tok_session");
      expect(out.token.userHandle).toBe("alice");
    }
    expect(readPersistedToken()?.token).toBe("tok_session");
  });

  it("returns denied / expired terminal states verbatim", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ state: "denied" }));
    const a = await pollDeviceCode("dev_1");
    expect(a.state).toBe("denied");

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ state: "expired" }));
    const b = await pollDeviceCode("dev_1");
    expect(b.state).toBe("expired");
  });
});
