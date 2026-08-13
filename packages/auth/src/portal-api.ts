/**
 * Auth-only portal endpoints. The installer has its own portal client
 * for catalog reads; this one only knows how to start / finish the
 * device flow and read the current user.
 */
import type {
  CurrentUserResponse,
  DeviceFlowPollResponse,
  DeviceFlowStartResponse,
} from "@metahub/shared";
import { loadAuthConfig } from "./config.js";

interface FetchOpts {
  method?: "GET" | "POST";
  body?: unknown;
  bearer?: string;
}

async function call<T>(pathName: string, opts: FetchOpts = {}): Promise<T> {
  const cfg = loadAuthConfig();
  const url = new URL(pathName, cfg.portalUrl).toString();
  const headers: Record<string, string> = {
    "User-Agent": "metahub-auth",
    Accept: "application/json",
  };
  if (opts.body) headers["Content-Type"] = "application/json";
  if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    // Bound each call so a stalled poll can't freeze the device-code sign-in
    // past its deadline — the poll loop re-checks maxWaitMs after a timeout.
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
    throw new Error(`HTTP ${res.status} on ${new URL(url).pathname}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export async function startDeviceFlow(): Promise<DeviceFlowStartResponse> {
  return call<DeviceFlowStartResponse>("/api/auth/github/start", { method: "POST" });
}

export async function pollDeviceFlow(deviceCode: string): Promise<DeviceFlowPollResponse> {
  return call<DeviceFlowPollResponse>("/api/auth/github/poll", {
    method: "POST",
    body: { deviceCode },
  });
}

export async function currentUser(token: string): Promise<CurrentUserResponse> {
  return call<CurrentUserResponse>("/api/auth/me", { bearer: token });
}

/**
 * Resolve the best available bearer token for authenticated portal
 * calls (publish, observability, private-artifact installs). Prefers
 * the session token from `mh login` (real GitHub identity); falls back
 * to `METAHUB_SERVICE_TOKEN`. Throws when nothing is available —
 * callers that NEED auth surface the error to the user.
 */
export function resolveBearer(): string {
  const cfg = loadAuthConfig();
  const token = cfg.sessionToken ?? cfg.serviceToken;
  if (!token) {
    throw new Error("Not authenticated. Run `mh login` first, or set METAHUB_SERVICE_TOKEN.");
  }
  return token;
}

/**
 * Non-throwing variant for endpoints that are happy to serve
 * anonymous callers (the public catalog: `mh search`, `mh show`,
 * `mh install` for public artifacts). Returns the available bearer
 * when one is configured so the server can still apply per-user
 * features (e.g. `?include=unlisted`); returns `null` when no token
 * is around so the caller can omit the Authorization header.
 */
export function tryResolveBearer(): string | null {
  const cfg = loadAuthConfig();
  return cfg.sessionToken ?? cfg.serviceToken ?? null;
}
