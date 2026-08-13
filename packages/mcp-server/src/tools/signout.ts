/**
 * `metahub_signout` — clear the persisted session token from
 * `~/.metahub/config.json`. Idempotent: if no token is on disk,
 * succeeds silently.
 */
import { clearPersistedToken } from "@metahub/auth";

export interface SignoutResult {
  cleared: boolean;
}

export function signout(opts: { clear?: typeof clearPersistedToken } = {}): SignoutResult {
  const clearFn = opts.clear ?? clearPersistedToken;
  clearFn();
  return { cleared: true };
}
