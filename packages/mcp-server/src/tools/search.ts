/**
 * `metahub_search` — ranked catalog search.
 *
 * Primary path: the live portal endpoint (GET /api/public/artifacts/search via
 * `@metahub/installer.searchPublicArtifacts`), which returns results already
 * ranked + filtered by the shared `rankArtifacts()` engine — so the CLI, the
 * registry, and this tool all order identically.
 *
 * Fallback: on portal outage we degrade to the baked registry.json, ranked with
 * the SAME engine (not a raw substring slice), and set `degraded: true` so the
 * caller can disclaim. This also fixes the long-standing bug where `installCount`
 * was actually GitHub stars — on the primary path it is now the real install
 * count from `PublicArtifact.installCount`.
 */
import { searchPublicArtifacts } from "@metahub/installer";
import {
  rankArtifacts,
  type RankableArtifact,
  type RankedArtifact,
  type SearchArtifactsQuery,
} from "@metahub/shared";
import type { ItemKind, Registry, RegistryItem } from "../types.js";
import { fetchRegistry } from "../registry-client.js";

export interface SearchInput {
  query: string;
  kind?: ItemKind;
  limit?: number;
}

export interface SearchHit {
  kind: ItemKind;
  slug: string;
  name: string;
  tagline: string;
  /** Bayesian-shrunk review rating (or null when unrated). */
  rating: number | null;
  /** Real cumulative install count (NOT GitHub stars). 0 on the degraded path. */
  installCount: number;
  repoUrl: string;
  rank: number;
}

export interface SearchResult {
  hits: SearchHit[];
  /** True when the portal was unreachable and hits came from the baked catalog. */
  degraded: boolean;
}

export interface SearchOpts {
  /** Test seam — override the live portal search. */
  searcher?: typeof searchPublicArtifacts;
  /** Test seam — override the baked-registry loader used on portal outage. */
  registryLoader?: () => Promise<Registry>;
}

const DEFAULT_LIMIT = 10;

export async function searchItems(
  input: SearchInput,
  opts: SearchOpts = {},
): Promise<SearchResult> {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const searcher = opts.searcher ?? searchPublicArtifacts;
  try {
    const params: SearchArtifactsQuery = { q: input.query, kind: input.kind, limit };
    const resp = await searcher(params);
    return {
      hits: resp.items.map((item, i) => portalHit(item, i)),
      degraded: resp.degraded ?? false,
    };
  } catch {
    // Portal unreachable — degrade to the baked catalog, ranked with the same engine.
    const loader = opts.registryLoader ?? (() => fetchRegistry());
    const registry = await loader();
    return { hits: rankBaked(registry.items, input, limit), degraded: true };
  }
}

function portalHit(item: RankedArtifact, index: number): SearchHit {
  return {
    kind: item.kind,
    slug: item.slug,
    name: item.displayName ?? item.name,
    tagline: item.tagline ?? "",
    rating: item.bayesRating ?? item.avgRating ?? null,
    installCount: item.installCount ?? 0,
    repoUrl: item.repoUrl,
    rank: item.rank ?? index + 1,
  };
}

// ── Degraded fallback: rank the baked registry.json with the shared engine ──

type BakedRankable = RankableArtifact & { repoUrl: string; ratingAvg: number | null };

function rankBaked(items: RegistryItem[], input: SearchInput, limit: number): SearchHit[] {
  const filtered = input.kind ? items.filter((i) => i.kind === input.kind) : items;
  const candidates: BakedRankable[] = filtered.map((item) => ({
    kind: item.kind,
    slug: item.slug,
    name: item.name,
    tagline: item.tagline,
    description: item.description,
    tags: item.tags,
    githubStars: item.popularity ?? 0,
    avgStars: item.ratingSummary?.avg ?? null,
    reviewCount: item.ratingSummary?.count ?? 0,
    // Baked items were published (they passed the eval gate at build time); treat
    // them as vetted so the discovery gate doesn't drop the whole degraded set.
    evalVerdict: "pass",
    featured: item.featured === true,
    lastUpdateMs: item.updatedAt ? Date.parse(item.updatedAt) : null,
    repoUrl: item.source.url,
    ratingAvg: item.ratingSummary?.avg ?? null,
  }));
  const ranked = rankArtifacts(candidates, {
    q: input.query,
    sort: "best",
    limit,
    globalMeanRating: 3.5,
    nowMs: Date.now(),
  });
  return ranked.map((r) => ({
    kind: r.kind,
    slug: r.slug,
    name: r.name,
    tagline: r.tagline ?? "",
    rating: r.ratingAvg,
    installCount: 0, // baked catalog carries no real install count
    repoUrl: r.repoUrl,
    rank: r.rank,
  }));
}
