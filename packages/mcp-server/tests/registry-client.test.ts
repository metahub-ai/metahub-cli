/**
 * Tests for `fetchRegistry` — exercises each failure branch and the
 * happy path with an injected stub fetcher. Never hits the network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { REGISTRY_CACHE_TTL_MS, clearRegistryCache, fetchRegistry } from "../src/registry-client";
import type { Registry, RegistryItem } from "../src/types";

beforeEach(() => {
  clearRegistryCache();
});

const TEST_URL = "https://test.metahub.dev/registry.json";

function makeFetcher(impl: (url: string) => Promise<Response> | Response) {
  return vi.fn((url: string | URL | Request) => {
    const u = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    return Promise.resolve(impl(u));
  }) as unknown as typeof fetch;
}

const SAMPLE_ITEM: RegistryItem = {
  slug: "pdf",
  kind: "skill",
  name: "PDF Skill",
  tagline: "x",
  description: "y",
  tags: ["pdf"],
  author: { handle: "alice", name: "Alice" },
  source: { type: "github", url: "https://github.com/alice/pdf" },
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("fetchRegistry", () => {
  it("throws with the status when the response is not ok", async () => {
    const fetcher = makeFetcher(() => new Response("oops", { status: 500 }));
    await expect(fetchRegistry({ url: TEST_URL, fetcher })).rejects.toThrow(/HTTP 500/);
  });

  it("throws with a 'Could not reach' prefix on network errors", async () => {
    const fetcher = makeFetcher(() => {
      throw new Error("ECONNREFUSED");
    });
    await expect(fetchRegistry({ url: TEST_URL, fetcher })).rejects.toThrow(/Could not reach/);
  });

  it("throws with a 'not valid JSON' message when the body is not JSON", async () => {
    const fetcher = makeFetcher(
      () =>
        new Response("<html>500</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    );
    await expect(fetchRegistry({ url: TEST_URL, fetcher })).rejects.toThrow(/not valid JSON/);
  });

  it("throws via normalise when the items array is missing", async () => {
    const fetcher = makeFetcher(
      () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await expect(fetchRegistry({ url: TEST_URL, fetcher })).rejects.toThrow(/items/);
  });

  it("throws via normalise when the payload is not an object", async () => {
    const fetcher = makeFetcher(
      () =>
        new Response(JSON.stringify(null), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await expect(fetchRegistry({ url: TEST_URL, fetcher })).rejects.toThrow(/not an object/);
  });

  it("returns the normalised registry on success, filling counts and generatedAt defaults", async () => {
    const payload = { items: [SAMPLE_ITEM] };
    const fetcher = makeFetcher(
      () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const reg: Registry = await fetchRegistry({ url: TEST_URL, fetcher });
    expect(reg.items).toEqual([SAMPLE_ITEM]);
    expect(reg.counts).toEqual({ skill: 0, mcp: 0, agent: 0, plugin: 0 });
    expect(typeof reg.generatedAt).toBe("string");
  });

  it("preserves explicit counts and generatedAt when present", async () => {
    const payload: Registry = {
      items: [SAMPLE_ITEM],
      counts: { skill: 1, mcp: 0, agent: 0, plugin: 0 },
      generatedAt: "2026-02-02T00:00:00Z",
    };
    const fetcher = makeFetcher(
      () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const reg = await fetchRegistry({ url: TEST_URL, fetcher });
    expect(reg.counts.skill).toBe(1);
    expect(reg.generatedAt).toBe("2026-02-02T00:00:00Z");
  });

  it("caches the payload across calls within the TTL window", async () => {
    const payload = { items: [SAMPLE_ITEM] };
    const fetcher = makeFetcher(
      () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await fetchRegistry({ url: TEST_URL, fetcher });
    await fetchRegistry({ url: TEST_URL, fetcher });
    await fetchRegistry({ url: TEST_URL, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refetches once the TTL has elapsed", async () => {
    const payload = { items: [SAMPLE_ITEM] };
    const fetcher = makeFetcher(
      () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const realNow = Date.now;
    let nowMs = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    try {
      await fetchRegistry({ url: TEST_URL, fetcher });
      nowMs += REGISTRY_CACHE_TTL_MS + 1;
      await fetchRegistry({ url: TEST_URL, fetcher });
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      vi.spyOn(Date, "now").mockImplementation(realNow);
      vi.restoreAllMocks();
    }
  });

  it("clearRegistryCache forces the next call to refetch", async () => {
    const payload = { items: [SAMPLE_ITEM] };
    const fetcher = makeFetcher(
      () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await fetchRegistry({ url: TEST_URL, fetcher });
    clearRegistryCache();
    await fetchRegistry({ url: TEST_URL, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
