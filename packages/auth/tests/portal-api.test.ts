/**
 * Tests for the auth-only portal client. We mock global fetch and pin
 * each call's URL composition, headers, and error parsing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { currentUser, pollDeviceFlow, resolveBearer, startDeviceFlow } from "../src/portal-api";
import { saveAuthConfig } from "../src/config";

let tmpHome: string;
let origHome: string | undefined;
let origUserProfile: string | undefined;
let origPortal: string | undefined;
let origServiceToken: string | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
  origUserProfile = process.env.USERPROFILE;
  origPortal = process.env.METAHUB_PORTAL_URL;
  origServiceToken = process.env.METAHUB_SERVICE_TOKEN;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "mh-auth-portal-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  delete process.env.METAHUB_SERVICE_TOKEN;
  process.env.METAHUB_PORTAL_URL = "http://portal.test";
  saveAuthConfig({ portalUrl: "http://portal.test", sessionToken: "tok_session" });
});

afterEach(() => {
  process.env.HOME = origHome;
  process.env.USERPROFILE = origUserProfile;
  if (origPortal === undefined) delete process.env.METAHUB_PORTAL_URL;
  else process.env.METAHUB_PORTAL_URL = origPortal;
  if (origServiceToken === undefined) delete process.env.METAHUB_SERVICE_TOKEN;
  else process.env.METAHUB_SERVICE_TOKEN = origServiceToken;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function mockFetch(handler: (input: string, init: RequestInit) => Response | Promise<Response>) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input, init) => Promise.resolve(handler(String(input), init ?? {})));
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

describe("URL + header composition", () => {
  it("startDeviceFlow POSTs to /api/auth/github/start without a bearer", async () => {
    const spy = mockFetch((input, init) => {
      expect(input).toBe("http://portal.test/api/auth/github/start");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
      return jsonResponse({ deviceCode: "d", userCode: "u", verificationUri: "x" });
    });
    await startDeviceFlow();
    expect(spy).toHaveBeenCalledOnce();
  });

  it("pollDeviceFlow sends the deviceCode in the JSON body", async () => {
    const spy = mockFetch((_, init) => {
      expect(typeof init.body).toBe("string");
      expect(JSON.parse(init.body as string)).toEqual({ deviceCode: "device_abc" });
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
      return jsonResponse({ state: "pending" });
    });
    await pollDeviceFlow("device_abc");
    expect(spy).toHaveBeenCalled();
  });

  it("currentUser sets Authorization: Bearer <token>", async () => {
    mockFetch((_, init) => {
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer my_tok");
      return jsonResponse({ user: { id: "u" } });
    });
    await currentUser("my_tok");
  });
});

describe("error handling", () => {
  it("surfaces a structured { error, githubDescription, docsHint } payload", async () => {
    mockFetch(() =>
      jsonResponse(
        {
          error: "GitHub OAuth failed",
          githubDescription: "user denied access",
          docsHint: "https://docs.metahub.dev/auth",
        },
        { status: 400 },
      ),
    );
    await expect(currentUser("tok")).rejects.toThrow(
      /GitHub OAuth failed[\s\S]*user denied access[\s\S]*docs.metahub.dev/,
    );
  });

  it("structured error without githubDescription/docsHint surfaces just the error string", async () => {
    mockFetch(() => jsonResponse({ error: "Plain error message" }, { status: 400 }));
    await expect(currentUser("tok")).rejects.toThrow(/^Plain error message$/);
  });

  it("structured error with only docsHint includes the docs line", async () => {
    mockFetch(() =>
      jsonResponse({ error: "Hint only", docsHint: "https://docs.example/hint" }, { status: 400 }),
    );
    await expect(currentUser("tok")).rejects.toThrow(/Hint only[\s\S]*docs\.example\/hint/);
  });

  it("falls back to an HTTP-status message when the body isn't JSON", async () => {
    mockFetch(() => new Response("not json", { status: 503 }));
    await expect(currentUser("tok")).rejects.toThrow(/HTTP 503/);
  });
});

describe("resolveBearer", () => {
  it("prefers sessionToken when set", () => {
    saveAuthConfig({ sessionToken: "tok_session", serviceToken: undefined });
    expect(resolveBearer()).toBe("tok_session");
  });

  it("falls back to serviceToken when sessionToken is absent", () => {
    saveAuthConfig({ sessionToken: undefined, serviceToken: "tok_service" });
    expect(resolveBearer()).toBe("tok_service");
  });

  it("throws an actionable error when neither token is present", () => {
    saveAuthConfig({ sessionToken: undefined, serviceToken: undefined });
    expect(() => resolveBearer()).toThrow(/mh login.*METAHUB_SERVICE_TOKEN/s);
  });
});
