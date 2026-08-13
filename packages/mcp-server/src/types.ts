/**
 * Local types for the MCP server. Mirrors the shape the registry app
 * bakes into `.cache/registry.json` — we keep a minimal subset here
 * rather than depend on the registry app (which is forbidden by the
 * monorepo boundary) and re-export `ArtifactKind` from `@metahub/shared`
 * so the wire-format contract stays canonical.
 *
 * TODO: consolidate `RegistryItem` / `Registry` into `@metahub/shared`
 * once the registry app is ready to consume them from there. The
 * registry's own `apps/registry/src/lib/registry/types.ts` is the
 * source of truth for now.
 */
import type { ArtifactKind } from "@metahub/shared";

export type ItemKind = ArtifactKind;

export interface Author {
  handle: string;
  name: string;
  url?: string;
  avatarUrl?: string;
}

export interface ItemSource {
  type: "github" | "npm" | "seed";
  url: string;
  repo?: string;
  path?: string;
  ref?: string;
}

export interface InstallSnippet {
  label: string;
  command: string;
}

export interface ReviewSummary {
  avg: number;
  count: number;
  distribution: number[];
}

/**
 * Catalog entry. Field set deliberately narrow — only what the four
 * tools we expose actually surface. The full registry shape has
 * dozens more fields; consumers wanting them should call
 * `metahub_get` and parse the raw record.
 */
export interface RegistryItem {
  slug: string;
  kind: ItemKind;
  name: string;
  tagline: string;
  description: string;
  tags: string[];
  author: Author;
  source: ItemSource;
  version?: string;
  license?: string;
  homepage?: string;
  install?: InstallSnippet[];
  updatedAt: string;
  popularity?: number;
  ratingSummary?: ReviewSummary;
  [key: string]: unknown;
}

export interface Registry {
  items: RegistryItem[];
  generatedAt: string;
  counts: Record<ItemKind, number>;
}
