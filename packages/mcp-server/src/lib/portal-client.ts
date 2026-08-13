/**
 * Authenticated fetch helper for the portal. Used by the publisher
 * tools (`metahub_submit_review`, `metahub_my_stats`, `metahub_my_artifacts`).
 *
 * The bearer is the `sess_*` token persisted by `@metahub/auth` at
 * `~/.metahub/config.json`. The default base URL is the same value
 * `@metahub/auth` uses (`loadAuthConfig().portalUrl`), so the MCP server
 * and the CLI always talk to the same portal.
 *
 * Errors come back as structured `{ error, docsHint? }` JSON bodies on
 * 4xx/5xx; we shape those into {@link PortalError} so the tool layer can
 * surface them readably.
 */
import { loadAuthConfig } from "@metahub/auth";

const FETCH_TIMEOUT_MS = 10_000;
const USER_AGENT = "metahub-mcp-server";

export interface PortalCallOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  bearer: string;
  searchParams?: Record<string, string | number | undefined>;
  /** Override the base URL (tests). */
  baseUrl?: string;
  /** Override the global fetcher (tests). */
  fetcher?: typeof fetch;
}

export class PortalError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "PortalError";
  }
}

interface PortalErrorBody {
  error?: string;
  field?: string;
  docsHint?: string;
}

function defaultPortalUrl(): string {
  return loadAuthConfig().portalUrl;
}

export async function callPortal<T>(pathName: string, opts: PortalCallOptions): Promise<T> {
  const base = opts.baseUrl ?? defaultPortalUrl();
  const u = new URL(pathName, base.endsWith("/") ? base : base + "/");
  if (opts.searchParams) {
    for (const [k, v] of Object.entries(opts.searchParams)) {
      if (v === undefined) continue;
      u.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
    Authorization: `Bearer ${opts.bearer}`,
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const fetcher = opts.fetcher ?? fetch;
  let res: Response;
  try {
    res = await fetcher(u.toString(), {
      method: opts.method ?? "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new PortalError(`Could not reach portal at ${base}: ${(err as Error).message}`, 0);
  }
  if (!res.ok) {
    let text = "";
    try {
      text = await res.text();
    } catch {
      /* leave text empty */
    }
    let parsed: PortalErrorBody | null = null;
    try {
      parsed = text ? (JSON.parse(text) as PortalErrorBody) : null;
    } catch {
      /* not JSON */
    }
    const message = parsed?.error || text.slice(0, 200) || res.statusText || `HTTP ${res.status}`;
    throw new PortalError(message, res.status);
  }
  return (await res.json()) as T;
}
