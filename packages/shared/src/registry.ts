/**
 * Cross-package registry contract. The registry app bakes
 * `.cache/registry.json` to this shape; the MCP server, CLI, and
 * other downstream consumers read it.
 *
 * Kept deliberately narrow — only the fields downstream consumers
 * actually need to function. The registry app extends `RegistryItem`
 * with its own UI-only fields (badges, reviews, kindFacts, …) in
 * `apps/registry/src/lib/registry/types.ts`.
 */
import type { ArtifactKind } from "./artifact.js";

/** Re-export under the registry-domain name the registry/MCP code uses. */
export type ItemKind = ArtifactKind;

/**
 * The author of a registry item. `name` is required here (unlike
 * {@link Author} in `artifact.ts`, where it is optional) because the
 * registry build always populates it from the upstream source.
 */
export interface RegistryAuthor {
  handle: string;
  name: string;
  url?: string;
  avatarUrl?: string;
}

export interface RegistryItemSource {
  type: "github" | "npm" | "seed";
  url: string;
  repo?: string;
  path?: string;
  ref?: string;
}

export interface RegistryInstallSnippet {
  label: string;
  command: string;
}

export interface RegistryReviewSummary {
  avg: number;
  count: number;
  /** Histogram: index 0 = 1-star count … index 4 = 5-star count. */
  distribution: number[];
}

/**
 * Catalog entry. Field set deliberately narrow — only what
 * cross-package consumers (MCP server, CLI) need. The registry app's
 * extended shape lives in `apps/registry/src/lib/registry/types.ts`
 * and is a structural superset of this type.
 */
export interface RegistryItem {
  slug: string;
  kind: ItemKind;
  name: string;
  tagline: string;
  description: string;
  tags: string[];
  author: RegistryAuthor;
  source: RegistryItemSource;
  version?: string;
  license?: string;
  homepage?: string;
  install?: RegistryInstallSnippet[];
  updatedAt: string;
  popularity?: number;
  ratingSummary?: RegistryReviewSummary;
  /** Registry build-time composite score (popularity/quality). */
  score?: number;
  /** Editorially featured (admin). */
  featured?: boolean;
  /** Explicit admin ordering within the featured set (lower = higher). */
  featuredRank?: number | null;
}

export interface Registry {
  items: RegistryItem[];
  generatedAt: string;
  counts: Record<ItemKind, number>;
}

/**
 * Shape of one record in `~/.metahub/installs.json`. Matches what
 * the CLI's `packages/cli/src/lib/installs.ts` writes. Kept in sync
 * by convention — the CLI is the only writer.
 */
export interface InstalledRecord {
  artifactId: string;
  installId: string;
  slug: string;
  kind: ItemKind;
  version: string | null;
  installPath: string;
  ingestApiKey: string;
  publishedSha: string | null;
  installedAt: string;
}

export interface InstallStore {
  installs: InstalledRecord[];
}
