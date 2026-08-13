import type { ArtifactKind } from "./artifact.js";
import type { SearchSort, RankReason } from "./api-contracts.js";

/** Tunable ranking weights/caps. Kept here as the single source of truth. */
export const RANK_CONSTANTS = {
  W_RATING: 2.0,
  W_STARS: 0.5,
  VELOCITY_COEF: 1.5,
  STAR_CAP: Math.log(501), // ≈ 6.217 — bought stars beyond ~500 add nothing
  INSTALL_CAP: Math.log(1001), // ≈ 6.909 — a single farmed source can't exceed this
  BAYES_PRIOR_M: 10,
  DEFAULT_C: 3.5, // neutral mean when the catalog/artifact has no reviews
  RECENCY_K: 0.05, // per-month decay
  FIRST_PARTY_BONUS: 3.5, // additive curation floor (bootstrap) — exceeds the capped star term
  FEATURED_BONUS: 1.5, // so curated/first-party isn't buried at cold-start; installs overtake it later
  WARN_QUALITY: 0.7,
  NO_EVAL_QUALITY: 0.4, // only reached via the exact-name bypass
  MONTH_MS: 30 * 24 * 60 * 60 * 1000,
  HOUR_MS: 60 * 60 * 1000,
} as const;

/** Coerce a possibly-undefined/NaN/Infinity number to a finite fallback. */
export function finite(n: number | null | undefined, fallback: number): number {
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

/** Normalized subset of artifact fields the ranker needs. Both PublicArtifact and
 *  RegistryItem can be projected onto this shape by the caller. */
export interface RankableArtifact {
  id?: string;
  kind: ArtifactKind;
  slug: string;
  name: string;
  tagline?: string | null;
  description?: string | null;
  tags?: string[];
  // adoption (forgeable today — capped; see spec §11)
  installCount?: number;
  installs30d?: number;
  githubStars?: number;
  // reviews
  avgStars?: number | null;
  reviewCount?: number;
  // quality
  behavioralScore?: number | null; // 0..10; preferred quality discriminator
  evalVerdict?: "pass" | "warn" | "fail"; // undefined = never evaluated
  // curation / provenance
  featured?: boolean;
  firstParty?: boolean; // verified / portal-published
  // freshness
  lastUpdateMs?: number | null;
  publishedAtMs?: number | null;
}

export interface RankMeta {
  rank: number;
  relevanceTier: 1 | 2 | 3 | 4;
  withinTier: number;
  trendingScore: number;
  why: RankReason[];
}

export type Ranked<T> = T & RankMeta;

export interface RankOptions {
  q: string;
  sort?: SearchSort;
  limit?: number;
  /** Global mean review rating across the candidate set (for Bayesian shrinkage). */
  globalMeanRating: number;
  /** Current time in epoch ms — passed in so the function stays pure/deterministic. */
  nowMs: number;
}

/** Bayesian-shrunk rating: pulls low-vote artifacts toward the global mean C.
 *  Total + finite for all inputs (n<=0 or non-finite C → DEFAULT_C). */
export function bayesRating(
  avgStars: number | null | undefined,
  reviewCount: number | null | undefined,
  globalMean: number | null | undefined,
): number {
  const { BAYES_PRIOR_M, DEFAULT_C } = RANK_CONSTANTS;
  const n = Math.max(0, finite(reviewCount, 0));
  const C = finite(globalMean, DEFAULT_C);
  if (n <= 0) return C;
  const avg = finite(avgStars, C);
  return (n / (n + BAYES_PRIOR_M)) * avg + (BAYES_PRIOR_M / (n + BAYES_PRIOR_M)) * C;
}

/** Continuous quality multiplier. Prefers the behavioral eval score (0..10);
 *  falls back to the static pass/warn verdict; fail/undefined → NO_EVAL_QUALITY
 *  (only reachable via the exact-name bypass — the gate excludes them otherwise). */
export function qualityMultiplier(
  item: Pick<RankableArtifact, "behavioralScore" | "evalVerdict">,
): number {
  const { WARN_QUALITY, NO_EVAL_QUALITY } = RANK_CONSTANTS;
  const bs = item.behavioralScore;
  if (typeof bs === "number" && Number.isFinite(bs)) {
    const clamped = Math.max(0, Math.min(10, bs));
    return 0.6 + 0.4 * (clamped / 10);
  }
  switch (item.evalVerdict) {
    case "pass":
      return 1.0;
    case "warn":
      return WARN_QUALITY;
    default:
      return NO_EVAL_QUALITY;
  }
}

/** Additive curation floor: first-party/verified + featured. Added INSIDE the blend sum
 *  (not a multiplier) so it can outweigh the capped GitHub-star term at cold-start — i.e.
 *  curation is a primary lever, not a small boost. Bootstrap weights (tuned down as real
 *  adoption accrues — see spec §4). */
export function curationBonus(item: Pick<RankableArtifact, "firstParty" | "featured">): number {
  const { FIRST_PARTY_BONUS, FEATURED_BONUS } = RANK_CONSTANTS;
  return (item.firstParty ? FIRST_PARTY_BONUS : 0) + (item.featured ? FEATURED_BONUS : 0);
}

/** Gentle freshness decay. Unknown age (null/NaN) → 1 (neutral, never 0). */
export function recencyDecay(lastUpdateMs: number | null | undefined, nowMs: number): number {
  if (typeof lastUpdateMs !== "number" || !Number.isFinite(lastUpdateMs)) return 1;
  const months = Math.max(0, (nowMs - lastUpdateMs) / RANK_CONSTANTS.MONTH_MS);
  return 1 / (1 + RANK_CONSTANTS.RECENCY_K * months);
}

/** HN-style trending: recent install velocity over a time-decay denominator. */
export function trendingScore(
  installs30d: number | null | undefined,
  publishedAtMs: number | null | undefined,
  nowMs: number,
): number {
  const v = Math.log(1 + Math.max(0, finite(installs30d, 0)));
  const hours =
    typeof publishedAtMs === "number" && Number.isFinite(publishedAtMs)
      ? Math.max(0, (nowMs - publishedAtMs) / RANK_CONSTANTS.HOUR_MS)
      : 0;
  const score = v / Math.pow(hours + 2, 1.8);
  return Number.isFinite(score) ? score : 0;
}

function norm(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().trim();
}

/** True iff the query exactly equals the artifact's slug or name (case-insensitive). */
export function isExactName(item: Pick<RankableArtifact, "slug" | "name">, q: string): boolean {
  const n = norm(q);
  return n.length > 0 && (norm(item.slug) === n || norm(item.name) === n);
}

/** Relevance tier (1 best … 4 weakest), or null when nothing matches.
 *  1 exact · 2 prefix(slug/name)/exact-tag · 3 substring(name/tagline) · 4 token overlap(desc/tags). */
export function relevanceTier(item: RankableArtifact, q: string): 1 | 2 | 3 | 4 | null {
  const n = norm(q);
  if (!n) return 4; // empty query: caller is in browse mode; tier unused for order
  const slug = norm(item.slug);
  const name = norm(item.name);
  const tagline = norm(item.tagline);
  const tags = (item.tags ?? []).map(norm);
  if (slug === n || name === n) return 1;
  if (slug.startsWith(n) || name.startsWith(n) || tags.includes(n)) return 2;
  if (name.includes(n) || tagline.includes(n)) return 3;
  const tokens = n.split(/\s+/).filter(Boolean);
  const hay = `${norm(item.description)} ${tags.join(" ")}`;
  if (tokens.length > 0 && tokens.some((t) => hay.includes(t))) return 4;
  return null;
}

/** Default-discovery allowlist over a possibly-absent verdict (never `<> 'fail'`). */
export function passesDiscoveryGate(
  item: Pick<RankableArtifact, "behavioralScore" | "evalVerdict">,
): boolean {
  if (item.evalVerdict === "fail") return false;
  if (typeof item.behavioralScore === "number" && Number.isFinite(item.behavioralScore))
    return true;
  return item.evalVerdict === "pass" || item.evalVerdict === "warn";
}

function capInstall(x: number): number {
  return Math.min(x, RANK_CONSTANTS.INSTALL_CAP);
}

/** The within-tier popularity × quality blend. Every term is finite; the result is
 *  coerced to 0 if anything slips through, so the comparator never sees NaN. */
export function withinTierScore(
  item: RankableArtifact,
  opts: Pick<RankOptions, "globalMeanRating" | "nowMs">,
): number {
  const { W_RATING, W_STARS, VELOCITY_COEF, STAR_CAP } = RANK_CONSTANTS;
  const installs = capInstall(Math.log(1 + Math.max(0, finite(item.installCount, 0))));
  const velocity =
    VELOCITY_COEF * capInstall(Math.log(1 + Math.max(0, finite(item.installs30d, 0))));
  const stars =
    W_STARS * Math.min(Math.log(1 + Math.max(0, finite(item.githubStars, 0))), STAR_CAP);
  const bayes = bayesRating(item.avgStars, item.reviewCount, opts.globalMeanRating);
  const rating = W_RATING * (bayes / 5);
  const sum = installs + velocity + stars + rating + curationBonus(item);
  const score = sum * qualityMultiplier(item) * recencyDecay(item.lastUpdateMs, opts.nowMs);
  return Number.isFinite(score) ? score : 0;
}

function stableKey(item: RankableArtifact): string {
  return item.id ?? `${item.kind}:${item.slug}`;
}

function evalRank(item: Pick<RankableArtifact, "evalVerdict">): number {
  switch (item.evalVerdict) {
    case "pass":
      return 2;
    case "warn":
      return 1;
    default:
      return 0; // fail / none
  }
}

interface Annotated {
  item: RankableArtifact;
  tier: 1 | 2 | 3 | 4;
  exact: boolean;
  within: number;
  trending: number;
}

function buildWhy(a: Annotated): RankReason[] {
  const why: RankReason[] = [];
  if (a.exact) why.push("exact-match");
  if (a.item.featured || a.item.firstParty) why.push("curated");
  if (a.trending > 0.05) why.push("trending");
  if ((a.item.installCount ?? 0) >= 10) why.push("popular");
  if ((a.item.reviewCount ?? 0) >= 3 && (a.item.avgStars ?? 0) >= 4) why.push("well-reviewed");
  if (a.item.evalVerdict === "pass") why.push("eval-passed");
  else if (a.item.evalVerdict === "warn") why.push("eval-warning");
  return why;
}

function compareBest(a: Annotated, b: Annotated): number {
  // exact first
  if (a.exact !== b.exact) return a.exact ? -1 : 1;
  // among exact collisions, higher eval verdict first
  if (a.exact && b.exact) {
    const er = evalRank(b.item) - evalRank(a.item);
    if (er !== 0) return er;
  }
  // more-relevant tier first (1 best)
  if (a.tier !== b.tier) return a.tier - b.tier;
  // higher blend first
  if (b.within !== a.within) return b.within - a.within;
  // deterministic
  return stableKey(a.item).localeCompare(stableKey(b.item));
}

function compareBy(key: (a: Annotated) => number): (a: Annotated, b: Annotated) => number {
  return (a, b) => {
    // Sign comparison rather than subtraction: two finite-but-huge opposite-sign
    // keys can't overflow to ±Infinity and break the total order. NaN keys compare
    // false both ways and fall through to the deterministic stable tiebreak.
    const ka = key(a);
    const kb = key(b);
    if (kb > ka) return 1; // desc
    if (kb < ka) return -1;
    return stableKey(a.item).localeCompare(stableKey(b.item));
  };
}

/** Rank a candidate set. Pure + deterministic (pass nowMs). Returns ranked results
 *  with metadata; excludes non-matches (when q present) and gate-failures (unless
 *  an exact-name match, which bypasses the gate). */
export function rankArtifacts<T extends RankableArtifact>(
  items: T[],
  opts: RankOptions,
): Ranked<T>[] {
  const sort: SearchSort = opts.sort ?? "best";
  const hasQuery = norm(opts.q).length > 0;

  let annotated: Array<Annotated & { item: T }> = items
    .map((it) => {
      const tier = hasQuery ? relevanceTier(it, opts.q) : 4;
      if (hasQuery && tier === null) return null;
      return {
        item: it,
        tier: (tier ?? 4) as 1 | 2 | 3 | 4,
        exact: hasQuery && isExactName(it, opts.q),
        within: withinTierScore(it, opts),
        trending: trendingScore(it.installs30d, it.publishedAtMs, opts.nowMs),
      };
    })
    .filter((x): x is Annotated & { item: T } => x !== null)
    // discovery gate, with exact-name bypass
    .filter((a) => passesDiscoveryGate(a.item) || a.exact);

  let cmp: (a: Annotated, b: Annotated) => number;
  switch (sort) {
    case "installs":
      cmp = compareBy((a) => finite(a.item.installCount, 0));
      break;
    case "rating":
      cmp = compareBy((a) =>
        bayesRating(a.item.avgStars, a.item.reviewCount, opts.globalMeanRating),
      );
      break;
    case "trending":
      cmp = compareBy((a) => a.trending);
      break;
    case "updated":
      cmp = compareBy((a) => finite(a.item.lastUpdateMs, 0));
      break;
    case "newest":
      cmp = compareBy((a) => finite(a.item.publishedAtMs, 0));
      break;
    case "best":
    default:
      cmp = compareBest;
      break;
  }
  annotated = annotated.slice().sort(cmp);

  const limited =
    typeof opts.limit === "number" && opts.limit >= 0 ? annotated.slice(0, opts.limit) : annotated;

  return limited.map((a, i) => {
    const why = buildWhy(a);
    if (i < 3) why.unshift("top-pick");
    return {
      ...a.item,
      rank: i + 1,
      relevanceTier: a.tier,
      withinTier: a.within,
      trendingScore: a.trending,
      why,
    } as Ranked<T>;
  });
}
