/**
 * `metahub_my_stats` — fetches the publisher observability roll-up for
 * one artifact owned by the signed-in user.
 *
 * Lookup is two-step: kind+slug → artifact ID via the public artifact
 * endpoint, then observability by ID via the publisher endpoint.
 *
 * TODO: confirm with portal team — `GET /api/artifacts/[id]/observability`
 * currently only accepts the portal session cookie. The user-bearer
 * path needs to be added (mirroring `/api/public/artifacts/*`) before
 * this tool round-trips end-to-end. The kind+slug lookup itself works
 * today because `/api/public/artifacts/[kind]/[slug]` already accepts
 * `sess_*` bearers.
 */
import { callPortal, PortalError } from "../lib/portal-client.js";
import type { ArtifactObservabilityResponse } from "@metahub/shared";
import type { ItemKind } from "../types.js";

export interface MyStatsInput {
  kind: ItemKind;
  slug: string;
  /** Roll-up window, default 30. Clamped portal-side to [1, 365]. */
  windowDays?: number;
}

export interface MyStatsOptions {
  bearer: string;
  baseUrl?: string;
  fetcher?: typeof fetch;
}

interface PublicArtifactResponse {
  artifact: { id: string };
}

export async function fetchMyStats(
  input: MyStatsInput,
  opts: MyStatsOptions,
): Promise<ArtifactObservabilityResponse> {
  const lookup = await callPortal<PublicArtifactResponse>(
    `/api/public/artifacts/${input.kind}/${encodeURIComponent(input.slug)}`,
    {
      bearer: opts.bearer,
      baseUrl: opts.baseUrl,
      fetcher: opts.fetcher,
    },
  );
  const id = lookup.artifact?.id;
  if (!id) {
    throw new PortalError(`No artifact found for kind=${input.kind} slug=${input.slug}.`, 404);
  }
  return callPortal<ArtifactObservabilityResponse>(
    `/api/artifacts/${encodeURIComponent(id)}/observability`,
    {
      bearer: opts.bearer,
      baseUrl: opts.baseUrl,
      fetcher: opts.fetcher,
      searchParams: { windowDays: input.windowDays },
    },
  );
}

export { PortalError };
