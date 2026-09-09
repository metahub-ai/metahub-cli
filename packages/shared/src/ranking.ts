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

/** Search-token variants to try against artifact text, original first.
 *
 *  Matching here is substring-based, so a longer query token can never be found
 *  inside shorter document text. That made every plural query silently lose
 *  results: `pdfs` matched no artifact that says "pdf", and `agents` matched no
 *  literal "agent" — while the homepage advertises exactly that register ("find
 *  me a skill for parsing PDFs"). The reverse direction already worked, since
 *  "pdf" IS a substring of "pdfs", so only de-pluralisation is needed.
 *
 *  Variants are strictly additive: they can widen a match set but never narrow
 *  one, which is what keeps the portal's SQL prefilter a superset of this
 *  function (see searchPublicArtifacts).
 *
 *  Deliberately not a stemmer — only the trailing-s family, and never where
 *  trimming would produce a different word ("class", "status", "analysis") or
 *  gut a short token ("js", "aws", "css"). */
export function searchTokenVariants(token: string): string[] {
  const t = norm(token);
  if (!t) return [];
  // -ss/-us/-is are not plural markers, and <=3 chars loses meaning entirely.
  if (t.length <= 3 || /(?:ss|us|is)$/.test(t)) return [t];
  if (/[^aeiou]ies$/.test(t)) return [t, `${t.slice(0, -3)}y`]; // dependencies → dependency
  if (/(?:ch|sh|x|z|s)es$/.test(t)) return [t, t.slice(0, -2)]; // boxes → box
  if (t.endsWith("s")) return [t, t.slice(0, -1)]; // pdfs → pdf
  return [t];
}

/** Query words that carry no discriminating power.
 *
 *  Tier-4 matching is substring-based over every artifact's description, so a
 *  lone token like "a" or "for" matches essentially the whole catalog. That is
 *  why the advertised prompt "find me a skill for parsing PDFs" returned a
 *  Scrum coach and a logging skill: the stopwords matched everything, and
 *  popularity then picked the winners. Function words and search-intent verbs
 *  only — nothing domain-specific, so a real query term is never discarded
 *  (note "search", "help" and "get" are deliberately absent: they are all
 *  plausible names for tools in this catalog). */
const SEARCH_STOPWORDS = new Set([
  "the",
  "and",
  "or",
  "for",
  "with",
  "from",
  "are",
  "its",
  "that",
  "this",
  "these",
  "those",
  "not",
  "you",
  "your",
  "our",
  "find",
  "show",
  "need",
  "want",
  "looking",
  "please",
  "give",
  "best",
  "some",
  "any",
  "something",
  "anything",
  "can",
  "does",
  "how",
  "what",
  "which",
  "where",
  "when",
  "who",
  "why",
  "about",
  "into",
  "onto",
  "than",
  "then",
  "also",
  // ── Catalog-kind words ────────────────────────────────────────────────────
  // These name what the catalog is *made of*, so they match most of it and
  // discriminate nothing. Measured against the live catalog on 2026-08-10
  // (3,434 public artifacts) with /api/public/artifacts/search?q=<word>,
  // keeping every word at or above 25%:
  //   agent 72% · agents 71% · claude 69% · skill 68% · skills 66% ·
  //   code 66% · use 46% · tool 45% · tools 43% · mcp 39% · server 25%
  // Left as real terms because they DO discriminate: plugin/plugins 19%,
  // user 19%, workflow 22%, data 16%, file 9%, project 8%, using 7%.
  // Re-measure with that endpoint if the catalog's composition shifts.
  //
  // Safe because tiers 1-3 match the WHOLE query untouched: searching "agent"
  // still hits an artifact named `agent` at tier 1/2, and a query made only of
  // these words falls back to every token (see searchTerms).
  "skill",
  "skills",
  "agent",
  "agents",
  "claude",
  "code",
  "tool",
  "tools",
  "mcp",
  "server",
  "use",
]);

/** The tokens of `q` that carry signal. Each still needs searchTokenVariants().
 *
 *  Falls back to every token when a query is nothing but stopwords, so "the
 *  best" still returns something rather than nothing. */
export function searchTerms(q: string): string[] {
  const tokens = norm(q).split(/\s+/).filter(Boolean);
  // <=2 chars ("a", "me", "of") never discriminates either.
  const meaningful = tokens.filter((t) => t.length > 2 && !SEARCH_STOPWORDS.has(t));
  return meaningful.length > 0 ? meaningful : tokens;
}

/** How many of the query's terms this artifact matches, across every searchable
 *  field.
 *
 *  Matching is OR-recall (any one term is enough to be a candidate), so without
 *  this the popularity blend alone decides the order — and a presentation skill
 *  that merely mentions "pdf" outranked a dedicated PDF parser for the query
 *  "parsing PDFs". Counting matched terms makes the artifact that answers MORE
 *  of the query win its tier.
 *
 *  Only affects multi-term queries: for a single term every surviving candidate
 *  scores 1, so existing single-word ordering is untouched. */
export function matchedTermCount(item: RankableArtifact, q: string): number {
  const terms = searchTerms(q);
  if (terms.length === 0) return 0;
  const hay = [
    norm(item.slug),
    norm(item.name),
    norm(item.tagline),
    norm(item.description),
    (item.tags ?? []).map(norm).join(" "),
  ].join(" ");
  let matched = 0;
  for (const t of terms) {
    if (searchTokenVariants(t).some((v) => hay.includes(v))) matched++;
  }
  return matched;
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
  const terms = searchTerms(n);
  // Scan the same fields as the portal's SQL prefilter (and matchedTermCount).
  // This was description+tags only, which silently dropped artifacts whose match
  // lives in the name or slug: "translator pdf" lost the skill literally named
  // "PDF Translator", even though bare "pdf" found it via the tier-2 slug prefix.
  // A multi-term query has no tier-1..3 path — those compare the WHOLE query —
  // so tier 4 must be as wide as the prefilter that fed it, or the prefilter
  // stops being a superset of the ranker.
  const hay = `${slug} ${name} ${tagline} ${norm(item.description)} ${tags.join(" ")}`;
  if (terms.length > 0 && terms.some((t) => searchTokenVariants(t).some((v) => hay.includes(v))))
    return 4;
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
  /** Query terms this artifact matches — orders within a tier, ahead of the
   *  popularity blend. See matchedTermCount. */
  coverage: number;
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
  // within a tier, answering MORE of the query beats being more popular
  if (b.coverage !== a.coverage) return b.coverage - a.coverage;
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
        coverage: hasQuery ? matchedTermCount(it, opts.q) : 0,
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
