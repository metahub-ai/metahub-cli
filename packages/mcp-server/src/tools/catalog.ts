/**
 * `metahub://catalog` — a browse-oriented view of the public catalog,
 * for clients that stream a resource into context ("summarize what's
 * new", "group skills by category").
 *
 * Same root cause as `get.ts`: this read used to be backed exclusively
 * by the baked `registry.json`, which is never served over HTTP, so the
 * resource failed for every caller in production. It now reads the
 * portal's public catalog endpoint, with the baked snapshot kept as an
 * optional fallback for self-hosters.
 *
 * Two deliberate bounds, both learned from the registry app's own
 * history (it deleted its request-time catalog read after a 40-70 MB
 * per-request payload took the site down — see
 * `apps/registry/src/lib/registry/index.ts`):
 *
 *   1. **Ask the portal for less.** `fields=lean` returns
 *      `PublicArtifactSummary` instead of the full record, which drops
 *      `readme` (~76% of the bytes) and `behavioralSummary` (~15%) at
 *      the source: measured 73 KB in 0.43s against 4.9 MB in 8.1s for
 *      the default projection. Projecting client-side would have cut
 *      only the model-context cost while leaving the wire, the portal
 *      query and the 8s — uncomfortably close to the portal client's
 *      15s timeout, and the default projection sets no cache headers.
 *      Callers wanting a full record use `metahub_get`.
 *   2. **Bounded paging.** Lean pages are cheap, but a resource read
 *      still lands whole in a model context window, so we stop at
 *      {@link CATALOG_MAX_ITEMS} and set `truncated`.
 */
import { listPublicArtifacts } from "@metahub/installer";
import type { ItemKind } from "../types.js";
import { fetchRegistry, fallbackAvailable } from "../registry-client.js";

/** Portal page size requested per call. */
const PAGE_SIZE = 200;

/** Ceiling on artifacts pulled into one resource read. */
export const CATALOG_MAX_ITEMS = 200;

/** Descriptions are clipped for the same reason they are in search. */
const DESCRIPTION_MAX = 280;

export interface CatalogEntry {
  kind: unknown;
  slug: unknown;
  name: unknown;
  tagline: string;
  description: string;
  category: unknown;
  tags: unknown;
  version: unknown;
  repoUrl: unknown;
  installCount: unknown;
  rating: unknown;
  publishedAt: unknown;
}

export interface CatalogResult {
  items: CatalogEntry[];
  generatedAt: string;
  /**
   * Kind breakdown **of the returned page**, not of the whole catalog.
   * Named to say so: when `truncated` is true, a caller reading this as
   * a catalog-wide total would be wrong.
   */
  pageCounts: Record<ItemKind, number>;
  /** True when the portal was unreachable and this came from the baked catalog. */
  degraded: boolean;
  /** True when the catalog holds more than this one page. */
  truncated: boolean;
  /** Set when truncated, so the AI knows this is not the whole catalog. */
  note?: string;
}

export interface CatalogOpts {
  /** Test seam — override the live portal listing. */
  portalList?: typeof listPublicArtifacts;
  /** Test seam — override the baked-catalog loader. */
  registryLoader?: () => Promise<{
    items: unknown[];
    generatedAt: string;
    counts: Record<ItemKind, number>;
  }>;
  /** Test seam — override "is a baked catalog configured?". */
  registryConfigured?: () => boolean;
  /** Test seam — shrink the ceiling so paging is cheap to assert. */
  maxItems?: number;
}

function clip(s: unknown): string {
  const text = typeof s === "string" ? s.trim() : "";
  return text.length > DESCRIPTION_MAX ? `${text.slice(0, DESCRIPTION_MAX - 1)}…` : text;
}

/**
 * Project a catalog record down to what a browse view actually needs.
 *
 * Handles both shapes this resource can serve: the portal's lean
 * `PublicArtifactSummary` (`shortDescription`, `repoUrl`, `installCount`)
 * and a baked `RegistryItem` from the degraded path, which spells the
 * same facts differently (`description`, `source.url`,
 * `ratingSummary.avg`). Reading only the portal spelling would hand the
 * self-hoster a catalog of `repoUrl: null, rating: null` on precisely
 * the path the fallback exists to serve.
 */
function slim(raw: unknown): CatalogEntry {
  const a = (raw ?? {}) as Record<string, unknown>;
  const source = (a.source ?? {}) as Record<string, unknown>;
  const ratingSummary = (a.ratingSummary ?? {}) as Record<string, unknown>;
  return {
    kind: a.kind,
    slug: a.slug,
    name: a.displayName ?? a.name,
    tagline: clip(a.tagline),
    description: clip(a.shortDescription ?? a.description),
    category: a.category ?? null,
    tags: a.tags ?? [],
    version: a.version ?? null,
    repoUrl: a.repoUrl ?? source.url ?? null,
    installCount: a.installCount ?? 0,
    rating: a.avgRating ?? ratingSummary.avg ?? null,
    publishedAt: a.publishedAt ?? a.updatedAt ?? null,
  };
}

function countByKind(items: Array<{ kind?: unknown }>): Record<ItemKind, number> {
  const counts: Record<ItemKind, number> = { skill: 0, mcp: 0, agent: 0, plugin: 0 };
  for (const item of items) {
    const k = item.kind;
    if (k === "skill" || k === "mcp" || k === "agent" || k === "plugin") counts[k] += 1;
  }
  return counts;
}

export async function fetchCatalog(opts: CatalogOpts = {}): Promise<CatalogResult> {
  const list = opts.portalList ?? listPublicArtifacts;
  const maxItems = opts.maxItems ?? CATALOG_MAX_ITEMS;
  try {
    const raw: unknown[] = [];
    let cursor: string | null = null;
    let more = false;
    do {
      const params: Record<string, string> = { limit: String(PAGE_SIZE), fields: "lean" };
      if (cursor) params.cursor = cursor;
      const page = await list(params);
      raw.push(...page.items);
      cursor = page.nextCursor ?? null;
      if (raw.length >= maxItems) {
        raw.length = maxItems;
        more = cursor !== null;
        break;
      }
    } while (cursor);
    const items = raw.map(slim);
    const truncated = more;
    return {
      items,
      generatedAt: new Date().toISOString(),
      pageCounts: countByKind(items),
      degraded: false,
      truncated,
      ...(truncated
        ? {
            note:
              `Showing ${items.length} artifacts; the catalog is larger. Counts describe this ` +
              `page only — use metahub_search for anything not listed here, and metahub_get ` +
              `for a full record.`,
          }
        : {}),
    };
  } catch (err) {
    if (!fallbackAvailable(opts)) throw err;
    const loader = opts.registryLoader ?? (() => fetchRegistry());
    const registry = await loader();
    const items = registry.items.map(slim);
    return {
      items,
      generatedAt: registry.generatedAt,
      pageCounts: registry.counts,
      degraded: true,
      truncated: false,
    };
  }
}
