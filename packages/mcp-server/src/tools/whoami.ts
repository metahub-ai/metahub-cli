/**
 * `metahub_whoami` — return the signed-in MetaHub user, or `null` if
 * no token is on disk. When a token exists but the cached user handle
 * is empty (older CLI version persisted just the bearer), fall back to
 * a `/me` lookup via `currentUser`.
 */
import { currentUser, readPersistedToken, type AuthToken } from "@metahub/auth";

export interface WhoamiResult {
  signedIn: boolean;
  userHandle: string | null;
  userId: string | null;
}

export interface WhoamiOptions {
  /** Test seam — override the persisted-token reader. */
  read?: typeof readPersistedToken;
  /** Test seam — override the /me lookup. */
  fetchUser?: typeof currentUser;
}

export async function whoami(opts: WhoamiOptions = {}): Promise<WhoamiResult> {
  const read = opts.read ?? readPersistedToken;
  const token: AuthToken | null = read();
  if (!token) {
    return { signedIn: false, userHandle: null, userId: null };
  }
  if (token.userHandle && token.userId) {
    return {
      signedIn: true,
      userHandle: token.userHandle,
      userId: token.userId,
    };
  }
  const fetchUser = opts.fetchUser ?? currentUser;
  try {
    const me = await fetchUser(token.token);
    return {
      signedIn: true,
      userHandle: me.user.githubLogin,
      userId: me.user.id,
    };
  } catch {
    return {
      signedIn: true,
      userHandle: token.userHandle || null,
      userId: token.userId || null,
    };
  }
}
