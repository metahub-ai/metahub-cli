import { describe, it, expect } from "vitest";
import type {
  PublicArtifact,
  RegistryItem,
  SearchArtifactsQuery,
  SearchArtifactsResponse,
  RankReason,
  SearchSort,
} from "../src/index.js";

describe("ranked-search wire types", () => {
  it("PublicArtifact carries the new optional stat fields", () => {
    const a = {
      installCount: 12,
      installs30d: 3,
      avgRating: 4.2,
      bayesRating: 4.0,
      trendingScore: 0.5,
      githubStars: 99,
    } satisfies Partial<PublicArtifact>;
    expect(a.installCount).toBe(12);
  });

  it("RegistryItem exposes score/featured/featuredRank", () => {
    const r = { score: 1.2, featured: true, featuredRank: 3 } satisfies Partial<RegistryItem>;
    expect(r.featured).toBe(true);
  });

  it("search query/response/sort/reason types are usable", () => {
    const sort: SearchSort = "best";
    const q: SearchArtifactsQuery = { q: "code review", kind: "skill", sort, limit: 10 };
    const reason: RankReason = "exact-match";
    const resp = { items: [], total: 0, degraded: false } satisfies SearchArtifactsResponse;
    expect(q.q).toBe("code review");
    expect(reason).toBe("exact-match");
    expect(resp.total).toBe(0);
  });
});
