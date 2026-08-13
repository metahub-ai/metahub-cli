import { describe, it, expect } from "vitest";
import {
  RANK_CONSTANTS,
  finite,
  bayesRating,
  qualityMultiplier,
  curationBonus,
  recencyDecay,
  trendingScore,
  relevanceTier,
  isExactName,
  passesDiscoveryGate,
  withinTierScore,
  rankArtifacts,
  type RankableArtifact,
} from "../src/ranking.js";

const item = (over: Partial<RankableArtifact> = {}): RankableArtifact => ({
  kind: "skill",
  slug: "code-review",
  name: "Code Review",
  tagline: "Review pull requests",
  description: "An automated code review assistant for diffs",
  tags: ["review", "git"],
  ...over,
});

const opts0 = { globalMeanRating: 4.0, nowMs: 1_000_000_000_000 };

describe("ranking constants + finite()", () => {
  it("exposes the documented constants", () => {
    expect(RANK_CONSTANTS.W_RATING).toBe(2.0);
    expect(RANK_CONSTANTS.W_STARS).toBe(0.5);
    expect(RANK_CONSTANTS.BAYES_PRIOR_M).toBe(10);
    expect(RANK_CONSTANTS.DEFAULT_C).toBe(3.5);
    expect(RANK_CONSTANTS.STAR_CAP).toBeCloseTo(Math.log(501), 10);
    expect(RANK_CONSTANTS.INSTALL_CAP).toBeCloseTo(Math.log(1001), 10);
  });

  it("finite() returns the value when finite, else the fallback", () => {
    expect(finite(3, 9)).toBe(3);
    expect(finite(NaN, 9)).toBe(9);
    expect(finite(Infinity, 9)).toBe(9);
    expect(finite(null, 9)).toBe(9);
    expect(finite(undefined, 9)).toBe(9);
  });
});

describe("bayesRating", () => {
  it("returns the global mean C when there are zero reviews", () => {
    expect(bayesRating(null, 0, 4.3)).toBe(4.3);
    expect(bayesRating(5, 0, 4.3)).toBe(4.3); // avg ignored when n=0
  });

  it("returns DEFAULT_C (3.5) when C itself is non-finite (empty catalog)", () => {
    expect(bayesRating(null, 0, NaN)).toBe(3.5);
    expect(bayesRating(null, 0, undefined)).toBe(3.5);
  });

  it("shrinks a low-vote 5-star toward C (does not reach 5)", () => {
    const b = bayesRating(5, 2, 4.0);
    expect(b).toBeCloseTo((2 / 12) * 5 + (10 / 12) * 4.0, 10);
    expect(b).toBeLessThan(4.2);
  });

  it("approaches the true average as review count grows", () => {
    const b = bayesRating(4.8, 500, 4.0);
    expect(b).toBeGreaterThan(4.7);
  });

  it("never returns NaN for garbage inputs", () => {
    expect(Number.isFinite(bayesRating(NaN, NaN, NaN))).toBe(true);
  });
});

describe("qualityMultiplier", () => {
  it("uses the continuous behavioral score when present (0.6..1.0)", () => {
    expect(qualityMultiplier({ behavioralScore: 10 })).toBeCloseTo(1.0, 10);
    expect(qualityMultiplier({ behavioralScore: 0 })).toBeCloseTo(0.6, 10);
    expect(qualityMultiplier({ behavioralScore: 5 })).toBeCloseTo(0.8, 10);
  });
  it("clamps out-of-range behavioral scores", () => {
    expect(qualityMultiplier({ behavioralScore: 99 })).toBeCloseTo(1.0, 10);
    expect(qualityMultiplier({ behavioralScore: -5 })).toBeCloseTo(0.6, 10);
  });
  it("falls back to the static verdict when no behavioral score", () => {
    expect(qualityMultiplier({ evalVerdict: "pass" })).toBe(1.0);
    expect(qualityMultiplier({ evalVerdict: "warn" })).toBe(0.7);
  });
  it("returns NO_EVAL_QUALITY (0.4) for fail/undefined (exact-name bypass only)", () => {
    expect(qualityMultiplier({ evalVerdict: "fail" })).toBe(0.4);
    expect(qualityMultiplier({})).toBe(0.4);
  });
});

describe("curationBonus", () => {
  it("adds first-party and featured bonuses (additive curation floor)", () => {
    expect(curationBonus({})).toBe(0);
    expect(curationBonus({ firstParty: true })).toBe(3.5);
    expect(curationBonus({ featured: true })).toBe(1.5);
    expect(curationBonus({ firstParty: true, featured: true })).toBeCloseTo(5.0, 10);
  });
});

describe("recencyDecay", () => {
  const now = 1_000_000_000_000;
  it("is 1 when lastUpdate is null/NaN (treat unknown age as fresh, never 0)", () => {
    expect(recencyDecay(null, now)).toBe(1);
    expect(recencyDecay(NaN, now)).toBe(1);
  });
  it("decays gently with age and never increases for future dates", () => {
    const oneMonthAgo = now - RANK_CONSTANTS.MONTH_MS;
    expect(recencyDecay(oneMonthAgo, now)).toBeCloseTo(1 / (1 + 0.05), 10);
    expect(recencyDecay(now + RANK_CONSTANTS.MONTH_MS, now)).toBe(1); // clamp future to 0 months
  });
});

describe("trendingScore", () => {
  const now = 1_000_000_000_000;
  it("is 0 when there are no recent installs", () => {
    expect(trendingScore(0, now - RANK_CONSTANTS.HOUR_MS, now)).toBe(0);
  });
  it("rewards velocity and decays with age", () => {
    const fresh = trendingScore(100, now - RANK_CONSTANTS.HOUR_MS, now);
    const old = trendingScore(100, now - 1000 * RANK_CONSTANTS.HOUR_MS, now);
    expect(fresh).toBeGreaterThan(old);
  });
  it("never returns NaN for null publishedAt", () => {
    expect(Number.isFinite(trendingScore(10, null, now))).toBe(true);
  });
});

describe("relevanceTier", () => {
  it("tier 1 for exact slug or name match", () => {
    expect(relevanceTier(item(), "code-review")).toBe(1);
    expect(relevanceTier(item(), "Code Review")).toBe(1);
  });
  it("tier 2 for prefix match or exact tag", () => {
    expect(relevanceTier(item(), "code")).toBe(2); // slug prefix
    expect(relevanceTier(item(), "git")).toBe(2); // exact tag
  });
  it("tier 3 for substring in name/tagline", () => {
    expect(relevanceTier(item(), "review pull")).toBe(3); // tagline substring
  });
  it("tier 4 for token overlap in description/tags", () => {
    expect(relevanceTier(item(), "automated assistant")).toBe(4);
  });
  it("returns null when nothing matches", () => {
    expect(relevanceTier(item(), "kubernetes")).toBeNull();
  });
});

describe("isExactName", () => {
  it("matches slug or name case-insensitively", () => {
    expect(isExactName(item(), "CODE-REVIEW")).toBe(true);
    expect(isExactName(item(), "review")).toBe(false); // substring, not an exact slug/name
    expect(isExactName(item(), "")).toBe(false);
  });
});

describe("passesDiscoveryGate", () => {
  it("admits pass and warn", () => {
    expect(passesDiscoveryGate(item({ evalVerdict: "pass" }))).toBe(true);
    expect(passesDiscoveryGate(item({ evalVerdict: "warn" }))).toBe(true);
  });
  it("admits a present behavioral score that is not failing", () => {
    expect(passesDiscoveryGate(item({ behavioralScore: 8 }))).toBe(true);
    expect(passesDiscoveryGate(item({ behavioralScore: 8, evalVerdict: "fail" }))).toBe(false);
  });
  it("excludes fail and never-evaluated", () => {
    expect(passesDiscoveryGate(item({ evalVerdict: "fail" }))).toBe(false);
    expect(passesDiscoveryGate(item({}))).toBe(false);
  });
});

describe("withinTierScore", () => {
  it("is finite for an all-empty cold-start artifact", () => {
    expect(Number.isFinite(withinTierScore(item({}), opts0))).toBe(true);
  });
  it("never returns NaN even with garbage stats", () => {
    const s = withinTierScore(
      item({
        installCount: NaN,
        installs30d: undefined,
        githubStars: NaN,
        avgStars: NaN,
        reviewCount: NaN,
        behavioralScore: NaN,
        lastUpdateMs: NaN,
      }) as RankableArtifact,
      { globalMeanRating: NaN, nowMs: 1_000_000_000_000 },
    );
    expect(Number.isFinite(s)).toBe(true);
  });
  it("caps the GitHub-star term so stars cannot dominate", () => {
    const modest = withinTierScore(item({ githubStars: 500, evalVerdict: "pass" }), opts0);
    const absurd = withinTierScore(item({ githubStars: 5_000_000, evalVerdict: "pass" }), opts0);
    expect(absurd - modest).toBeLessThan(0.2);
  });
  it("caps the install term so a farm cannot dominate", () => {
    const some = withinTierScore(item({ installCount: 1000, evalVerdict: "pass" }), opts0);
    const farmed = withinTierScore(item({ installCount: 10_000_000, evalVerdict: "pass" }), opts0);
    expect(farmed - some).toBeLessThan(0.2);
  });
  it("first-party/curated low-star beats non-curated high-star (curation floor)", () => {
    const curated = withinTierScore(
      item({ githubStars: 5, firstParty: true, evalVerdict: "pass" }),
      opts0,
    );
    const popular = withinTierScore(item({ githubStars: 5000, evalVerdict: "pass" }), opts0);
    expect(curated).toBeGreaterThan(popular);
  });
  it("a passing behavioral artifact outscores an identical warn one", () => {
    const good = withinTierScore(item({ installCount: 50, behavioralScore: 9 }), opts0);
    const meh = withinTierScore(item({ installCount: 50, evalVerdict: "warn" }), opts0);
    expect(good).toBeGreaterThan(meh);
  });
});

const passItem = (over: Partial<RankableArtifact>): RankableArtifact =>
  item({ evalVerdict: "pass", ...over });

describe("rankArtifacts", () => {
  it("pins an exact-name match to rank #1 regardless of popularity", () => {
    const exactLowPop = passItem({
      slug: "pytest",
      name: "pytest",
      installCount: 0,
      githubStars: 0,
    });
    const popularOther = passItem({
      slug: "pytest-helpers",
      name: "pytest helpers",
      installCount: 9999,
      githubStars: 9999,
    });
    const out = rankArtifacts([popularOther, exactLowPop], {
      q: "pytest",
      globalMeanRating: 4,
      nowMs: 1_000_000_000_000,
    });
    expect(out[0].slug).toBe("pytest");
    expect(out[0].rank).toBe(1);
    expect(out[0].why).toContain("exact-match");
  });

  it("orders exact-name collisions by eval verdict (pass over fail)", () => {
    const failSquatter = item({ slug: "code-review", name: "Code Review", evalVerdict: "fail" });
    const realPass = passItem({ slug: "code-review", name: "Code Review", id: "real" });
    const out = rankArtifacts([failSquatter, realPass], {
      q: "code-review",
      globalMeanRating: 4,
      nowMs: 1_000_000_000_000,
    });
    expect(out[0].evalVerdict).toBe("pass");
  });

  it("relevance gates: a stronger text match outranks a weaker one even if less popular", () => {
    const exactish = passItem({ slug: "review", name: "review", installCount: 0 });
    const descOnly = passItem({
      slug: "mega-tool",
      name: "Mega Tool",
      tagline: "does everything",
      description: "also can review code",
      installCount: 100000,
    });
    const out = rankArtifacts([descOnly, exactish], {
      q: "review",
      globalMeanRating: 4,
      nowMs: 1_000_000_000_000,
    });
    expect(out[0].slug).toBe("review");
  });

  it("drops non-matches when a query is present", () => {
    const out = rankArtifacts([passItem({ slug: "kubernetes", name: "kubernetes" })], {
      q: "code-review",
      globalMeanRating: 4,
      nowMs: 1_000_000_000_000,
    });
    expect(out).toHaveLength(0);
  });

  it("excludes fail/no-eval from default discovery but keeps them findable by exact name", () => {
    const failArtifact = item({ slug: "shady", name: "Shady", evalVerdict: "fail" });
    const fuzzy = rankArtifacts([failArtifact], { q: "shad", globalMeanRating: 4, nowMs: 1e12 });
    expect(fuzzy).toHaveLength(0);
    const exact = rankArtifacts([failArtifact], { q: "shady", globalMeanRating: 4, nowMs: 1e12 });
    expect(exact).toHaveLength(1);
    expect(exact[0].slug).toBe("shady");
  });

  it("is deterministic across input order (stable final tie-break)", () => {
    const a = passItem({ id: "a", slug: "x-a", name: "X A", installCount: 10 });
    const b = passItem({ id: "b", slug: "x-b", name: "X B", installCount: 10 });
    const o1 = rankArtifacts([a, b], { q: "x", globalMeanRating: 4, nowMs: 1e12 }).map((r) => r.id);
    const o2 = rankArtifacts([b, a], { q: "x", globalMeanRating: 4, nowMs: 1e12 }).map((r) => r.id);
    expect(o1).toEqual(o2);
  });

  it("never produces a NaN ordering at full cold-start (no signals at all)", () => {
    const items = [
      item({ id: "1", slug: "alpha", name: "Alpha", evalVerdict: "pass" }),
      item({ id: "2", slug: "beta", name: "Beta", evalVerdict: "warn" }),
    ];
    const out = rankArtifacts(items, { q: "", globalMeanRating: NaN, nowMs: 1e12 });
    expect(out).toHaveLength(2);
    expect(out.every((r) => Number.isFinite(r.withinTier))).toBe(true);
    expect(out.map((r) => r.rank)).toEqual([1, 2]);
  });

  it("respects limit and the explicit 'installs' sort", () => {
    const items = [
      passItem({ id: "lo", slug: "t-lo", name: "T lo", installCount: 1 }),
      passItem({ id: "hi", slug: "t-hi", name: "T hi", installCount: 999 }),
      passItem({ id: "mid", slug: "t-mid", name: "T mid", installCount: 50 }),
    ];
    const out = rankArtifacts(items, {
      q: "t",
      sort: "installs",
      limit: 2,
      globalMeanRating: 4,
      nowMs: 1e12,
    });
    expect(out.map((r) => r.id)).toEqual(["hi", "mid"]);
  });

  it("among exact-name collisions, ranks eval pass > warn > fail", () => {
    // All three are exact-name matches for "code review" so they bypass the
    // discovery gate; the verdict ladder (pass=2, warn=1, fail=0) decides order.
    const pass = passItem({
      id: "p",
      slug: "code-review",
      name: "Code Review",
      evalVerdict: "pass",
    });
    const warn = item({ id: "w", slug: "code-review", name: "Code Review", evalVerdict: "warn" });
    const fail = item({ id: "f", slug: "code-review", name: "Code Review", evalVerdict: "fail" });
    const out = rankArtifacts([warn, fail, pass], {
      q: "code review",
      globalMeanRating: 4,
      nowMs: 1e12,
    });
    expect(out.map((r) => r.id)).toEqual(["p", "w", "f"]);
  });

  it("sorts by 'rating', breaking equal-rating ties by the stable key", () => {
    const hi = passItem({
      id: "r-hi",
      slug: "rate-hi",
      name: "Rate Hi",
      avgStars: 4.9,
      reviewCount: 50,
    });
    const lo = passItem({
      id: "r-lo",
      slug: "rate-lo",
      name: "Rate Lo",
      avgStars: 3.0,
      reviewCount: 50,
    });
    // identical rating signals -> bayesRating ties -> compareBy falls to stableKey
    const tieA = passItem({
      id: "r-a",
      slug: "rate-a",
      name: "Rate A",
      avgStars: 4.0,
      reviewCount: 20,
    });
    const tieB = passItem({
      id: "r-b",
      slug: "rate-b",
      name: "Rate B",
      avgStars: 4.0,
      reviewCount: 20,
    });
    const out = rankArtifacts([tieB, lo, hi, tieA], {
      q: "rate",
      sort: "rating",
      globalMeanRating: 4,
      nowMs: 1e12,
    });
    const ids = out.map((r) => r.id);
    expect(ids[0]).toBe("r-hi");
    expect(ids[ids.length - 1]).toBe("r-lo");
    expect(ids.indexOf("r-a")).toBeLessThan(ids.indexOf("r-b"));
  });

  it("honors the 'trending', 'updated', and 'newest' sorts", () => {
    const x = passItem({
      id: "x",
      slug: "s-x",
      name: "S X",
      installs30d: 500,
      publishedAtMs: 9.9e11,
      lastUpdateMs: 9.9e11,
    });
    const y = passItem({
      id: "y",
      slug: "s-y",
      name: "S Y",
      installs30d: 5,
      publishedAtMs: 9.5e11,
      lastUpdateMs: 9.99e11,
    });
    const z = passItem({
      id: "z",
      slug: "s-z",
      name: "S Z",
      installs30d: 0,
      publishedAtMs: 9.0e11,
      lastUpdateMs: 9.0e11,
    });
    const items = [z, x, y];
    const common = { q: "s", globalMeanRating: 4, nowMs: 1e12 };
    expect(rankArtifacts(items, { ...common, sort: "trending" })[0].id).toBe("x");
    expect(rankArtifacts(items, { ...common, sort: "updated" })[0].id).toBe("y");
    expect(rankArtifacts(items, { ...common, sort: "newest" })[0].id).toBe("x");
  });

  it("annotates the why-reasons (top-pick, curated, trending, popular, well-reviewed, eval) on results", () => {
    const nowMs = 1e12;
    const rich = passItem({
      id: "rich",
      slug: "rich-skill",
      name: "Rich Skill",
      featured: true,
      installCount: 1000,
      installs30d: 800,
      publishedAtMs: nowMs - 3_600_000, // ~1h ago -> trending well above 0.05
      avgStars: 4.7,
      reviewCount: 25,
      evalVerdict: "pass",
    });
    const why = rankArtifacts([rich], { q: "rich", globalMeanRating: 4, nowMs })[0].why;
    expect(why).toEqual(
      expect.arrayContaining([
        "top-pick",
        "curated",
        "trending",
        "popular",
        "well-reviewed",
        "eval-passed",
      ]),
    );
  });
});
