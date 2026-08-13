/**
 * Identifiers the MCP server reports to the portal alongside install
 * events. The host string lets the portal attribute installs to "this
 * came from the MCP server" rather than "the CLI."
 */
export const MCP_SERVER_HOST = "metahub-mcp-server";
export const MCP_SERVER_VERSION = "0.1.0";

/**
 * Canonical message returned when an authenticated tool is called
 * without a signed-in user. The AI client is expected to surface this
 * verbatim and then walk the two-step signin flow.
 */
export const SIGN_IN_HINT =
  "To use this tool, sign in first. " +
  "Call metahub_signin_begin to get a verification URL, surface it to the user, " +
  "then call metahub_signin_complete with the returned handle to finish. " +
  "After signing in, retry this call.";

/**
 * Message returned when a user-bearer token is on disk but the portal
 * rejected it with 401 on a publisher endpoint. Distinguishes a
 * portal-side limitation (the endpoint hasn't shipped user-bearer auth
 * yet) from "you need to sign in" — otherwise the AI loops back into
 * the signin flow forever.
 */
export const PORTAL_BEARER_UNSUPPORTED_HINT =
  "The MetaHub portal hasn't deployed user-bearer auth on this endpoint yet, " +
  "so this tool can't complete the request even though you're signed in. " +
  "This is a known limitation tracked at " +
  "https://github.com/metahub-ai/metahub-monorepo/issues. " +
  "The CLI's `mh` equivalent works today (it uses a different auth path). " +
  "This tool will work once the portal change ships.";
