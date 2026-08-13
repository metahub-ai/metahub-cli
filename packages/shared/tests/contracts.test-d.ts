/**
 * Type-level regression guard for the PublicArtifactSummary lean contract.
 *
 * This file is checked by Vitest's `typecheck` pass (see vitest.config.ts,
 * `test.typecheck.enabled`), which runs `tsc` directly against `.test-d.ts`
 * files as a separate pass from the runtime suite. That's deliberate: the
 * package's ordinary `tsc -p tsconfig.json` typecheck script only covers
 * `src/**`, and vitest's runtime tests strip types away — so without this
 * file, nothing in `pnpm verify` would catch `readme` or `longDescription`
 * being re-added to the lean list type. See docs/ARCHITECTURE.md / the
 * scalable-read-path incident notes for why that regression is dangerous
 * (list payloads blew past Next's 2MB cache limit).
 */
import { describe, expectTypeOf, it } from "vitest";
import type { PublicArtifactSummary } from "../src/index.js";

describe("PublicArtifactSummary (type-level)", () => {
  it("never carries the large text fields that caused the list-page cache incident", () => {
    // Regression guards — these must NEVER be added back to the lean summary.
    expectTypeOf<PublicArtifactSummary>().not.toHaveProperty("readme");
    expectTypeOf<PublicArtifactSummary>().not.toHaveProperty("longDescription");
  });

  it("keeps the lean display + badge shape", () => {
    expectTypeOf<PublicArtifactSummary>().toHaveProperty("id").toEqualTypeOf<string>();
    expectTypeOf<PublicArtifactSummary>().toHaveProperty("slug").toEqualTypeOf<string>();
    expectTypeOf<PublicArtifactSummary>().toHaveProperty("name").toEqualTypeOf<string>();
    expectTypeOf<PublicArtifactSummary>()
      .toHaveProperty("shortDescription")
      .toEqualTypeOf<string>();
    expectTypeOf<PublicArtifactSummary>().toHaveProperty("stars").toEqualTypeOf<number | null>();
    expectTypeOf<PublicArtifactSummary>().toHaveProperty("tags").toEqualTypeOf<string[]>();
    expectTypeOf<PublicArtifactSummary>().toHaveProperty("badges");
    expectTypeOf<PublicArtifactSummary>().toHaveProperty("featured").toEqualTypeOf<boolean>();
    expectTypeOf<PublicArtifactSummary>()
      .toHaveProperty("featuredRank")
      .toEqualTypeOf<number | null>();
    expectTypeOf<PublicArtifactSummary>()
      .toHaveProperty("installCount")
      .toEqualTypeOf<number | null>();
    expectTypeOf<PublicArtifactSummary>().toHaveProperty("createdMs").toEqualTypeOf<number>();
  });
});
