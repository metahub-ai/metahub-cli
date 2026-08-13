/**
 * Artifact findings — user-filed reports + automated rug-pull alerts.
 *
 * Two channels feed the same publisher inbox:
 *   - user reports from the registry detail page (kind="user").
 *     Anyone signed in can file; categorized by the reporter.
 *   - automated rug-pull alerts created at publish time when the
 *     new release deviates suspiciously from the previous one
 *     (kind="rugpull"). Currently triggered by: README removed,
 *     command tools surface expanded, or content shrank by >50%.
 *
 * Status lifecycle: open → triaged → resolved | dismissed. The
 * publisher works the inbox; closed findings are never deleted.
 */

export type FindingKind = "user" | "rugpull";

export type FindingCategory = "vuln" | "spam" | "abuse" | "quality" | "other" | "rugpull";

export type FindingSeverity = "low" | "medium" | "high";

export type FindingStatus = "open" | "triaged" | "resolved" | "dismissed";

/** A single inbox entry. */
export interface ArtifactFinding {
  findingId: string;
  artifactId: string;
  kind: FindingKind;
  category: FindingCategory;
  severity: FindingSeverity;
  title: string;
  body: string | null;
  /** Structured per-kind metadata. Stored as JSON, parsed on read. */
  evidence: Record<string, unknown> | null;
  reporterUserId: string | null;
  reporterHandle: string | null;
  status: FindingStatus;
  resolutionNote: string | null;
  releaseId: string | null;
  createdMs: number;
  updatedMs: number;
  resolvedMs: number | null;
}

export interface FindingCounts {
  open: number;
  triaged: number;
  resolved: number;
  dismissed: number;
}

/**
 * Shape consumers POST to /api/artifacts/[id]/findings from the
 * registry. Slimmed-down — categorization happens server-side.
 */
export interface ReportFindingRequest {
  category: Exclude<FindingCategory, "rugpull">;
  severity: FindingSeverity;
  title: string;
  body?: string;
}
