/**
 * Registry-safe projections. Strip secrets + PII. These are what
 * leaves the portal over /api/public/*.
 */
import type { ArtifactKind, Visibility } from "./artifact.js";
import type { BadgeId } from "./badges.js";
import type { EvalCheck, EvalCheckCategory, EvalCheckStatus } from "./eval.js";

export interface PublicArtifact {
  id: string;
  slug: string;
  name: string;
  kind: ArtifactKind;
  description: string;
  version: string | null;
  visibility: Extract<Visibility, "public" | "unlisted">;
  repoUrl: string;
  repoBranch: string | null;
  /** Sub-path within the repo; null/"" means repo root. */
  repoPath?: string | null;
  publishedSha: string | null;
  publishedAt: string | null;
  /** Joined from ArtifactInfo when available. */
  displayName: string | null;
  tagline: string | null;
  longDescription: string | null;
  logoUrl: string | null;
  category: string | null;
  tags: string[];
  supportUrl: string | null;
  docsUrl: string | null;
  /**
   * AI tools / IDEs the publisher attests this artifact works with.
   * Empty means "no claim made" — the registry falls back to its own
   * kind-aware default list.
   */
  supportedClients: string[];
  /**
   * Lifecycle stage of this artifact. Drives a prominent badge on
   * the registry detail page so consumers know whether they're
   * installing something experimental or actively maintained.
   * "stable" is the default when the publisher hasn't set anything.
   */
  maturity: "experimental" | "beta" | "stable" | "deprecated";
  /**
   * Raw README/SKILL.md body pulled from GitHub at onboarding time by
   * the enrichment service. The registry renders this directly on the
   * detail page so consumers see real documentation instead of an
   * empty "About" stub. Null when enrichment hasn't run yet or the
   * source repo had no readable readme.
   */
  readme: string | null;
  /** GitHub author, derived from repoUrl. */
  authorHandle: string | null;
  /**
   * Kind-specific facts captured from the eval evidence at publish
   * time. The registry surfaces these on the detail page (skill
   * triggers, MCP tool names, plugin bundles) so consumers see the
   * actual shape of what they're installing.
   */
  kindFacts?: PublicKindFacts | null;
  /**
   * Quality badges earned by this artifact. Static badges are baked
   * in at publish time; live badges (battle-tested, well-reviewed,
   * actively-maintained) are recomputed on every public API read so
   * they stay fresh.
   */
  badges: BadgeId[];
  /**
   * True when this artifact was onboarded by MetaHub on the author's
   * behalf (CSV import). Real-owner publishes set this back to false.
   */
  isCurated?: boolean;
  /**
   * Latest behavioral-evaluation summary, when one exists. Populated
   * from the most recent `done` behavioral_eval_jobs row for this
   * artifact. Null/undefined means the artifact hasn't been
   * behaviorally evaluated yet (or the runner hasn't completed a job
   * since publish).
   */
  behavioralSummary?: BehavioralSummary | null;
  /**
   * Rollup of the artifact's most recent eval run. Present whenever
   * an eval has executed against the artifact — usually the run that
   * accompanied the latest publish. Use this for a quick status pill;
   * fetch /api/public/eval-reports?artifactId=… for the full check
   * breakdown.
   */
  latestEval?: PublicEvalSummary;
  /**
   * True when an admin has marked this artifact as featured (editorial
   * promotion). The registry renders featured artifacts in a curated
   * strip on the homepage.
   */
  featured?: boolean;
  /**
   * Admin-assigned display order within the featured set (lower = higher).
   * Null when featured but not yet explicitly ordered; sort those last.
   */
  featuredRank?: number | null;

  /** COUNT(DISTINCT install_id) — cumulative installs. Computed inline at read time. */
  installCount?: number;
  /** Installs in the trailing 30 days (velocity / trending input). */
  installs30d?: number;
  /** AVG(rating) over non-hidden reviews (raw, for reference). */
  avgRating?: number | null;
  /** Bayesian-shrunk rating (display + ranking). See @metahub/shared bayesRating(). */
  bayesRating?: number | null;
  /** HN-style trending score (velocity / time-decay). */
  trendingScore?: number;
  /** GitHub stars from the latest eval's repoMeta (cold-start bootstrap floor). */
  githubStars?: number;
}

/**
 * Volatile per-artifact stats — ratings/installs/quality signals that change
 * without an artifact mutation (a new review, a new install, a nightly eval
 * re-run). Deliberately NOT part of PublicArtifact / PublicArtifactSummary
 * (the stable projections cached long-TTL); served instead in a batch by
 * `GET /api/public/artifacts/stats?ids=…` so a page renders its cached card
 * grid once and fetches live numbers with one short-TTL request. Every id the
 * caller asks for gets an entry — ids with no rows anywhere still get a
 * zero/null-filled one (see `getArtifactCardStatsBulk`).
 */
export interface ArtifactCardStats {
  /** AVG(rating) over non-hidden reviews. Null when the artifact has none. */
  ratingAvg: number | null;
  /** COUNT(*) of non-hidden reviews. */
  ratingCount: number;
  /** COUNT(DISTINCT install_id), cumulative. */
  installCount: number | null;
  /** Installs in the trailing 30 days (velocity / trending input). */
  installs30d: number | null;
  /** HN-style trending score (velocity / time-decay). See @metahub/shared trendingScore(). */
  trendingScore: number | null;
  /** Worst-of pass/warn/fail from the latest eval run. Null when no eval has run yet. */
  evalVerdict: "pass" | "warn" | "fail" | null;
  /** Latest DONE behavioral-eval overallScore (0–10). Null when none has completed. */
  behavioralScore: number | null;
}

/**
 * Lean list projection — display + badge fields only. Deliberately EXCLUDES
 * readme and long_description (the large text columns that made list payloads
 * exceed Next's 2MB cache limit). Served from the portal's public_catalog table.
 */
export interface PublicArtifactSummary {
  id: string;
  kind: ArtifactKind;
  slug: string;
  name: string;
  tagline: string | null;
  shortDescription: string;
  logoUrl: string | null;
  stars: number | null;
  lastPushMs: number | null;
  latestRelease: string | null;
  authorHandle: string | null;
  tags: string[];
  badges: BadgeId[];
  featured: boolean;
  featuredRank: number | null;
  verifiedMs: number | null;
  installCount: number | null;
  createdMs: number;
  /** Joined from artifact_info. */
  category: string | null;
  /** GitHub repo license SPDX id (or free-form name), when known. */
  license: string | null;
  /** GitHub fork count, when known. */
  forks: number | null;
  /** Primary GitHub-detected language, when known. */
  language: string | null;
  /**
   * True when this artifact was onboarded by MetaHub on the author's
   * behalf (CSV import). Real-owner publishes set this back to false.
   */
  isCurated: boolean;
  /** Lifecycle stage. Null means the publisher hasn't set one. */
  maturity: "experimental" | "beta" | "stable" | "deprecated" | null;
  /**
   * Commit SHA the current release was published at. Drives the card's
   * CommitChip ("#sha7", "pinned to this commit") — a rendered trust
   * signal with no other lean source. Non-null for every projected row
   * (the projection's inclusion gate requires published_sha IS NOT NULL).
   */
  publishedSha: string | null;
  /** GitHub repo URL — Phase 2b builds the card's source.repo/source.url from it. */
  repoUrl: string | null;
  /** Sub-path within the repo (source.path); null/"" means repo root. */
  repoPath: string | null;
}

/**
 * Lightweight eval roll-up returned alongside each PublicArtifact and
 * via the eval-reports endpoint as the `summary` field. Drives badge /
 * pill rendering on the registry detail page without needing the full
 * report.
 */
/**
 * The consumer-facing truth about an artifact's behavioral evaluation,
 * without the verdict itself.
 *
 *   published    results are visible in this report.
 *   queued       a job is waiting for the worker right now.
 *   running      a job is executing right now.
 *   unpublished  a run finished but its results are not public.
 *   unavailable  no run has produced results — never evaluated, or the
 *                sandbox could not run it (missing credentials,
 *                unsupported build). Not a verdict about the artifact.
 *
 * Exists because the visibility gate used to mask BOTH hidden verdicts
 * and environment failures as "queued" — a promise of results that
 * were never coming, on more than half the catalog.
 */
export type BehavioralPublicState =
  "published" | "queued" | "running" | "unpublished" | "unavailable";

export interface PublicEvalSummary {
  jobId: string;
  /** Worst-of pass/warn/fail across LIVE checks (queued behavioral excluded). */
  overall: EvalCheckStatus;
  /** Commit SHA the eval ran against. */
  capturedSha: string | null;
  /** Wall-clock end of the eval run. */
  finishedAt: string | null;
  /**
   * Per-category counts. The "queued" bucket aggregates pending
   * behavioral entries (status: pass + pending: true) — the registry
   * can render them distinctly without parsing the full check list.
   */
  counts: Record<
    EvalCheckCategory,
    { pass: number; warn: number; fail: number; queued: number; total: number }
  >;
  /**
   * Coarse behavioral lifecycle for consumers. Optional: older portal
   * deployments omit it, and consumers fall back to the queued-bucket
   * heuristic.
   */
  behavioralState?: BehavioralPublicState;
}

/**
 * Full categorized eval report exposed via
 *   GET /api/public/eval-reports?artifactId=<id>
 * or
 *   GET /api/public/eval-reports?kind=<k>&slug=<s>
 *
 * Always reflects the LATEST eval run for the artifact — there's no
 * history endpoint yet; older runs live in eval_jobs but aren't
 * publicly exposed. The summary field is the same shape returned
 * alongside PublicArtifact.latestEval so consumers can dedupe rendering.
 */
/** Per-dimension averaged scores (0–10) across a behavioral run. */
export interface BehavioralDimensions {
  correctness: number;
  instruction_adherence: number;
  safety: number;
  latency: number;
}

/**
 * A single behavioral test case projected for public display. Carries
 * the prompt + the judge's verdict fields, but never the raw transcript
 * (size + may leak repo output).
 */
export interface BehavioralTestReport {
  prompt: string;
  pass: boolean;
  rationale: string;
  safetyFlags: string[];
  scores: BehavioralDimensions;
}

/**
 * Public-facing summary of the latest behavioral evaluation for an
 * artifact. Produced by the async behavioral-eval worker and surfaced
 * on the registry detail page. Absent when an artifact has never been
 * behaviorally evaluated (e.g. legacy artifacts published before the
 * behavioral engine landed).
 */
export interface BehavioralSummary {
  /**
   * Lifecycle of the latest behavioral-eval job for this artifact.
   *
   * `failed` and `throttled` are states the DEVELOPER needs, and both
   * used to be invisible: a failed job made the summary null, so the
   * section read "will run after publish" as though nothing had ever
   * happened, and a quota refusal was returned by the enqueue and
   * rendered nowhere at all. A developer could not tell a slow queue
   * from a broken worker from having hit their own limit — three
   * situations with three different next actions.
   */
  status: "queued" | "running" | "done" | "failed" | "throttled";
  /**
   * Why the enqueue was refused, when `status` is `throttled`.
   *
   * `scope` distinguishes the developer's own rolling limit from the
   * system-wide ceiling — one they can wait out, the other needs an
   * operator.
   */
  quota?: { scope: "user" | "global"; used: number; limit: number };
  /** One line on why the run failed, when `status` is `failed`. */
  failureReason?: string;
  /** Did the artifact pass the judge across all test cases? */
  passed: boolean;
  /** Did the deterministic safety scan + judge find it free of unsafe actions? */
  safe: boolean;
  /** Aggregate 0–10 score across the judged dimensions. */
  overallScore: number;
  /**
   * Spread on `overallScore`. The driver is a stochastic model, so the
   * score is an estimate: `halfWidth` is the 95% half-interval on the
   * 0–100 scale (render `overallScore ± halfWidth/10`), and `precise` is
   * false when too few samples support a point estimate. Present on done
   * runs; absent on older cached payloads.
   */
  scoreConfidence?: { halfWidth: number; sampleSize: number; precise: boolean };
  /** How many behavioral test cases were run. */
  testCount: number;
  /** Mean of each dimension across tests (0–10, one decimal). Done runs only. */
  dimensions?: BehavioralDimensions;
  /** Per-case judge reports (prompt + verdict, no transcript). Done runs only. */
  tests?: BehavioralTestReport[];
}

export interface PublicEvalReport {
  jobId: string;
  artifactId: string | null;
  repoUrl: string;
  repoBranch: string;
  capturedSha: string | null;
  startedAt: string;
  finishedAt: string | null;
  summary: PublicEvalSummary;
  /** Selected detection's checks (categorized + pending where applicable). */
  checks: EvalCheck[];
  /**
   * For multi-artifact monorepos, every detection's checks indexed by
   * detectionId. The registry can let users pivot to a sibling artifact
   * inside the same repo without re-fetching.
   */
  checksByDetection?: Record<string, EvalCheck[]>;
  /** Detection the summary + checks refer to. Null when no detection was selected. */
  selectedDetectionId: string | null;
  /**
   * Subset of repo metadata the eval captured. Lets the registry skip
   * one round-trip to GitHub when rendering "★ 5,432 · Markdown · MIT"
   * pills next to the report.
   */
  repoMeta?: {
    stars: number;
    forks: number | null;
    language: string | null;
    license: string | null;
    homepage: string | null;
    pushedMs: number | null;
    topics: string[];
  } | null;
}

/** Reusable shape: a named MCP/agent surface with an optional description. */
export interface NamedEntry {
  name: string;
  description?: string;
}

export type PublicKindFacts =
  | {
      kind: "skill";
      /** "use this when …" trigger phrases from SKILL.md frontmatter. */
      triggers: string[];
      /** SKILL.md body length, excluding frontmatter. */
      bodyLen: number;
      /**
       * First substantive paragraph of the SKILL.md body — surfaced as
       * an "About this artifact" block on the registry detail page so
       * consumers see a focused description without us dumping the full
       * (often instructional) SKILL.md.
       */
      introParagraph?: string;
      /** `allowed-tools` from SKILL.md frontmatter. */
      allowedTools?: string[];
      /** H2 section titles, in document order. */
      sectionTitles?: string[];
    }
  | {
      kind: "mcp";
      /** Names extracted by greping `.tool("…")` in src/server.ts etc. */
      toolNames: string[];
      binNames: string[];
      hasMcpSdk: boolean;
      isEsmModule: boolean;
      /** Tools with descriptions parsed from `.tool("name", "desc", …)`. */
      tools?: NamedEntry[];
      /** Resources with descriptions. */
      resources?: NamedEntry[];
      /** Prompts with descriptions. */
      prompts?: NamedEntry[];
    }
  | {
      kind: "plugin";
      bundledSkillNames: string[];
      bundledSkillsCount: number;
      hasMcpServer: boolean;
      /** Bundled sub-skills with descriptions read from each SKILL.md. */
      bundledSkillSummaries?: NamedEntry[];
      /** Hook names declared by the plugin. */
      hooks?: string[];
      /** Slash command names with descriptions. */
      commandSummaries?: NamedEntry[];
      /** Subagent names with descriptions. */
      subagentSummaries?: NamedEntry[];
    }
  | {
      kind: "agent";
      entryFile: string | null;
      hasDefaultExport: boolean;
      /** Model preference declared in agent.json / md frontmatter. */
      model?: string | null;
      /** First line of the agent's instructions, truncated. */
      instructionsPreview?: string | null;
      /** Tool names + (optional) descriptions parsed from agent.json. */
      tools?: NamedEntry[];
      /**
       * True for a Claude-Code-style sub-agent defined by a markdown
       * file (`.claude/agents/<name>.md`) — the body is the agent, so
       * there is no entry file to run. Renderers should show the
       * instructions + tool scope instead of an entry-point row.
       */
      promptBased?: boolean;
      /** Tool names from `tools:` frontmatter (prompt-based agents). */
      toolsDeclared?: string[];
    };

export interface PublicReview {
  id: string;
  artifactId: string;
  rating: number;
  title: string | null;
  body: string;
  authorName: string;
  authorHandle: string | null;
  authorAvatar: string | null;
  verifiedUser: boolean;
  source: string;
  createdMs: number;
  /**
   * Publisher's response to this review, if any. One response per
   * review. Edits replace in place; `responseMs` is the timestamp
   * of the most recent edit.
   */
  response?: {
    body: string;
    respondedMs: number;
    respondedByHandle: string | null;
  } | null;
}

export interface PublicReviewSummary {
  count: number;
  avg: number;
  /** [1-star count, 2-star count, ..., 5-star count] */
  distribution: [number, number, number, number, number];
}

/**
 * A single publish release exposed via the public API. We only ship
 * non-yanked entries so consumers don't see a release history that
 * includes withdrawn versions.
 */
export interface PublicRelease {
  releaseId: string;
  artifactId: string;
  /** Captured git SHA at publish time. */
  sha: string;
  /** Manifest version at publish time (may be null for legacy releases). */
  version: string | null;
  /** Eval overall outcome at publish time. */
  evalOverall: "pass" | "warn" | "fail";
  /** Unix ms when this release was published. */
  publishedMs: number;
}
