/**
 * `metahub_get` — fetch one full artifact record by kind+slug.
 *
 * Primary path: the portal's public artifact endpoint
 * (`GET /api/public/artifacts/{kind}/{slug}` via
 * `@metahub/installer.getPublicArtifact`). It is anonymous-friendly,
 * always current, and returns a strictly richer record than the baked
 * catalog ever did — readme, kindFacts, badges, maturity, review
 * summary.
 *
 * This used to read the baked `registry.json` exclusively. That file is
 * a private build input of the registry app and has never been served
 * over HTTP, so the tool returned `HTTP 404` for every artifact in
 * production. Mirroring `search.ts` (portal primary, baked catalog as
 * an optional degraded fallback) puts both catalog reads on the same
 * source of truth.
 */
import { getPublicArtifact } from "@metahub/installer";
import type { ItemKind, RegistryItem } from "../types.js";
import { fetchRegistry, fallbackAvailable } from "../registry-client.js";

export interface GetInput {
  kind: ItemKind;
  slug: string;
}

export interface GetOpts {
  /** Test seam — override the live portal lookup. */
  portalGet?: typeof getPublicArtifact;
  /** Test seam — override the baked-catalog loader used on portal outage. */
  registryLoader?: () => Promise<{ items: RegistryItem[] }>;
  /** Test seam — override "is a baked catalog configured?". */
  registryConfigured?: () => boolean;
}

export interface GetResult {
  /** The artifact record, or null when the artifact does not exist. */
  artifact: Record<string, unknown> | null;
  /** True when the portal was unreachable and this came from the baked catalog. */
  degraded: boolean;
}

/**
 * Pure lookup over an already-loaded baked catalog. Retained for the
 * degraded path and because it is the natural unit to test kind+slug
 * keying against.
 */
export function getItem(items: RegistryItem[], input: GetInput): RegistryItem | null {
  return items.find((i) => i.kind === input.kind && i.slug === input.slug) ?? null;
}

/**
 * A 404 from the portal means "no such artifact", which is a normal
 * answer rather than an outage — we must NOT fall back to the baked
 * catalog for it, or a deleted/unpublished artifact would keep
 * resolving from a stale snapshot.
 */
function isNotFound(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b404\b/.test(msg) || /not found/i.test(msg);
}

export async function fetchArtifact(input: GetInput, opts: GetOpts = {}): Promise<GetResult> {
  const portalGet = opts.portalGet ?? getPublicArtifact;
  try {
    const res = await portalGet(input.kind, input.slug);
    if (!res?.artifact) return { artifact: null, degraded: false };
    // Fold the review summary in so the AI sees ratings without a second call.
    const artifact: Record<string, unknown> = { ...res.artifact };
    if (res.reviewSummary) artifact.reviewSummary = res.reviewSummary;
    return { artifact, degraded: false };
  } catch (err) {
    if (isNotFound(err)) return { artifact: null, degraded: false };
    if (!fallbackAvailable(opts)) throw err;
    const loader = opts.registryLoader ?? (() => fetchRegistry());
    const registry = await loader();
    return { artifact: getItem(registry.items, input), degraded: true };
  }
}
