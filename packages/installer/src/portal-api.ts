/**
 * Catalog-side portal endpoints used by the installer (and re-exported
 * for the CLI's discovery commands). Auth endpoints live in
 * `@metahub/auth/portal-api`.
 */
import type {
  ArtifactKind,
  CliInstallResponse,
  PublicArtifact,
  PublicReviewSummary,
  SearchArtifactsQuery,
  SearchArtifactsResponse,
} from "@metahub/shared";
import { loadAuthConfig, resolveBearer, tryResolveBearer } from "@metahub/auth";

interface FetchOpts {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /**
   * Optional bearer. When undefined the Authorization header is
   * omitted — used for endpoints that accept anonymous reads (the
   * public catalog list, single artifact, install info). When set to
   * a string the value is sent verbatim.
   */
  bearer?: string;
  searchParams?: Record<string, string>;
}

async function call<T>(pathName: string, opts: FetchOpts = {}): Promise<T> {
  const cfg = loadAuthConfig();
  const u = new URL(pathName, cfg.portalUrl);
  if (opts.searchParams) {
    for (const [k, v] of Object.entries(opts.searchParams)) {
      u.searchParams.set(k, v);
    }
  }
  const headers: Record<string, string> = {
    "User-Agent": "metahub-installer",
    Accept: "application/json",
  };
  if (opts.body) headers["Content-Type"] = "application/json";
  if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(u.toString(), {
    method: opts.method ?? "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    // Bound the request so a stalled/half-open portal can't hang the caller
    // forever — lets search degrade to the baked registry and install fail fast.
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    let text = "";
    try {
      text = await res.text();
    } catch {
      /* leave text empty */
    }
    let parsed: {
      error?: string;
      githubError?: string;
      githubDescription?: string;
      docsHint?: string;
    } | null = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON — fall through */
    }
    if (parsed?.error) {
      let msg = parsed.error;
      if (parsed.githubDescription) msg += `\n  GitHub: ${parsed.githubDescription}`;
      if (parsed.docsHint) msg += `\n  Docs: ${parsed.docsHint}`;
      throw new Error(msg);
    }
    throw new Error(`HTTP ${res.status} on ${u.pathname}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/**
 * Resolve a bearer for endpoints that REQUIRE auth (private-artifact
 * installs, publish, observability). Throws when nothing is
 * configured so the CLI can surface a "Run `mh login`" message.
 */
function requireBearer(override?: string): string {
  if (override) return override;
  return resolveBearer();
}

/**
 * Resolve a bearer for endpoints that accept anonymous callers
 * (public catalog list, single artifact, install info for
 * public/unlisted artifacts). Returns `undefined` when no token is
 * configured so the Authorization header is simply omitted. When a
 * token IS configured we still send it — the server uses it to grant
 * authenticated extras like `?include=unlisted`, or to resolve a
 * private-artifact install when the user is the publisher.
 */
function optionalBearer(override?: string): string | undefined {
  if (override) return override;
  return tryResolveBearer() ?? undefined;
}

export async function getInstallInfo(
  kind: ArtifactKind,
  slug: string,
  meta: { host: string; platform: string; cliVersion: string },
  token?: string,
): Promise<CliInstallResponse> {
  // Install is anonymous-friendly: the server gates by visibility,
  // not by bearer (see /api/cli/install/[kind]/[slug]/route.ts). We
  // attach the token when present so private-artifact installs work
  // for the publisher; we omit it when absent so `npm install`-style
  // first-time-user flows succeed.
  return call<CliInstallResponse>(`/api/cli/install/${kind}/${slug}`, {
    bearer: optionalBearer(token),
    searchParams: meta,
  });
}

export interface PublicArtifactResponse {
  artifact: PublicArtifact;
  reviewSummary: PublicReviewSummary;
}

export async function getPublicArtifact(
  kind: ArtifactKind,
  slug: string,
  token?: string,
): Promise<PublicArtifactResponse> {
  return call<PublicArtifactResponse>(`/api/public/artifacts/${kind}/${slug}`, {
    bearer: optionalBearer(token),
  });
}

export interface ListPublicArtifactsResult {
  items: PublicArtifact[];
  nextCursor: string | null;
}

export async function listPublicArtifacts(
  params: Record<string, string> = {},
  token?: string,
): Promise<ListPublicArtifactsResult> {
  return call<ListPublicArtifactsResult>("/api/public/artifacts", {
    bearer: optionalBearer(token),
    searchParams: { limit: "200", ...params },
  });
}

/**
 * Ranked text search over the public catalog (GET /api/public/artifacts/search).
 * Anonymous-friendly like listPublicArtifacts; a token (when present) unlocks
 * unlisted results via the server. Results are already ranked + filtered
 * server-side, so callers render them as-is.
 */
export async function searchPublicArtifacts(
  params: SearchArtifactsQuery,
  token?: string,
): Promise<SearchArtifactsResponse> {
  const searchParams: Record<string, string> = { q: params.q };
  if (params.kind) searchParams.kind = params.kind;
  if (params.sort) searchParams.sort = params.sort;
  if (params.limit != null) searchParams.limit = String(params.limit);
  return call<SearchArtifactsResponse>("/api/public/artifacts/search", {
    bearer: optionalBearer(token),
    searchParams,
  });
}

// requireBearer is exported for any future authenticated-only catalog
// helper (currently every catalog endpoint accepts anonymous).
void requireBearer;
