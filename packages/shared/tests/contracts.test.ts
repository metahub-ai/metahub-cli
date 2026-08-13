import { describe, it, expect } from "vitest";
import type { PublicArtifactSummary, ListArtifactSummariesResponse } from "../src/index.js";

describe("PublicArtifactSummary", () => {
  it("is a lean shape with no readme / long_description fields", () => {
    const s: PublicArtifactSummary = {
      id: "a1",
      kind: "skill",
      slug: "foo",
      name: "Foo",
      tagline: null,
      shortDescription: "does foo",
      logoUrl: null,
      stars: 3,
      lastPushMs: 100,
      latestRelease: null,
      authorHandle: "octo",
      tags: ["x"],
      badges: [],
      featured: false,
      featuredRank: null,
      verifiedMs: null,
      installCount: null,
      createdMs: 1,
    };
    const res: ListArtifactSummariesResponse = { items: [s], nextCursor: null };
    // @ts-expect-error — readme must NOT exist on the lean summary
    void s.readme;
    expect(res.items[0].slug).toBe("foo");
  });
});
