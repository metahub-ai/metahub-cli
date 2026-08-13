/**
 * Tests for the installer's portal client (catalog reads). Mocks
 * fetch and pins URL composition, headers, and auth handling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getInstallInfo,
  getPublicArtifact,
  listPublicArtifacts,
  searchPublicArtifacts,
} from "../src/portal-api";
import { saveAuthConfig } from "@metahub/auth";

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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "mh-installer-portal-"));
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

describe("URL composition", () => {
  it("getInstallInfo encodes searchParams in the URL", async () => {
    mockFetch((input) => {
      const u = new URL(input);
      expect(u.pathname).toBe("/api/cli/install/skill/pdf");
      expect(u.searchParams.get("host")).toBe("Claude Code");
      expect(u.searchParams.get("platform")).toBe("darwin");
      expect(u.searchParams.get("cliVersion")).toBe("0.1.0");
      return jsonResponse({ installId: "ins" });
    });
    await getInstallInfo("skill", "pdf", {
      host: "Claude Code",
      platform: "darwin",
      cliVersion: "0.1.0",
    });
  });

  it("listPublicArtifacts defaults limit=200 and merges extra params", async () => {
    mockFetch((input) => {
      const u = new URL(input);
      expect(u.searchParams.get("limit")).toBe("200");
      expect(u.searchParams.get("kind")).toBe("skill");
      return jsonResponse({ items: [], nextCursor: null });
    });
    await listPublicArtifacts({ kind: "skill" });
  });

  it("getPublicArtifact targets /api/public/artifacts/<kind>/<slug>", async () => {
    mockFetch((input) => {
      expect(new URL(input).pathname).toBe("/api/public/artifacts/mcp/github");
      return jsonResponse({ artifact: {}, reviewSummary: {} });
    });
    await getPublicArtifact("mcp", "github");
  });

  it("accepts an explicit bearer override", async () => {
    mockFetch((_, init) => {
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer override");
      return jsonResponse({ items: [], nextCursor: null });
    });
    await listPublicArtifacts({}, "override");
  });

  it("searchPublicArtifacts hits /search and forwards q/kind/sort/limit", async () => {
    mockFetch((input) => {
      const u = new URL(input);
      expect(u.pathname).toBe("/api/public/artifacts/search");
      expect(u.searchParams.get("q")).toBe("code review");
      expect(u.searchParams.get("kind")).toBe("skill");
      expect(u.searchParams.get("sort")).toBe("rating");
      expect(u.searchParams.get("limit")).toBe("5");
      return jsonResponse({ items: [], total: 0 });
    });
    const res = await searchPublicArtifacts({
      q: "code review",
      kind: "skill",
      sort: "rating",
      limit: 5,
    });
    expect(res).toEqual({ items: [], total: 0 });
  });

  it("searchPublicArtifacts omits optional params that are unset", async () => {
    mockFetch((input) => {
      const u = new URL(input);
      expect(u.searchParams.get("q")).toBe("git");
      expect(u.searchParams.has("kind")).toBe(false);
      expect(u.searchParams.has("sort")).toBe(false);
      expect(u.searchParams.has("limit")).toBe(false);
      return jsonResponse({ items: [], total: 0 });
    });
    await searchPublicArtifacts({ q: "git" });
  });
});

describe("auth header omission", () => {
  it("omits Authorization when no token is configured and none is passed", async () => {
    // Clear the persisted session token → tryResolveBearer() returns
    // null → optionalBearer() returns undefined → no header sent.
    saveAuthConfig({ portalUrl: "http://portal.test", sessionToken: undefined });
    mockFetch((_, init) => {
      const h = (init.headers ?? {}) as Record<string, string>;
      expect(h.Authorization).toBeUndefined();
      return jsonResponse({ items: [], nextCursor: null });
    });
    await listPublicArtifacts({});
  });

  it("forwards the persisted session token when present", async () => {
    // beforeEach saved sessionToken: "tok_session".
    mockFetch((_, init) => {
      const h = (init.headers ?? {}) as Record<string, string>;
      expect(h.Authorization).toBe("Bearer tok_session");
      return jsonResponse({ items: [], nextCursor: null });
    });
    await listPublicArtifacts({});
  });
});

describe("error handling", () => {
  it("surfaces structured { error } payloads", async () => {
    mockFetch(() =>
      jsonResponse(
        {
          error: "Not found",
          docsHint: "https://docs.metahub.dev/install",
        },
        { status: 404 },
      ),
    );
    await expect(getPublicArtifact("skill", "missing")).rejects.toThrow(
      /Not found[\s\S]*docs\.metahub\.dev/,
    );
  });

  it("falls back to an HTTP-status message when the body isn't JSON", async () => {
    mockFetch(() => new Response("blob", { status: 502 }));
    await expect(getPublicArtifact("skill", "x")).rejects.toThrow(/HTTP 502/);
  });

  it("appends GitHub description and docs hint when the error payload carries them", async () => {
    mockFetch(() =>
      jsonResponse(
        {
          error: "Device flow failed",
          githubError: "authorization_pending",
          githubDescription: "The authorization request is still pending.",
          docsHint: "https://docs.metahub.dev/login",
        },
        { status: 400 },
      ),
    );
    await expect(
      getInstallInfo("mcp", "github", {
        host: "h",
        platform: "p",
        cliVersion: "v",
      }),
    ).rejects.toThrow(/Device flow failed[\s\S]*GitHub: The authorization request[\s\S]*Docs:/);
  });

  it("surfaces a bare { error } with no extra hints", async () => {
    mockFetch(() => jsonResponse({ error: "Plain error" }, { status: 403 }));
    await expect(getPublicArtifact("skill", "x")).rejects.toThrow(/^Plain error$/);
  });
});
