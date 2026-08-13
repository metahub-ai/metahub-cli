import { describe, expect, it } from "vitest";
import type { PublicArtifact } from "../src/public";
import { BADGE_CATALOG } from "../src/badges";

describe("curator wire-format extensions", () => {
  it("PublicArtifact allows isCurated as an optional boolean", () => {
    const a: PublicArtifact = {
      id: "art_x",
      slug: "foo",
      name: "Foo",
      kind: "skill",
      description: "",
      version: null,
      visibility: "public",
      repoUrl: "https://github.com/a/b",
      repoBranch: "main",
      repoPath: null,
      publishedSha: "abc",
      publishedAt: new Date().toISOString(),
      displayName: null,
      tagline: null,
      longDescription: null,
      logoUrl: null,
      category: null,
      tags: [],
      supportUrl: null,
      docsUrl: null,
      supportedClients: [],
      authorHandle: "a",
      badges: [],
      isCurated: true,
    };
    expect(a.isCurated).toBe(true);
  });

  it("includes a 'curated' entry in BADGE_CATALOG", () => {
    const ids = BADGE_CATALOG.map((r) => r.id);
    expect(ids).toContain("curated");
  });
});
