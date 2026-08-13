/**
 * `mh whoami` — show the signed-in MetaHub user.
 *
 * Mirrors the @metahub/mcp-server `whoami` tool so CLI + MCP report
 * identical state. Reads the persisted token from `~/.metahub/config.json`
 * via @metahub/auth. When the token exists but the cached handle is
 * missing (older CLI version wrote just the bearer), we fall back to a
 * live `/me` lookup; on lookup failure we print a transient warning
 * rather than claiming signed-in with an empty handle.
 *
 * Always exits 0 — being signed out isn't a CLI failure.
 */
import { currentUser, loadAuthConfig, readPersistedToken } from "@metahub/auth";
import { c, glyph, header } from "../lib/ui.js";

export async function whoami(): Promise<number> {
  const token = readPersistedToken();
  const cfg = loadAuthConfig();
  console.log(header("whoami"));
  console.log();

  if (!token) {
    console.log(`  ${c.red(glyph.cross)} ${c.bold("not signed in")}`);
    console.log(`  ${c.dim("Run")} mh login ${c.dim("to sign in.")}`);
    return 0;
  }

  // Happy path: token + cached identity both present.
  if (token.userHandle && token.userId) {
    console.log(`  ${c.green(glyph.check)} ${c.bold("signed in as @" + token.userHandle)}`);
    console.log(`  ${c.dim("user id:")} ${c.dim(token.userId)}`);
    console.log(`  ${c.dim("portal: ")} ${c.dim(cfg.portalUrl)}`);
    return 0;
  }

  // Token present but identity not cached — try a live lookup.
  try {
    const me = await currentUser(token.token);
    console.log(`  ${c.green(glyph.check)} ${c.bold("signed in as @" + me.user.githubLogin)}`);
    console.log(`  ${c.dim("user id:")} ${c.dim(me.user.id)}`);
    console.log(`  ${c.dim("portal: ")} ${c.dim(cfg.portalUrl)}`);
    return 0;
  } catch (err) {
    const msg = (err as Error).message;
    console.log(`  ${c.yellow(glyph.warn)} ${c.bold("token present but identity lookup failed")}`);
    console.log(`  ${c.dim(msg)}`);
    return 0;
  }
}
