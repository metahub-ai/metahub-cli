/**
 * `mh logout` — clear the persisted session token. Idempotent.
 *
 * Calls @metahub/auth's `clearPersistedToken`, which scrubs every
 * session-* key from `~/.metahub/config.json` while leaving non-auth
 * settings (portalUrl, registryUrl, telemetry preference) intact.
 * Always exits 0 — running logout when already signed out is not an
 * error, it's a no-op.
 */
import { clearPersistedToken, readPersistedToken } from "@metahub/auth";
import { c, glyph, header } from "../lib/ui.js";

export async function logout(): Promise<number> {
  const had = readPersistedToken();
  clearPersistedToken();
  console.log(header("logout"));
  console.log();
  if (had) {
    console.log(`  ${c.green(glyph.check)} ${c.bold("signed out")}`);
    if (had.userHandle) {
      console.log(`  ${c.dim("was signed in as @" + had.userHandle)}`);
    }
  } else {
    console.log(`  ${c.yellow(glyph.warn)} ${c.dim("no session to clear")}`);
  }
  return 0;
}
