/**
 * Unit tests for the metahub_search tool helper. Exercises the portal-primary
 * path (with the installCount-is-real-installs fix) and the degraded
 * baked-registry fallback that ranks with the shared engine.
 */
import { describe, expect, it, vi } from "vitest";
import type { SearchArtifactsResponse } from "@metahub/shared";
import { searchItems } from "../src/tools/search";
import type { Registry, RegistryItem } from "../src/types";

function ranked(over: Record<string, unknown> = {}) {
  return {
    kind: "skill",
    slug: "pdf",
    name: "PDF",
    displayName: null,
    tagline: "Read PDFs",
    description: "long",
    repoUrl: "https://github.com/o/pdf",
    bayesRating: 4.6,
    avgRating: 4.8,
    installCount: 7,
    githubStars: 999,
    rank: 1,
    relevanceTier: 1,
    why: ["top-pick", "exact-match"],
    ...over,
  };
}

function regItem(over: Partial<RegistryItem> = {}): RegistryItem {
  return {
    slug: "pdf",
    kind: "skill",
    name: "PDF",
    tagline: "Read PDFs",
    description: "long",
    tags: [],
    author: { handle: "o", name: "O" },
    source: { type: "github", url: "https://github.com/o/pdf" },
    updatedAt: "2026-01-01T00:00:00.000Z",
    popularity: 12,
    ratingSummary: { avg: 4.2, count: 3, distribution: [] },
    ...over,
  } as RegistryItem;
}

function registry(items: RegistryItem[]): Registry {
  return {
    items,
    generatedAt: "2026-01-01T00:00:00.000Z",
    counts: { skill: items.length, mcp: 0, agent: 0, plugin: 0 },
  };
}

describe("searchItems — portal path", () => {
  it("maps the ranked portal response and uses REAL installCount (not GitHub stars)", async () => {
    const searcher = vi.fn(
      async (): Promise<SearchArtifactsResponse> =>
        ({ items: [ranked()], total: 1 }) as unknown as SearchArtifactsResponse,
    );
    const res = await searchItems({ query: "pdf", kind: "skill", limit: 5 }, { searcher });
    expect(searcher).toHaveBeenCalledWith({ q: "pdf", kind: "skill", limit: 5 });
    expect(res.degraded).toBe(false);
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0]).toMatchObject({
      slug: "pdf",
      installCount: 7, // real installs, NOT githubStars (999)
      rating: 4.6, // bayesRating preferred over avgRating
      rank: 1,
      repoUrl: "https://github.com/o/pdf",
    });
  });

  it("falls back name→displayName, rating→avgRating, rank→index, installCount→0", async () => {
    const searcher = vi.fn(
      async (): Promise<SearchArtifactsResponse> =>
        ({
          items: [
            ranked({
              slug: "a",
              displayName: "Display A",
              bayesRating: null,
              avgRating: 3.9,
              rank: undefined,
              installCount: undefined,
            }),
          ],
          total: 1,
        }) as unknown as SearchArtifactsResponse,
    );
    const res = await searchItems({ query: "a" }, { searcher });
    expect(res.hits[0]).toMatchObject({ name: "Display A", rating: 3.9, rank: 1, installCount: 0 });
  });

  it("passes through the server's degraded flag", async () => {
    const searcher = vi.fn(
      async (): Promise<SearchArtifactsResponse> =>
        ({ items: [], total: 0, degraded: true }) as unknown as SearchArtifactsResponse,
    );
    const res = await searchItems({ query: "x" }, { searcher });
    expect(res.degraded).toBe(true);
    expect(res.hits).toHaveLength(0);
  });

  it("rating is null when neither bayes nor avg rating is present", async () => {
    const searcher = vi.fn(
      async (): Promise<SearchArtifactsResponse> =>
        ({
          items: [ranked({ bayesRating: null, avgRating: null })],
          total: 1,
        }) as unknown as SearchArtifactsResponse,
    );
    const res = await searchItems({ query: "pdf" }, { searcher });
    expect(res.hits[0]!.rating).toBeNull();
  });
});

describe("searchItems — degraded fallback over baked registry", () => {
  it("ranks the baked catalog when the portal throws and flags degraded", async () => {
    const searcher = vi.fn(async () => {
      throw new Error("portal down");
    });
    const registryLoader = vi.fn(async () =>
      registry([
        regItem({ slug: "pdf", name: "PDF", popularity: 5 }),
        regItem({ slug: "html", name: "HTML", tagline: "not a match", popularity: 999 }),
        // prefix match with NO rating / updatedAt / popularity — exercises the null fallbacks
        regItem({
          slug: "pdfkit",
          name: "pdfkit",
          ratingSummary: undefined,
          updatedAt: undefined as unknown as string,
          popularity: undefined,
        }),
      ]),
    );
    const res = await searchItems({ query: "pdf", limit: 10 }, { searcher, registryLoader });
    expect(searcher).toHaveBeenCalledOnce();
    expect(registryLoader).toHaveBeenCalledOnce();
    expect(res.degraded).toBe(true);
    // "pdf" exact (tier 1) then "pdfkit" prefix (tier 2); "html" doesn't match → excluded.
    expect(res.hits.map((h) => h.slug)).toEqual(["pdf", "pdfkit"]);
    expect(res.hits[0]!.installCount).toBe(0); // baked catalog carries no real installs
    expect(res.hits[0]!.rating).toBe(4.2);
  });

  it("honors the kind filter in the fallback", async () => {
    const searcher = vi.fn(async () => {
      throw new Error("down");
    });
    const registryLoader = vi.fn(async () =>
      registry([
        regItem({ slug: "review", kind: "skill", name: "review" }),
        regItem({ slug: "review", kind: "mcp", name: "review" }),
      ]),
    );
    const res = await searchItems({ query: "review", kind: "mcp" }, { searcher, registryLoader });
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0]!.kind).toBe("mcp");
  });
});
