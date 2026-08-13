/**
 * Token persistence — read / write / clear the session token in the
 * shared `~/.metahub/config.json` file.
 *
 * The structure is deliberately tiny so the MCP server can pick up a
 * token written by the CLI (and vice versa) without re-implementing the
 * file format. The richer `AuthConfig` shape stays in `./config.ts`.
 */
import { currentUser } from "./portal-api.js";
import { loadAuthConfig, saveAuthConfig } from "./config.js";

export interface AuthToken {
  token: string;
  /** Unix ms — set if/when the portal returns an expiry. */
  expiresAt?: number;
  userId: string;
  userHandle: string;
}

interface PersistedConfigShape {
  sessionToken?: string;
  sessionExpiresAt?: number;
  sessionUserId?: string;
  sessionUserHandle?: string;
}

export function readPersistedToken(): AuthToken | null {
  const cfg = loadAuthConfig() as PersistedConfigShape & ReturnType<typeof loadAuthConfig>;
  if (!cfg.sessionToken) return null;
  return {
    token: cfg.sessionToken,
    expiresAt: cfg.sessionExpiresAt,
    userId: cfg.sessionUserId ?? "",
    userHandle: cfg.sessionUserHandle ?? "",
  };
}

export function persistToken(t: AuthToken): void {
  saveAuthConfig({
    sessionToken: t.token,
    // The richer fields below are written as best-effort metadata
    // for callers (the MCP server) that want to surface "signed in
    // as @x" without re-fetching /me. They live on the AuthConfig
    // object as additional keys; older CLI versions ignore them.
    ...({
      sessionExpiresAt: t.expiresAt,
      sessionUserId: t.userId,
      sessionUserHandle: t.userHandle,
    } as Partial<ReturnType<typeof loadAuthConfig>>),
  });
}

export function clearPersistedToken(): void {
  // `saveAuthConfig` merges, so writing `undefined` overwrites the
  // persisted value on disk while keeping any other config keys.
  saveAuthConfig({
    sessionToken: undefined,
    ...({
      sessionExpiresAt: undefined,
      sessionUserId: undefined,
      sessionUserHandle: undefined,
    } as Partial<ReturnType<typeof loadAuthConfig>>),
  });
}

/**
 * Fetch /me and persist the resulting handle alongside the token. The
 * device-code poll already gave us the user shape, but `mh login` also
 * historically fetched /me to print a friendly message — exposing this
 * helper keeps that round-trip optional rather than baked into the flow.
 */
export async function refreshUserHandle(token: string): Promise<string> {
  const me = await currentUser(token);
  saveAuthConfig({
    ...({
      sessionUserId: me.user.id,
      sessionUserHandle: me.user.githubLogin,
    } as Partial<ReturnType<typeof loadAuthConfig>>),
  });
  return me.user.githubLogin;
}
