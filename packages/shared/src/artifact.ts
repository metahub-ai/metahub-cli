/**
 * Core artifact types. These are the things a developer publishes
 * through the portal and the registry catalogs.
 */

export type ArtifactKind = "skill" | "mcp" | "agent" | "plugin";

export type Visibility = "private" | "unlisted" | "public";

export interface Author {
  handle: string;
  name?: string;
  url?: string;
  avatarUrl?: string;
}

/**
 * The manifest a developer commits to their repo root as `metahub.json`,
 * or that the portal infers from `SKILL.md` frontmatter / `package.json`
 * conventions.
 */
export interface ArtifactManifest {
  name: string;
  slug: string;
  kind: ArtifactKind;
  description: string;
  version: string;
  author?: Author;
  homepage?: string;
  license?: string;
  tags?: string[];
}

/**
 * Internal row stored in portal SQLite. Includes secrets (API key) so
 * never project this shape to anyone outside the artifact owner.
 */
export interface Artifact {
  id: string;
  name: string;
  slug: string;
  kind: ArtifactKind;
  description: string;
  version: string | null;
  /** Per-artifact API key the SDK uses to ingest telemetry. */
  apiKey: string;
  createdMs: number;
  visibility: Visibility;
  /** Set when the portal has accepted the artifact for the public registry. */
  verifiedMs: number | null;
  verifiedByUserId: string | null;
  verifyMessage: string | null;
  /** The GitHub repo the artifact lives in. Required in iteration 1. */
  repoUrl: string;
  repoBranch: string | null;
  /**
   * Sub-directory within the repo. Empty string / null means the
   * artifact lives at repo root. Set for monorepos like
   * `anthropics/skills` where each skill is under `skills/<slug>/`.
   */
  repoPath?: string | null;
  /** The SHA that was last successfully published. */
  publishedSha: string | null;
  /** ISO 8601 timestamp of the last publish. */
  publishedAt: string | null;
  createdByUserId: string | null;
  /**
   * Curator metadata. `isCurated` is true when the row was created by
   * the bulk-import curator pipeline (owned by `usr_curator_metahub`)
   * rather than an authenticated developer onboarding their own repo.
   * `curatorSource` is a free-form tag describing where the row came
   * from (e.g. `csv:2026-05-22`). `curatorStatus` tracks the
   * import-pipeline lifecycle. All three are null/false on
   * developer-owned rows.
   */
  isCurated: boolean;
  curatorSource: string | null;
  curatorStatus: "pending" | "evaled" | "imported" | "rejected" | "error" | null;
  /**
   * Lifecycle stage chosen by the publisher (experimental / beta /
   * stable / deprecated). Drives a prominent badge on the registry
   * detail page. Null on legacy rows; the public projection coerces
   * null to "stable" so the type stays narrow on the read side.
   */
  maturity?: "experimental" | "beta" | "stable" | "deprecated" | null;
}

/**
 * Display metadata a developer can edit in the portal independent of
 * the manifest in their repo. Iteration 1 keeps this thin; we add more
 * fields when the portal needs them.
 */
export interface ArtifactInfo {
  artifactId: string;
  displayName: string | null;
  tagline: string | null;
  longDescription: string | null;
  logoUrl: string | null;
  category: string | null;
  tags: string[];
  supportUrl: string | null;
  docsUrl: string | null;
  /**
   * AI tools / IDEs the publisher has actually verified this artifact
   * works with (Claude Code, Cursor, Antigravity, etc.). The registry
   * surfaces this on the detail page as a "Works with" badge list.
   * When empty/null the registry falls back to sensible defaults per
   * kind so older artifacts still render something useful.
   */
  supportedClients: string[];
  /**
   * Raw markdown body the onboarding-enrichment service pulled from
   * GitHub at publish time. For skills this is the SKILL.md body with
   * YAML frontmatter stripped; for plugin / mcp / agent it's the
   * artifact-scoped README.md (or the repo-root README as a fallback).
   * The registry detail page renders this as the "About" / "Contents"
   * section. Kept separate from longDescription so an author-authored
   * editorial blurb is never clobbered by a re-enrich.
   */
  readme: string | null;
  /** SHA the readme body was pulled from. */
  readmeSourceSha: string | null;
  /** Unix ms when readme was last fetched (lets backfill skip fresh rows). */
  readmeFetchedMs: number | null;
  updatedMs: number;
}
