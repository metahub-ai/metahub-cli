/**
 * Regression tests for the catalog source migration.
 *
 * `metahub_get` and `metahub://catalog` used to read a baked
 * `registry.json` whose compiled-in default URL 404s in production —
 * the registry app builds that file as a private build input and has
 * never served it over HTTP. Both tools therefore failed for every
 * caller, and `metahub_search`'s degraded fallback was silently dead
 * for the same reason.
 *
 * Every test here pins one half of the fix: the portal is the primary
 * catalog source, and the baked snapshot is a strictly optional
 * fallback that must not be assumed to exist.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { registryUrl } from "../src/env";
import {
  fallbackAvailable,
  hasRegistryConfigured,
  NoRegistryConfiguredError,
  fetchRegistry,
  clearRegistryCache,
} from "../src/registry-client";
import { fetchArtifact } from "../src/tools/get";
import { fetchCatalog } from "../src/tools/catalog";
import { searchItems } from "../src/tools/search";
import type { RegistryItem } from "../src/types";

const ORIGINAL_ENV = process.env.METAHUB_REGISTRY_URL;
afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.METAHUB_REGISTRY_URL;
  else process.env.METAHUB_REGISTRY_URL = ORIGINAL_ENV;
  clearRegistryCache();
});

function regItem(over: Partial<RegistryItem> = {}): RegistryItem {
  return {
    slug: "pdf",
    kind: "skill",
    name: "PDF",
    tagline: "Read PDFs",
    description: "d",
    tags: [],
    author: { handle: "a", name: "A" },
    source: { type: "github", url: "https://github.com/a/pdf" },
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("registry URL is opt-in, never a compiled-in 404", () => {
  it("defaults to null rather than an unserved registry.json URL", () => {
    delete process.env.METAHUB_REGISTRY_URL;
    expect(registryUrl()).toBeNull();
    expect(hasRegistryConfigured()).toBe(false);
  });

  it("honours METAHUB_REGISTRY_URL when a self-hoster sets one", () => {
    process.env.METAHUB_REGISTRY_URL = "https://self.example/registry.json";
    expect(registryUrl()).toBe("https://self.example/registry.json");
    expect(hasRegistryConfigured()).toBe(true);
  });

  it("treats an empty string as unset", () => {
    process.env.METAHUB_REGISTRY_URL = "";
    expect(registryUrl()).toBeNull();
  });

  it("fetchRegistry refuses to guess a URL when none is configured", async () => {
    delete process.env.METAHUB_REGISTRY_URL;
    await expect(fetchRegistry()).rejects.toBeInstanceOf(NoRegistryConfiguredError);
  });
});

describe("the legacy bootstrapped registry value is ignored", () => {
  // Older `mh bootstrap` baked METAHUB_REGISTRY_URL=https://registry.metahub.ai
  // into every wired client. That is the registry *website* root — it serves
  // HTML, so honouring it makes the degraded fallback fail with "not valid
  // JSON" instead of surfacing the portal's real error. Configs already on
  // disk are only rewritten by `mh bootstrap --force`, so the server has to
  // ignore the value itself for existing installs to heal.
  it("treats the website root as unconfigured", () => {
    process.env.METAHUB_REGISTRY_URL = "https://registry.metahub.ai";
    expect(registryUrl()).toBeNull();
    expect(hasRegistryConfigured()).toBe(false);
  });

  it("ignores it with a trailing slash or surrounding whitespace too", () => {
    process.env.METAHUB_REGISTRY_URL = "  https://registry.metahub.ai/  ";
    expect(registryUrl()).toBeNull();
  });

  it("still honours a genuine self-hosted snapshot URL", () => {
    process.env.METAHUB_REGISTRY_URL = "https://registry.metahub.ai/my-snapshot.json";
    expect(registryUrl()).toBe("https://registry.metahub.ai/my-snapshot.json");
  });
});

describe("fallbackAvailable", () => {
  it("is false with no env and no injected loader", () => {
    delete process.env.METAHUB_REGISTRY_URL;
    expect(fallbackAvailable({})).toBe(false);
  });
  it("is true when a loader is injected", () => {
    delete process.env.METAHUB_REGISTRY_URL;
    expect(fallbackAvailable({ registryLoader: () => Promise.resolve({}) })).toBe(true);
  });
  it("lets an explicit registryConfigured override an injected loader", () => {
    expect(
      fallbackAvailable({
        registryLoader: () => Promise.resolve({}),
        registryConfigured: () => false,
      }),
    ).toBe(false);
  });
});

describe("metahub_get reads the portal first", () => {
  it("returns the portal record, with the review summary folded in", async () => {
    const portalGet = vi.fn(async () => ({
      artifact: { id: "art_1", kind: "skill", slug: "pdf", name: "PDF", readme: "# hi" },
      reviewSummary: { avg: 4.5, count: 3 },
    }));
    const res = await fetchArtifact(
      { kind: "skill", slug: "pdf" },
      { portalGet: portalGet as never },
    );
    expect(portalGet).toHaveBeenCalledWith("skill", "pdf");
    expect(res.degraded).toBe(false);
    expect(res.artifact).toMatchObject({ slug: "pdf", readme: "# hi" });
    expect(res.artifact?.reviewSummary).toEqual({ avg: 4.5, count: 3 });
  });

  it("does NOT fall back to a stale snapshot on a portal 404", async () => {
    // A deleted / unpublished artifact must read as absent, not resolve
    // from whatever the baked catalog happened to remember.
    const registryLoader = vi.fn(async () => ({ items: [regItem()] }));
    const res = await fetchArtifact(
      { kind: "skill", slug: "pdf" },
      {
        portalGet: (async () => {
          throw new Error("HTTP 404 on /api/public/artifacts/skill/pdf: not found");
        }) as never,
        registryLoader,
      },
    );
    expect(res.artifact).toBeNull();
    expect(registryLoader).not.toHaveBeenCalled();
  });

  it("degrades to the baked snapshot when the portal is genuinely down", async () => {
    const res = await fetchArtifact(
      { kind: "skill", slug: "pdf" },
      {
        portalGet: (async () => {
          throw new Error("HTTP 503: upstream unavailable");
        }) as never,
        registryLoader: async () => ({ items: [regItem()] }),
      },
    );
    expect(res.degraded).toBe(true);
    expect(res.artifact).toMatchObject({ slug: "pdf" });
  });

  it("re-raises the portal error when no snapshot is configured", async () => {
    delete process.env.METAHUB_REGISTRY_URL;
    await expect(
      fetchArtifact(
        { kind: "skill", slug: "pdf" },
        {
          portalGet: (async () => {
            throw new Error("HTTP 503: upstream unavailable");
          }) as never,
        },
      ),
    ).rejects.toThrow(/503/);
  });
});

describe("metahub://catalog reads the portal", () => {
  it("projects away readme/behavioralSummary — 91% of the raw payload", async () => {
    const portalList = vi.fn(async () => ({
      items: [
        {
          kind: "skill",
          slug: "pdf",
          displayName: "PDF",
          tagline: "Read PDFs",
          description: "d",
          readme: "#".repeat(50_000),
          behavioralSummary: "b".repeat(20_000),
          latestEval: { huge: "x".repeat(5_000) },
          repoUrl: "https://github.com/a/pdf",
          installCount: 7,
        },
      ],
      nextCursor: null,
    }));
    const res = await fetchCatalog({ portalList: portalList as never });
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain("readme");
    expect(serialized).not.toContain("behavioralSummary");
    expect(serialized).not.toContain("latestEval");
    expect(serialized.length).toBeLessThan(2000);
    expect(res.items[0]).toMatchObject({ slug: "pdf", name: "PDF", installCount: 7 });
  });

  it("asks the portal for the lean projection, not the full record", async () => {
    // The full projection is 4.9 MB / 8.1s and sets no cache headers;
    // `fields=lean` is 73 KB / 0.43s. Projecting client-side would have
    // left the wire and portal cost — and the near-timeout — untouched.
    const portalList = vi.fn(async () => ({ items: [{ kind: "skill" }], nextCursor: null }));
    await fetchCatalog({ portalList: portalList as never });
    expect(portalList.mock.calls[0]?.[0]).toMatchObject({ fields: "lean" });
  });

  it("maps the lean shape's shortDescription", async () => {
    const portalList = vi.fn(async () => ({
      items: [{ kind: "skill", slug: "a", shortDescription: "lean copy" }],
      nextCursor: null,
    }));
    const res = await fetchCatalog({ portalList: portalList as never });
    expect(res.items[0]?.description).toBe("lean copy");
  });

  it("stops at the item ceiling and flags truncation", async () => {
    const portalList = vi.fn(async () => ({
      items: Array.from({ length: 200 }, () => ({ kind: "skill" })),
      nextCursor: "more",
    }));
    const res = await fetchCatalog({ portalList: portalList as never, maxItems: 250 });
    expect(res.truncated).toBe(true);
    expect(res.note).toMatch(/metahub_search/);
    expect(res.note).toMatch(/page only/);
    expect(res.items).toHaveLength(250);
  });

  it("follows nextCursor until the ceiling or the end", async () => {
    const portalList = vi
      .fn()
      .mockResolvedValueOnce({ items: [{ kind: "skill" }], nextCursor: "c1" })
      .mockResolvedValueOnce({ items: [{ kind: "mcp" }], nextCursor: null });
    const res = await fetchCatalog({ portalList: portalList as never });
    expect(portalList).toHaveBeenCalledTimes(2);
    expect(portalList.mock.calls[1]?.[0]).toMatchObject({ cursor: "c1", fields: "lean" });
    expect(res.pageCounts).toEqual({ skill: 1, mcp: 1, agent: 0, plugin: 0 });
    expect(res.truncated).toBe(false);
  });

  it("reads the baked RegistryItem spelling on the degraded path", async () => {
    // A snapshot spells these differently from the portal. Reading only
    // the portal names would blank out repoUrl/rating for self-hosters.
    const res = await fetchCatalog({
      portalList: (async () => {
        throw new Error("portal down");
      }) as never,
      registryLoader: async () => ({
        items: [regItem({ ratingSummary: { avg: 4.25, count: 2, distribution: [] } })],
        generatedAt: "2026-01-01T00:00:00Z",
        counts: { skill: 1, mcp: 0, agent: 0, plugin: 0 },
      }),
    });
    expect(res.degraded).toBe(true);
    expect(res.items[0]?.repoUrl).toBe("https://github.com/a/pdf");
    expect(res.items[0]?.rating).toBe(4.25);
    expect(res.items[0]?.description).toBe("d");
  });

  it("does not flag truncation when the catalog fits in one page", async () => {
    const portalList = vi.fn(async () => ({
      items: [{ kind: "skill" }, { kind: "mcp" }],
      nextCursor: null,
    }));
    const res = await fetchCatalog({ portalList: portalList as never });
    expect(res.truncated).toBe(false);
    expect(res.note).toBeUndefined();
    expect(res.pageCounts).toEqual({ skill: 1, mcp: 1, agent: 0, plugin: 0 });
  });

  it("clips long descriptions", async () => {
    const portalList = vi.fn(async () => ({
      items: [{ kind: "skill", slug: "x", description: "y".repeat(5000) }],
      nextCursor: null,
    }));
    const res = await fetchCatalog({ portalList: portalList as never });
    expect(res.items[0]!.description.length).toBeLessThanOrEqual(280);
  });

  it("degrades to the baked snapshot when the portal is down", async () => {
    const res = await fetchCatalog({
      portalList: (async () => {
        throw new Error("portal down");
      }) as never,
      registryLoader: async () => ({
        items: [regItem()],
        generatedAt: "2026-01-01T00:00:00Z",
        counts: { skill: 1, mcp: 0, agent: 0, plugin: 0 },
      }),
    });
    expect(res.degraded).toBe(true);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({ slug: "pdf" });
  });

  it("re-raises when the portal is down and no snapshot is configured", async () => {
    delete process.env.METAHUB_REGISTRY_URL;
    await expect(
      fetchCatalog({
        portalList: (async () => {
          throw new Error("portal down");
        }) as never,
      }),
    ).rejects.toThrow(/portal down/);
  });
});

describe("catalog/get edge shapes", () => {
  it("get: treats an empty portal payload as not-found", async () => {
    const res = await fetchArtifact(
      { kind: "skill", slug: "pdf" },
      { portalGet: (async () => ({})) as never },
    );
    expect(res.artifact).toBeNull();
    expect(res.degraded).toBe(false);
  });

  it("get: omits reviewSummary when the portal does not send one", async () => {
    const res = await fetchArtifact(
      { kind: "skill", slug: "pdf" },
      { portalGet: (async () => ({ artifact: { slug: "pdf" } })) as never },
    );
    expect(res.artifact).toEqual({ slug: "pdf" });
    expect(res.artifact).not.toHaveProperty("reviewSummary");
  });

  it("get: recognises a bare 'not found' with no status code", async () => {
    const registryLoader = vi.fn(async () => ({ items: [regItem()] }));
    const res = await fetchArtifact(
      { kind: "skill", slug: "pdf" },
      {
        portalGet: (async () => {
          throw new Error("not found");
        }) as never,
        registryLoader,
      },
    );
    expect(res.artifact).toBeNull();
    expect(registryLoader).not.toHaveBeenCalled();
  });

  it("get: handles a non-Error thrown value", async () => {
    delete process.env.METAHUB_REGISTRY_URL;
    await expect(
      fetchArtifact(
        { kind: "skill", slug: "pdf" },
        {
          portalGet: (async () => {
            throw "kaboom";
          }) as never,
        },
      ),
    ).rejects.toBeDefined();
  });

  it("get: degraded lookup returns null when the snapshot lacks the slug", async () => {
    const res = await fetchArtifact(
      { kind: "skill", slug: "absent" },
      {
        portalGet: (async () => {
          throw new Error("HTTP 503");
        }) as never,
        registryLoader: async () => ({ items: [regItem()] }),
      },
    );
    expect(res.artifact).toBeNull();
    expect(res.degraded).toBe(true);
  });

  it("catalog: fills defaults for a sparse record and ignores unknown kinds", async () => {
    const portalList = vi.fn(async () => ({
      items: [{ slug: "bare" }, { kind: "not-a-kind", slug: "weird" }],
      nextCursor: null,
    }));
    const res = await fetchCatalog({ portalList: portalList as never });
    expect(res.items[0]).toMatchObject({
      slug: "bare",
      tagline: "",
      description: "",
      category: null,
      tags: [],
      version: null,
      repoUrl: null,
      installCount: 0,
      rating: null,
      publishedAt: null,
    });
    // An unrecognised kind must not be counted into any bucket.
    expect(res.pageCounts).toEqual({ skill: 0, mcp: 0, agent: 0, plugin: 0 });
  });

  it("catalog: prefers displayName over name, and updatedAt when publishedAt is absent", async () => {
    const portalList = vi.fn(async () => ({
      items: [
        { kind: "skill", slug: "a", name: "raw", displayName: "Pretty", updatedAt: "2026-02-02" },
        { kind: "skill", slug: "b", name: "only-name" },
      ],
      nextCursor: undefined,
    }));
    const res = await fetchCatalog({ portalList: portalList as never });
    expect(res.items[0]).toMatchObject({ name: "Pretty", publishedAt: "2026-02-02" });
    expect(res.items[1]).toMatchObject({ name: "only-name" });
    expect(res.truncated).toBe(false);
  });

  it("catalog: a null/garbage item does not throw", async () => {
    const portalList = vi.fn(async () => ({ items: [null, undefined], nextCursor: null }));
    const res = await fetchCatalog({ portalList: portalList as never });
    expect(res.items).toHaveLength(2);
    expect(res.items[0]?.slug).toBeUndefined();
  });
});

describe("metahub_search surfaces the real error when it cannot degrade", () => {
  it("re-raises the portal error instead of failing against an unconfigured snapshot", async () => {
    delete process.env.METAHUB_REGISTRY_URL;
    await expect(
      searchItems(
        { query: "pdf" },
        {
          searcher: (async () => {
            throw new Error("portal down");
          }) as never,
        },
      ),
    ).rejects.toThrow(/portal down/);
  });
});
