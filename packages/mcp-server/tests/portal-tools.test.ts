/**
 * Unit tests for the three portal-backed publisher tools
 * (`fetchMyArtifacts`, `fetchMyStats`, `submitReview`). We drive each
 * through an injected fetcher so no network is touched, exercising the
 * happy paths plus the defensive branches (missing artifact id → 404,
 * absent `artifacts` array → empty list, window-days search param).
 */
import { describe, expect, it } from "vitest";
import { fetchMyArtifacts, PortalError } from "../src/tools/my-artifacts";
import { fetchMyStats } from "../src/tools/my-stats";
import { submitReview } from "../src/tools/submit-review";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const BASE = "https://portal.test";

describe("fetchMyArtifacts", () => {
  it("maps the portal payload into MyArtifactsItem records", async () => {
    const fetcher = (async () =>
      jsonResponse({
        artifacts: [
          {
            id: "art_pdf",
            kind: "skill",
            slug: "pdf",
            name: "PDF Skill",
            version: "1.0.0",
            publishedAt: "2026-01-01T00:00:00Z",
            visibility: "public",
          },
        ],
      })) as unknown as typeof fetch;
    const out = await fetchMyArtifacts({ bearer: "sess_x", baseUrl: BASE, fetcher });
    expect(out.artifacts).toHaveLength(1);
    expect(out.artifacts[0]).toMatchObject({ id: "art_pdf", slug: "pdf", version: "1.0.0" });
  });

  it("returns an empty list when the portal omits the artifacts array", async () => {
    // Covers the `res.artifacts ?? []` fallback when the field is absent.
    const fetcher = (async () => jsonResponse({})) as unknown as typeof fetch;
    const out = await fetchMyArtifacts({ bearer: "sess_x", baseUrl: BASE, fetcher });
    expect(out.artifacts).toEqual([]);
  });
});

describe("fetchMyStats", () => {
  it("looks up the artifact id then fetches observability with the windowDays param", async () => {
    const seenUrls: string[] = [];
    const fetcher = (async (url: string) => {
      seenUrls.push(url);
      if (seenUrls.length === 1) return jsonResponse({ artifact: { id: "art_pdf" } });
      return jsonResponse({ windowDays: 7, totals: { invocations: 3 } });
    }) as unknown as typeof fetch;
    const stats = await fetchMyStats(
      { kind: "skill", slug: "pdf", windowDays: 7 },
      { bearer: "sess_x", baseUrl: BASE, fetcher },
    );
    expect(stats.windowDays).toBe(7);
    // The second call must carry the windowDays search param.
    expect(seenUrls[0]).toContain("/api/public/artifacts/skill/pdf");
    expect(new URL(seenUrls[1]!).searchParams.get("windowDays")).toBe("7");
  });

  it("throws a 404 PortalError when the artifact lookup has no id", async () => {
    const fetcher = (async () => jsonResponse({ artifact: {} })) as unknown as typeof fetch;
    const err = await fetchMyStats(
      { kind: "skill", slug: "ghost" },
      { bearer: "sess_x", baseUrl: BASE, fetcher },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(PortalError);
    expect((err as PortalError).status).toBe(404);
    expect((err as PortalError).message).toMatch(/No artifact found for kind=skill slug=ghost/);
  });
});

describe("submitReview", () => {
  it("resolves the artifact id then POSTs the review and returns it", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (calls.length === 1) return jsonResponse({ artifact: { id: "art_pdf" } });
      return jsonResponse({
        ok: true,
        review: {
          id: "rev_1",
          artifactId: "art_pdf",
          rating: 5,
          title: "Nice",
          body: "great skill",
          authorName: "Alice",
          authorHandle: "alice",
          verifiedUser: true,
          createdMs: 1,
        },
      });
    }) as unknown as typeof fetch;
    const review = await submitReview(
      { kind: "skill", slug: "pdf", rating: 5, body: "great skill", title: "Nice" },
      { bearer: "sess_x", baseUrl: BASE, fetcher },
    );
    expect(review.id).toBe("rev_1");
    // Second call is the POST and includes the title we supplied.
    expect(calls[1]!.init.method).toBe("POST");
    const sent = JSON.parse(calls[1]!.init.body as string) as Record<string, unknown>;
    expect(sent).toMatchObject({
      artifactId: "art_pdf",
      rating: 5,
      body: "great skill",
      title: "Nice",
    });
  });

  it("omits the title field from the POST body when none is supplied", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (calls.length === 1) return jsonResponse({ artifact: { id: "art_pdf" } });
      return jsonResponse({
        ok: true,
        review: {
          id: "rev_2",
          artifactId: "art_pdf",
          rating: 4,
          title: null,
          body: "solid",
          authorName: "Bob",
          authorHandle: null,
          verifiedUser: true,
          createdMs: 2,
        },
      });
    }) as unknown as typeof fetch;
    await submitReview(
      { kind: "skill", slug: "pdf", rating: 4, body: "solid" },
      { bearer: "sess_x", baseUrl: BASE, fetcher },
    );
    const sent = JSON.parse(calls[1]!.init.body as string) as Record<string, unknown>;
    expect("title" in sent).toBe(false);
  });

  it("throws a 404 PortalError when the artifact lookup has no id", async () => {
    const fetcher = (async () => jsonResponse({ artifact: {} })) as unknown as typeof fetch;
    const err = await submitReview(
      { kind: "skill", slug: "ghost", rating: 5, body: "great" },
      { bearer: "sess_x", baseUrl: BASE, fetcher },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(PortalError);
    expect((err as PortalError).status).toBe(404);
  });
});
