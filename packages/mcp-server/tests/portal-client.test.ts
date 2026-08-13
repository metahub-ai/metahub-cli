/**
 * Tests for the authenticated portal fetch helper. We inject a mock
 * fetcher (no network) and assert URL construction, header shaping,
 * search-param handling, and the error mapping into {@link PortalError}.
 * Default-base-URL resolution is exercised by setting
 * `METAHUB_PORTAL_URL` so `loadAuthConfig()` returns a deterministic
 * value without touching the dev's real `~/.metahub/config.json`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAuthConfig } from "@metahub/auth";
import { callPortal, PortalError } from "../src/lib/portal-client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("callPortal", () => {
  const ORIGINAL_HOME = process.env.METAHUB_E2E_HOME;
  let tmpHome: string;

  beforeEach(() => {
    // Point auth-config resolution at an empty temp HOME so it can't pick
    // up the dev's real `~/.metahub/config.json`; loadAuthConfig() then
    // returns its built-in defaults deterministically.
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "mh-portal-test-"));
    process.env.METAHUB_E2E_HOME = tmpHome;
  });

  afterEach(() => {
    if (ORIGINAL_HOME === undefined) delete process.env.METAHUB_E2E_HOME;
    else process.env.METAHUB_E2E_HOME = ORIGINAL_HOME;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("falls back to the auth-config portal URL when no baseUrl is passed", async () => {
    // No `baseUrl` → defaultPortalUrl() reads loadAuthConfig().portalUrl.
    // No network: the fetcher is a stub. We assert against whatever the
    // auth library resolves so the test tracks real default behaviour.
    const expectedBase = loadAuthConfig().portalUrl;
    let seenUrl = "";
    const fetcher = (async (url: string) => {
      seenUrl = url;
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;
    const out = await callPortal<{ ok: boolean }>("/api/thing", { bearer: "sess_x", fetcher });
    expect(out.ok).toBe(true);
    const base = expectedBase.endsWith("/") ? expectedBase : expectedBase + "/";
    expect(seenUrl).toBe(new URL("/api/thing", base).toString());
  });

  it("appends a trailing slash to the base before resolving the path", async () => {
    let seenUrl = "";
    const fetcher = (async (url: string) => {
      seenUrl = url;
      return jsonResponse({});
    }) as unknown as typeof fetch;
    await callPortal("/api/thing", {
      bearer: "sess_x",
      // No trailing slash — the helper must add one so the path is
      // appended rather than replacing the last segment.
      baseUrl: "https://portal.test",
      fetcher,
    });
    expect(seenUrl).toBe("https://portal.test/api/thing");
  });

  it("serialises defined search params and skips undefined ones", async () => {
    let seenUrl = "";
    const fetcher = (async (url: string) => {
      seenUrl = url;
      return jsonResponse({});
    }) as unknown as typeof fetch;
    await callPortal("/api/obs", {
      bearer: "sess_x",
      baseUrl: "https://portal.test",
      fetcher,
      searchParams: { windowDays: 30, cursor: undefined, q: "abc" },
    });
    const parsed = new URL(seenUrl);
    expect(parsed.searchParams.get("windowDays")).toBe("30");
    expect(parsed.searchParams.get("q")).toBe("abc");
    // `undefined` values are dropped, not stringified to "undefined".
    expect(parsed.searchParams.has("cursor")).toBe(false);
  });

  it("sends the Authorization bearer and a JSON body for writes", async () => {
    let seenInit: RequestInit | undefined;
    const fetcher = (async (_url: string, init: RequestInit) => {
      seenInit = init;
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;
    await callPortal("/api/reviews", {
      bearer: "sess_secret",
      baseUrl: "https://portal.test",
      fetcher,
      method: "POST",
      body: { rating: 5 },
    });
    const headers = seenInit!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sess_secret");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(seenInit!.method).toBe("POST");
    expect(seenInit!.body).toBe(JSON.stringify({ rating: 5 }));
  });

  it("wraps a network failure in a PortalError with status 0", async () => {
    const fetcher = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(
      callPortal("/api/thing", { bearer: "sess_x", baseUrl: "https://portal.test", fetcher }),
    ).rejects.toMatchObject({ status: 0 });
    await expect(
      callPortal("/api/thing", { bearer: "sess_x", baseUrl: "https://portal.test", fetcher }),
    ).rejects.toThrow(/Could not reach portal at https:\/\/portal\.test: ECONNREFUSED/);
  });

  it("maps a structured 4xx error body to PortalError with its message", async () => {
    const fetcher = (async () =>
      jsonResponse({ error: "forbidden" }, 403)) as unknown as typeof fetch;
    const err = await callPortal("/api/thing", {
      bearer: "sess_x",
      baseUrl: "https://portal.test",
      fetcher,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(PortalError);
    expect((err as PortalError).status).toBe(403);
    expect((err as PortalError).message).toBe("forbidden");
  });

  it("falls back to the raw text when the error body is not JSON", async () => {
    const fetcher = (async () =>
      new Response("plain text boom", { status: 500 })) as unknown as typeof fetch;
    const err = await callPortal("/api/thing", {
      bearer: "sess_x",
      baseUrl: "https://portal.test",
      fetcher,
    }).catch((e) => e);
    expect((err as PortalError).status).toBe(500);
    expect((err as PortalError).message).toBe("plain text boom");
  });

  it("falls back to statusText when the error body is empty", async () => {
    const fetcher = (async () =>
      new Response("", { status: 404, statusText: "Not Found" })) as unknown as typeof fetch;
    const err = await callPortal("/api/thing", {
      bearer: "sess_x",
      baseUrl: "https://portal.test",
      fetcher,
    }).catch((e) => e);
    expect((err as PortalError).status).toBe(404);
    expect((err as PortalError).message).toBe("Not Found");
  });
});
