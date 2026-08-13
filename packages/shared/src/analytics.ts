/**
 * Analytics rollup shapes — the data the portal serves on the
 * artifact's analytics tab (funnel / retention / cohorts / top errors).
 *
 * All of these are pure aggregations over the existing `cli_installs`
 * and `spans` tables (no new event schema). The portal's
 * `lib/analytics-rollups.ts` computes them; the registry doesn't
 * need any of these shapes — they're publisher-facing.
 */

/**
 * Install funnel for a single artifact.
 *
 * `installed`  : number of unique installs created (rows in
 *                cli_installs)
 * `firstInvocation` : how many of those installs went on to actually
 *                produce at least one span. The drop-off between
 *                installed and firstInvocation = the "tried but never
 *                used" failure mode.
 * `weekActive` : how many produced a span in the last 7 days,
 *                relative to `now`. Approximates WAU.
 *
 * We compute over a configurable window so the developer can pivot
 * between "lifetime" and "last 30 days" funnels.
 */
export interface InstallFunnel {
  windowStartMs: number | null;
  windowEndMs: number;
  installed: number;
  firstInvocation: number;
  weekActive: number;
}

/**
 * Per-version install + retention. One row per published version
 * we've seen in `cli_installs`.
 *
 * `installed7d` / `installed30d` are install counts in those
 * relative windows; useful for the "version adoption curve" chart.
 *
 * `retained7d` is the count of installs at this version that had at
 * least one span in the 7 days following install. The ratio (retained
 * / installed) is the 7-day retention rate per version — drops the
 * second a regression lands.
 */
export interface VersionRetentionRow {
  version: string | null;
  /** First install we saw on this version. */
  firstSeenMs: number;
  /** Last install we saw on this version. */
  lastSeenMs: number;
  installed: number;
  installed7d: number;
  installed30d: number;
  retained7d: number;
}

/**
 * Cohort heatmap — installs grouped by ISO week of install, with
 * activity counts for weeks 0..N. Classic SaaS retention shape.
 *
 * `cohorts[i].weeklyActive[j]` = how many of the `cohorts[i].size`
 * installs had ≥1 span in cohort-week i + j.
 */
export interface CohortAnalysis {
  cohorts: Array<{
    /** ISO week start (Mon 00:00 UTC) as epoch ms. */
    cohortWeekMs: number;
    /** How many installs landed during this cohort week. */
    size: number;
    /** Activity counts week-0, week-1, …, capped at maxWeeks. */
    weeklyActive: number[];
  }>;
  /** Max cohort-week index we computed (also = weeklyActive.length). */
  maxWeeks: number;
}

/**
 * Top error rollups by (version, error_message). Used to spot
 * "v0.1.4 introduced a JSON parse error in 12% of invocations" cases.
 *
 * Sorted descending by `count` server-side; the dashboard renders the
 * first ~10.
 */
export interface TopErrorRow {
  version: string | null;
  errorMessage: string;
  count: number;
  /** Most recent timestamp this error was seen at, epoch ms. */
  lastSeenMs: number;
  /** Distinct installs that hit this error — privacy / blast-radius signal. */
  uniqueInstalls: number;
}

export interface TopErrorsByVersion {
  windowStartMs: number | null;
  windowEndMs: number;
  rows: TopErrorRow[];
}
