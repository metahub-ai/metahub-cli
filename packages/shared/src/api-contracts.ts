/**
 * Wire-format contracts for every public HTTP endpoint exposed by the
 * portal. The registry and CLI import these types so they always agree
 * with the portal on what they're sending and receiving.
 *
 * Any change to a type in this file is a cross-team event.
 */
import type { Artifact, ArtifactKind, Visibility } from "./artifact.js";
import type {
  ArtifactCardStats,
  PublicArtifact,
  PublicArtifactSummary,
  PublicReview,
  PublicReviewSummary,
} from "./public.js";
import type { IngestBatch, IngestResponse } from "./ingest.js";
import type { EvalReport } from "./eval.js";
import type { RegistryTokenScope } from "./tokens.js";

// ─── Auth (GitHub Device Flow) ──────────────────────────────────────────────

export interface DeviceFlowStartResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceFlowPollRequest {
  deviceCode: string;
}

export type DeviceFlowPollResponse =
  | { state: "pending" }
  | { state: "slow_down"; interval: number }
  | { state: "expired" }
  | { state: "denied" }
  | {
      state: "complete";
      token: string;
      user: { id: string; githubLogin: string; githubId: number };
    };

export interface CurrentUserResponse {
  user: {
    id: string;
    githubLogin: string;
    githubId: number;
    avatarUrl: string | null;
  };
}

// ─── Onboarding ─────────────────────────────────────────────────────────────

export interface OnboardGitHubRequest {
  /** A full GitHub repo URL: https://github.com/<owner>/<name>(/tree/<branch>)? */
  repoUrl: string;
  /** Optional branch override. Defaults to repo default branch. */
  branch?: string;
}

export interface OnboardGitHubResponse {
  jobId: string;
  report: EvalReport;
}

export interface GetEvalReportResponse {
  report: EvalReport;
}

// ─── Artifacts (signed-in dev) ──────────────────────────────────────────────

export interface CreateArtifactRequest {
  jobId: string;
  /**
   * Which detected artifact in the job to promote. Required when the
   * job's scan found more than one; ignored when there's exactly one.
   */
  detectionId?: string;
  /**
   * Optional overrides for the manifest fields. The repo manifest is
   * still treated as source of truth for `version` and `kind`. The
   * `slug` defaults to the manifest's slug but the wizard can override
   * it (e.g. when the manifest slug collides with an existing artifact)
   * — the server re-validates format + uniqueness server-side before
   * accepting the create.
   */
  overrides?: {
    name?: string;
    description?: string;
    tagline?: string | null;
    longDescription?: string | null;
    tags?: string[];
    category?: string | null;
    logoUrl?: string | null;
    /**
     * Optional slug override. Must match the canonical slug format
     * (`/^[a-z0-9][a-z0-9-]{0,62}$/`) and be unique within `kind`. When
     * omitted, the server falls back to the manifest's slug.
     */
    slug?: string;
  };
  /**
   * Visibility to set immediately on create. When this is `public` or
   * `unlisted`, the server also runs the publish pipeline (using the
   * eval that was already done for this jobId) so the artifact lands
   * in the registry in one round-trip. Defaults to `private` — the
   * user can publish later from the dashboard.
   */
  initialVisibility?: Visibility;
}

export interface CreateArtifactResponse {
  artifact: Artifact;
}

export interface ListArtifactsResponse {
  artifacts: Artifact[];
}

export interface PublishRequest {
  /** Force re-fetch + re-evaluate from latest commit before publishing. */
  refresh?: boolean;
}

export interface PublishResponse {
  artifact: Artifact;
  publishedSha: string;
}

export interface UpdateVisibilityRequest {
  visibility: Visibility;
}

// ─── Public catalog (registry build + CLI) ──────────────────────────────────

export interface ListPublicArtifactsQuery {
  limit?: number;
  cursor?: string | null;
  kind?: ArtifactKind;
  include?: "unlisted";
  /** `lean` selects the PublicArtifactSummary projection (registry read path). */
  fields?: "full" | "lean";
  /**
   * `name`/`rating`/`trending`/`installs`/`updated` are `fields=lean`-only —
   * they read name/stat columns that only exist on the public_catalog
   * projection, not the legacy `listPublicArtifacts` path.
   */
  sort?: "recent" | "featured" | "stars" | "name" | "rating" | "trending" | "installs" | "updated";
  tag?: string;
  author?: string;
  /** The filters below are `fields=lean`-only (public_catalog columns);
   * all optional, all combine with AND. */
  category?: string;
  hasLicense?: boolean;
  verified?: boolean;
  maturity?: string;
  badge?: string;
  hasReviews?: boolean;
  /** Only rows whose repo was pushed within this many days. */
  maxAgeDays?: number;
}

export interface ListPublicArtifactsResponse {
  items: PublicArtifact[];
  nextCursor: string | null;
}

/** Lean list response served from public_catalog (fields=lean). */
export interface ListArtifactSummariesResponse {
  items: PublicArtifactSummary[];
  nextCursor: string | null;
}

/**
 * GET /api/public/artifacts/counts — live total + per-kind counts of the
 * public catalog (visibility='public' only; unlisted/private excluded,
 * same gating as every other public listing surface). Backs the
 * registry's homepage/404/OG-image count chips, replacing the
 * build-time-baked fallback.json snapshot those pages used to read.
 */
export interface PublicArtifactCountsResponse {
  total: number;
  byKind: Record<ArtifactKind, number>;
  /**
   * Every distinct non-null `category` present in the public catalog,
   * sorted ascending. Backs the registry browse page's category filter
   * dropdown so it lists every catalog category (not just the ones on the
   * current page/search result).
   */
  categories: string[];
  /**
   * Per-category public-artifact counts keyed by category slug (see
   * shared/categories.ts). Additive: absent from older portals, so
   * consumers must treat it as optional.
   */
  categoryCounts?: Record<string, number>;
}

/**
 * POST /api/public/feedback — anonymous feedback relayed by the registry's
 * server-side proxy (token-gated with the `reviews:write` registry scope;
 * browsers never call the portal directly). `contact` is an optional
 * self-reported identity ("name or GitHub handle") for follow-up.
 */
export interface PublicFeedbackRequest {
  category: "bug" | "idea" | "general";
  body: string;
  pageUrl?: string | null;
  contact?: string | null;
}

export interface PublicFeedbackResponse {
  ok: true;
  id: string;
}

/**
 * GET /api/public/artifacts/author-summary?handle=<h> — live whole-catalog
 * total/star/per-kind aggregates for one author (visibility='public' only,
 * same gating as PublicArtifactCountsResponse). Backs the registry author
 * page's stat chips, which used to be computed client-side over just the
 * first 48-item page of that author's artifacts (`fetchByAuthor`) — wrong
 * for any author with more than 48 public artifacts. `fetchByAuthor` still
 * backs the actual listed items on that page; this is only the totals.
 */
export interface PublicAuthorSummaryResponse {
  total: number;
  totalStars: number;
  byKind: Record<ArtifactKind, number>;
}

/**
 * GET /api/public/artifacts/stats?ids=<id1,id2,…> (comma-separated, ≤100 —
 * excess ids are dropped, not rejected). Batched volatile stats (ratings,
 * installs, trending, eval verdict, behavioral score) for the ids a caller
 * already has from a prior catalog/lean fetch — see ArtifactCardStats.
 */
export interface ArtifactStatsResponse {
  stats: Record<string, ArtifactCardStats>;
}

/** Sort modes for ranked artifact search. */
export type SearchSort = "best" | "installs" | "rating" | "trending" | "updated" | "newest";

/** Why a result earned its slot — rendered as badges (registry) / "why" (MCP). */
export type RankReason =
  | "exact-match"
  | "top-pick"
  | "popular"
  | "trending"
  | "curated"
  | "well-reviewed"
  | "eval-passed"
  | "eval-warning";

/** Query for GET /api/public/artifacts/search. */
export interface SearchArtifactsQuery {
  q: string;
  kind?: ArtifactKind;
  sort?: SearchSort;
  limit?: number;
}

/** A ranked search result: the public artifact plus ranking metadata. */
export type RankedArtifact = PublicArtifact & {
  rank: number;
  relevanceTier: 1 | 2 | 3 | 4;
  why: RankReason[];
};

/** Response for GET /api/public/artifacts/search. */
export interface SearchArtifactsResponse {
  items: RankedArtifact[];
  total: number;
  /** True when results came from a degraded fallback (e.g. MCP portal outage). */
  degraded?: boolean;
}

export interface GetPublicArtifactResponse {
  artifact: PublicArtifact;
  reviewSummary: PublicReviewSummary;
}

// ─── Reviews ────────────────────────────────────────────────────────────────

export interface SubmitReviewRequest {
  artifactId: string;
  rating: number;
  title?: string | null;
  body: string;
  authorName: string;
  authorHandle?: string | null;
  /**
   * When set, the calling service (registry) has verified the reviewer's
   * identity out-of-band — e.g. via its own GitHub OAuth flow. The
   * portal trusts the registry to have done that check and persists
   * `verified_user=1`, pinning authorName/handle/avatar to these
   * fields instead of the untrusted client-supplied ones.
   */
  verifiedAuthor?: {
    githubId: number;
    githubLogin: string;
    name: string | null;
    avatarUrl: string | null;
  } | null;
}

export interface SubmitReviewResponse {
  ok: true;
  review: PublicReview;
}

/** Why a review submission was rejected by the deterministic PII gate. */
export type ReviewModerationCode = "pii";

/**
 * Returned (HTTP 422) when the PII gate blocks a submission — high-confidence
 * personal data (email, card, context-gated SSN). The registry relays `code`
 * + `error` so the browser can show a specific, recoverable message and
 * preserve the author's draft. Lower-confidence hits (phone) are held for
 * moderation instead and still return SubmitReviewResponse.
 */
export interface ReviewModerationRejection {
  ok: false;
  code: ReviewModerationCode;
  error: string;
}

export interface ListPublicReviewsResponse {
  items: PublicReview[];
  summary: PublicReviewSummary;
}

// ─── CLI install ────────────────────────────────────────────────────────────

export interface CliInstallResponse {
  artifact: PublicArtifact;
  tarballUrl: string;
  installToken: string;
  /** Per-install API key for telemetry. */
  ingestApiKey: string;
  installId: string;
}

export interface CliRegisterInstallRequest {
  installId: string;
  artifactId: string;
  host: string;
  platform: string;
  cliVersion: string;
}

// ─── Telemetry ingest ───────────────────────────────────────────────────────

export type { IngestBatch, IngestResponse };

// ─── Admin: registry tokens ─────────────────────────────────────────────────

export interface CreateRegistryTokenRequest {
  name: string;
  scopes: RegistryTokenScope[];
}

// ─── Observability rollups ──────────────────────────────────────────────────

export interface ArtifactObservabilityResponse {
  windowDays: number;
  totals: {
    invocations: number;
    uniqueInstalls: number;
    errorRate: number;
    p50DurationMs: number;
    p95DurationMs: number;
    p99DurationMs: number;
  };
  /** Same totals over the immediately-preceding window of the same length. */
  previousTotals?: {
    invocations: number;
    uniqueInstalls: number;
    errorRate: number;
    p50DurationMs: number;
    p95DurationMs: number;
    p99DurationMs: number;
  };
  models: Array<{ model: string; count: number }>;
  tools: Array<{ tool: string; count: number }>;
  handoffs: Array<{ to: string; count: number }>;
  hosts: Array<{ host: string; count: number }>;
  versions?: Array<{ version: string | null; count: number }>;
  /** Last N invocations, newest first. */
  recent?: Array<{
    spanId: string;
    startMs: number;
    durationMs: number;
    status: "ok" | "error" | "timeout";
    errorMessage: string | null;
    model: string | null;
    host: string;
    version: string | null;
    handoffTo: string | null;
    tools: string[];
  }>;
  /** Most recent error messages with frequency + last-seen timestamp. */
  recentErrors?: Array<{
    message: string;
    count: number;
    lastMs: number;
    host: string | null;
  }>;
  /** 7×24 grid of invocation counts. rows = day-of-week (Mon=0), cols = hour UTC. */
  hourOfDay?: number[][];
}
