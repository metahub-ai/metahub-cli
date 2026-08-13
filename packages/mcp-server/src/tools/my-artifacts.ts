/**
 * `metahub_my_artifacts` — list artifacts published by the signed-in
 * developer. Authenticated with the `sess_*` bearer the CLI writes to
 * `~/.metahub/config.json` on `mh login`.
 *
 * TODO: confirm with portal team — `GET /api/artifacts` currently only
 * accepts the portal session cookie. The user-bearer path needs to be
 * added there (mirroring the dual-mode auth in `/api/public/artifacts/*`)
 * before this tool round-trips end-to-end. The MCP-side wiring assumes
 * the additive change lands; until then this tool returns the portal's
 * 401 verbatim.
 */
import { callPortal, PortalError } from "../lib/portal-client.js";
import type { ItemKind } from "../types.js";

export interface MyArtifactsItem {
  id: string;
  kind: ItemKind;
  slug: string;
  name: string;
  version: string | null;
  publishedAt: string | null;
  visibility: string;
}

export interface MyArtifactsResult {
  artifacts: MyArtifactsItem[];
}

interface PortalArtifactsResponse {
  artifacts: Array<{
    id: string;
    kind: ItemKind;
    slug: string;
    name: string;
    version: string | null;
    publishedAt: string | null;
    visibility: string;
  }>;
}

export interface MyArtifactsOptions {
  bearer: string;
  baseUrl?: string;
  fetcher?: typeof fetch;
}

export async function fetchMyArtifacts(opts: MyArtifactsOptions): Promise<MyArtifactsResult> {
  const res = await callPortal<PortalArtifactsResponse>("/api/artifacts", {
    bearer: opts.bearer,
    baseUrl: opts.baseUrl,
    fetcher: opts.fetcher,
  });
  return {
    artifacts: (res.artifacts ?? []).map((a) => ({
      id: a.id,
      kind: a.kind,
      slug: a.slug,
      name: a.name,
      version: a.version,
      publishedAt: a.publishedAt,
      visibility: a.visibility,
    })),
  };
}

export { PortalError };
