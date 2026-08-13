/**
 * Wires the full MetaHub tool set onto an `McpServer` instance. Kept
 * separate from {@link ./index.ts} so tests can inspect the configured
 * server without booting stdio.
 *
 * Tool layering:
 *   - Catalog tools (`metahub_search`, `metahub_get`, `metahub_install_command`,
 *     `metahub://catalog`) work without any local state. They run in
 *     both transport modes.
 *   - Local-only tools (install / uninstall / list_installed /
 *     signin_begin / signin_complete / signout / whoami / submit_review
 *     / my_stats / my_artifacts) all read or write `~/.metahub/` and
 *     therefore only make sense in the stdio transport (one process
 *     per user, on the user's machine). The hosted multi-tenant HTTP
 *     transport omits them.
 *
 * Auth-required tools follow a lazy-auth pattern: they call
 * `readPersistedToken()` at call time. If the token is missing they
 * return a structured `isError: true` response telling the AI to walk
 * the metahub_signin_begin → metahub_signin_complete flow. The AI then
 * loops back. No file-handling code lives in this module — `@metahub/auth`
 * owns the on-disk format.
 *
 * Signin is split across two tools because MCP only sends one response
 * per tool call, AFTER the handler returns: a single tool that fetched
 * the verification URL and then blocked polling would never deliver the
 * URL until polling completed, deadlocking the flow.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readPersistedToken } from "@metahub/auth";
import type { AuthToken, pollDeviceCode, startDeviceCodeFlow } from "@metahub/auth";
import type {
  installArtifact as installArtifactLib,
  uninstallArtifact as uninstallArtifactLib,
  searchPublicArtifacts as searchPublicArtifactsLib,
} from "@metahub/installer";
import { z } from "zod";
import { fetchRegistry } from "./registry-client.js";
import { searchItems, type SearchInput } from "./tools/search.js";
import { getItem } from "./tools/get.js";
import { listInstalledArtifacts } from "./tools/list-installed.js";
import { installCommand } from "./tools/install-command.js";
import { installArtifactTool } from "./tools/install.js";
import { uninstallArtifactTool } from "./tools/uninstall.js";
import { beginSignin, completeSignin } from "./tools/signin.js";
import { signout as signoutTool } from "./tools/signout.js";
import { whoami as whoamiTool } from "./tools/whoami.js";
import { fetchMyArtifacts } from "./tools/my-artifacts.js";
import { fetchMyStats } from "./tools/my-stats.js";
import { submitReview } from "./tools/submit-review.js";
import { PortalError } from "./lib/portal-client.js";
import { PORTAL_BEARER_UNSUPPORTED_HINT, SIGN_IN_HINT } from "./lib/host.js";
import { registryUrl } from "./env.js";

const SERVER_NAME = "metahub";
const SERVER_VERSION = "0.1.0";

const ITEM_KIND = z.enum(["skill", "mcp", "agent", "plugin"]);

const SEARCH_SCHEMA = {
  query: z.string().describe("Free-text search across name, tagline, description, and tags."),
  kind: ITEM_KIND.optional().describe("Restrict to one artifact kind."),
  limit: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe("Maximum number of hits to return. Defaults to 10."),
};

const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const SLUG_SCHEMA = z
  .string()
  .regex(SLUG_RE, "slug must be lower-case alphanumerics + hyphens (length ≥ 2)");

const GET_SCHEMA = {
  kind: ITEM_KIND.describe("Artifact kind: skill | mcp | agent | plugin."),
  slug: SLUG_SCHEMA.describe("The artifact slug (the part after the kind segment in URLs)."),
};

// install / uninstall / install_command all flow through this. Validate the
// slug here (not a bare z.string()) so a hostile slug can never reach
// install_command's `mh install …/<slug>` string or a filesystem path.
const KIND_SLUG_SCHEMA = {
  kind: ITEM_KIND,
  slug: SLUG_SCHEMA,
};

const SUBMIT_REVIEW_SCHEMA = {
  kind: ITEM_KIND,
  slug: SLUG_SCHEMA,
  rating: z.number().int().min(1).max(5).describe("Star rating, 1–5 inclusive."),
  body: z
    .string()
    .trim()
    .min(4, "Review body must be at least 4 characters.")
    .max(2000, "Review body must be at most 2000 characters."),
  title: z.string().trim().max(140).optional(),
};

const SIGNIN_COMPLETE_SCHEMA = {
  handle: z
    .string()
    .min(1)
    .describe(
      "The opaque `handle` returned by metahub_signin_begin. Pass it back here to finish the signin.",
    ),
  verificationUrl: z
    .string()
    .url()
    .optional()
    .describe(
      "Optional — the verification URL from metahub_signin_begin. Echoed back in the response to help the AI reassure the user about which URL was used.",
    ),
  userCode: z
    .string()
    .optional()
    .describe("Optional — the user code from metahub_signin_begin. Echoed back in the response."),
  interval: z
    .number()
    .int()
    .positive()
    .max(60)
    .optional()
    .describe(
      "Optional — the polling interval (seconds) from metahub_signin_begin. Defaults to 5 if omitted.",
    ),
};

const MY_STATS_SCHEMA = {
  kind: ITEM_KIND,
  slug: SLUG_SCHEMA,
  windowDays: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe("Roll-up window in days. Defaults to 30 portal-side."),
};

/**
 * Transport mode the server is being built for.
 *
 * `"stdio"` is the local-host deployment (the default `npx` install
 * users run inside their AI client). It has filesystem access and is
 * single-tenant, so all tools are safe to expose.
 *
 * `"http"` is the hosted multi-tenant deployment (e.g.
 * `mcp.metahub.dev`). It is shared across many users and has no
 * meaningful "local filesystem" — tools that read `~/.metahub/` or
 * require local auth must NOT be registered.
 */
export type ServerMode = "stdio" | "http";

export interface BuildServerOptions {
  /** Override the registry fetcher (tests). */
  fetcher?: typeof fetch;
  /** Override the registry URL (tests). */
  url?: string;
  /**
   * Transport mode. Determines which tools get registered. Defaults
   * to `"stdio"`.
   */
  mode?: ServerMode;
  /** Override the portal base URL — tests stub this against an in-memory fixture. */
  portalBaseUrl?: string;
  /** Override the portal fetcher — tests inject mocks. */
  portalFetcher?: typeof fetch;
  /**
   * Read the persisted token from somewhere other than `@metahub/auth`'s
   * default. Tests stub this against a temp config file so they don't
   * read the dev's real `~/.metahub/config.json`.
   */
  readPersistedToken?: () => AuthToken | null;
  /** Test seam — override the installer library entry point. */
  installArtifact?: typeof installArtifactLib;
  /** Test seam — override the uninstaller library entry point. */
  uninstallArtifact?: typeof uninstallArtifactLib;
  /** Test seam — override the portal search entry point. */
  searchPublicArtifacts?: typeof searchPublicArtifactsLib;
  /** Test seam — override device-flow start. */
  startDeviceCodeFlow?: typeof startDeviceCodeFlow;
  /** Test seam — override device-flow poll. */
  pollDeviceCode?: typeof pollDeviceCode;
  /** Test seam — override token clear. */
  clearPersistedToken?: () => void;
  /** Test seam — override the max-wait for signin polling. */
  signinMaxWaitMs?: number;
  /** Test seam — override sleeping in the signin polling loop. */
  signinSleep?: (ms: number) => Promise<void>;
  /** Test seam — clock override for signin polling. */
  signinNow?: () => number;
}

function toolError(toolName: string, err: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: `${toolName} failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    ],
  };
}

function signInHintError() {
  return {
    isError: true,
    content: [{ type: "text" as const, text: SIGN_IN_HINT }],
  };
}

function portalBearerUnsupportedError() {
  return {
    isError: true,
    content: [{ type: "text" as const, text: PORTAL_BEARER_UNSUPPORTED_HINT }],
  };
}

/**
 * Maps portal errors to user-friendly tool responses. Callers should
 * have already short-circuited on a missing token via
 * {@link signInHintError}; this only fires on errors that come back
 * from the portal HTTP layer.
 *
 * When `tokenPresent` is true, a 401 means the token was actually sent
 * but the portal rejected it — for the publisher endpoints that don't
 * yet accept `sess_*` user-bearer tokens, this is a known portal-side
 * limitation, not a stale-token signal. We surface a distinct message
 * so the AI doesn't loop the user back through signin.
 */
function publisherToolError(toolName: string, err: unknown, tokenPresent = false) {
  if (err instanceof PortalError) {
    if (err.status === 401) {
      if (tokenPresent) {
        return portalBearerUnsupportedError();
      }
      // No token sent (shouldn't normally happen — callers gate on
      // `requireBearer` first — but defensively prompt for signin).
      return signInHintError();
    }
    if (err.status === 403) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `You don't appear to be the publisher of this artifact. (portal: ${err.message})`,
          },
        ],
      };
    }
    if (err.status === 404) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: err.message }],
      };
    }
    return {
      isError: true,
      content: [
        { type: "text" as const, text: `${toolName} failed (HTTP ${err.status}): ${err.message}` },
      ],
    };
  }
  return toolError(toolName, err);
}

export function buildServer(opts: BuildServerOptions = {}): McpServer {
  const mode: ServerMode = opts.mode ?? "stdio";
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  const load = () => fetchRegistry({ fetcher: opts.fetcher, url: opts.url });
  const readToken = opts.readPersistedToken ?? readPersistedToken;

  server.registerTool(
    "metahub_search",
    {
      title: "Search MetaHub",
      description:
        "Search the MetaHub catalog of AI skills, MCP servers, agents, and plugins. " +
        "Results are ranked by relevance, then by popularity and quality signals; an exact " +
        "name or slug match is always returned first.",
      inputSchema: SEARCH_SCHEMA,
    },
    async (input) => {
      try {
        const { hits, degraded } = await searchItems(input as SearchInput, {
          searcher: opts.searchPublicArtifacts,
          registryLoader: load,
        });
        const payload: Record<string, unknown> = { count: hits.length, hits };
        if (degraded) payload.degraded = true;
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        };
      } catch (err) {
        return toolError("metahub_search", err);
      }
    },
  );

  server.registerTool(
    "metahub_get",
    {
      title: "Get artifact details",
      description:
        "Fetch the full record for one MetaHub artifact by kind and slug. " +
        "Use this after `metahub_search` to inspect README, install snippets, version, etc.",
      inputSchema: GET_SCHEMA,
    },
    async (input) => {
      try {
        const registry = await load();
        const item = getItem(registry.items, input);
        if (!item) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `No artifact found for kind=${input.kind} slug=${input.slug}.`,
              },
            ],
          };
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(item, null, 2) }],
        };
      } catch (err) {
        return toolError("metahub_get", err);
      }
    },
  );

  server.registerTool(
    "metahub_install_command",
    {
      title: "Generate install command",
      description:
        "Return the exact `mh install <kind>/<slug>` command for a MetaHub artifact. " +
        "The MCP server can install directly via `metahub_install`; this tool is for users " +
        "who prefer running the CLI themselves.",
      inputSchema: KIND_SLUG_SCHEMA,
    },
    async (input) => {
      try {
        const result = installCommand(input);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return toolError("metahub_install_command", err);
      }
    },
  );

  if (mode === "stdio") {
    // ── Install / uninstall / list — local FS only.
    server.registerTool(
      "metahub_install",
      {
        title: "Install a MetaHub artifact",
        description:
          "Install a MetaHub artifact (skill, MCP server, agent, or plugin) directly into the " +
          "detected AI clients on this machine. No CLI required. The user should restart their " +
          "AI client to pick up the new artifact.",
        inputSchema: KIND_SLUG_SCHEMA,
      },
      async (input) => {
        try {
          const { summary } = await installArtifactTool(input, {
            installer: opts.installArtifact,
          });
          return {
            content: [{ type: "text" as const, text: summary }],
          };
        } catch (err) {
          return toolError("metahub_install", err);
        }
      },
    );

    server.registerTool(
      "metahub_uninstall",
      {
        title: "Uninstall a MetaHub artifact",
        description:
          "Remove a previously installed MetaHub artifact. Deletes its install directory and " +
          "unwires it from any AI clients it was registered with.",
        inputSchema: KIND_SLUG_SCHEMA,
      },
      async (input) => {
        try {
          const { summary } = await uninstallArtifactTool(input, {
            uninstaller: opts.uninstallArtifact,
          });
          return {
            content: [{ type: "text" as const, text: summary }],
          };
        } catch (err) {
          return toolError("metahub_uninstall", err);
        }
      },
    );

    server.registerTool(
      "metahub_list_installed",
      {
        title: "List installed MetaHub artifacts",
        description:
          "List MetaHub artifacts already installed on this machine. " +
          "Returns an empty list if nothing has been installed yet.",
        inputSchema: {},
      },
      async () => {
        try {
          const installs = await listInstalledArtifacts();
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ count: installs.length, installs }, null, 2),
              },
            ],
          };
        } catch (err) {
          return toolError("metahub_list_installed", err);
        }
      },
    );

    // ── Auth tools. Signin is split into two tools so the verification
    //    URL reaches the AI immediately (MCP returns one response per
    //    tool call, after the handler returns — a single tool that
    //    starts the flow then polls would deadlock). `signout` and
    //    `whoami` are fast and single-call.

    server.registerTool(
      "metahub_signin_begin",
      {
        title: "Start MetaHub sign-in",
        description:
          "Start the GitHub device-code flow against the MetaHub portal. Returns immediately " +
          "with a verification URL and user code. Surface the URL to the user so they can open " +
          "it in their browser, then call metahub_signin_complete (with the returned handle) to " +
          "finish the signin. Returns without polling — the device-code flow runs server-side at " +
          "GitHub until the user authorizes.",
        inputSchema: {},
      },
      async () => {
        try {
          const start = await beginSignin({ start: opts.startDeviceCodeFlow });
          const text =
            `Open this URL in your browser to sign in to MetaHub:\n\n  ${start.verificationUrl}\n\n` +
            `Enter this code if prompted:\n\n  ${start.userCode}\n\n` +
            `Then call metahub_signin_complete with handle="${start.deviceCode}" ` +
            `(interval=${start.interval}, expiresIn=${start.expiresIn}s) to finish the signin.`;
          return {
            content: [{ type: "text" as const, text }],
          };
        } catch (err) {
          return toolError("metahub_signin_begin", err);
        }
      },
    );

    server.registerTool(
      "metahub_signin_complete",
      {
        title: "Finish MetaHub sign-in",
        description:
          "Finish a MetaHub signin started by metahub_signin_begin. Pass the `handle` from the " +
          "begin response. Polls the portal for up to 5 minutes, tolerating short network blips, " +
          "and persists the session token on success. Returns `isError: true` on denial, " +
          "expiry, or timeout — in those cases call metahub_signin_begin again for a fresh code.",
        inputSchema: SIGNIN_COMPLETE_SCHEMA,
      },
      async (input) => {
        try {
          const result = await completeSignin(
            {
              verificationUrl: input.verificationUrl ?? "",
              userCode: input.userCode ?? "",
              deviceCode: input.handle,
              interval: input.interval ?? 5,
            },
            {
              poll: opts.pollDeviceCode,
              maxWaitMs: opts.signinMaxWaitMs,
              sleep: opts.signinSleep,
              now: opts.signinNow,
            },
          );
          if (result.state === "complete") {
            const who = result.userHandle ? `@${result.userHandle}` : "your MetaHub account";
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Signed in to ${who}. The session token is persisted at ~/.metahub/config.json.`,
                },
              ],
            };
          }
          if (result.state === "denied") {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: "Sign-in denied. Call metahub_signin_begin again if you want to try once more.",
                },
              ],
            };
          }
          if (result.state === "expired") {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text:
                    "Sign-in code expired before the user completed the flow. " +
                    "Call metahub_signin_begin to get a fresh code.",
                },
              ],
            };
          }
          // state === "timeout"
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text:
                  "Sign-in timed out after 5 minutes. " +
                  "Call metahub_signin_begin to start a fresh device-code flow.",
              },
            ],
          };
        } catch (err) {
          return toolError("metahub_signin_complete", err);
        }
      },
    );

    server.registerTool(
      "metahub_signout",
      {
        title: "Sign out of MetaHub",
        description:
          "Clear the persisted MetaHub session token from `~/.metahub/config.json`. " +
          "Idempotent — succeeds even if no token was on disk.",
        inputSchema: {},
      },
      async () => {
        try {
          signoutTool({ clear: opts.clearPersistedToken });
          return {
            content: [
              { type: "text" as const, text: "Signed out. Session token cleared from disk." },
            ],
          };
        } catch (err) {
          return toolError("metahub_signout", err);
        }
      },
    );

    server.registerTool(
      "metahub_whoami",
      {
        title: "Show the signed-in MetaHub user",
        description:
          "Return the signed-in MetaHub user (GitHub handle + user ID) if a session token is " +
          "persisted, otherwise null.",
        inputSchema: {},
      },
      async () => {
        try {
          const result = await whoamiTool({ read: readToken });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        } catch (err) {
          return toolError("metahub_whoami", err);
        }
      },
    );

    // ── Publisher tools. Lazy-auth: check the persisted token at call
    //    time; if missing, return the canonical sign-in hint so the AI
    //    can call `metahub_signin_begin` + `metahub_signin_complete` and retry.

    const requireBearer = (): string | null => {
      const token = readToken();
      return token?.token ?? null;
    };

    server.registerTool(
      "metahub_my_artifacts",
      {
        title: "List my published MetaHub artifacts",
        description:
          "List artifacts published by the signed-in MetaHub user. " +
          "Requires sign-in by calling metahub_signin_begin then metahub_signin_complete. " +
          "Returns kind, slug, name, version, visibility, and publish timestamp.",
        inputSchema: {},
      },
      async () => {
        const bearer = requireBearer();
        if (!bearer) return signInHintError();
        try {
          const result = await fetchMyArtifacts({
            bearer,
            baseUrl: opts.portalBaseUrl,
            fetcher: opts.portalFetcher,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { count: result.artifacts.length, artifacts: result.artifacts },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (err) {
          return publisherToolError("metahub_my_artifacts", err, true);
        }
      },
    );

    server.registerTool(
      "metahub_my_stats",
      {
        title: "Observability stats for one of my artifacts",
        description:
          "Fetch publisher observability data (invocations, p50/p95 latency, top models/tools, " +
          "handoffs, error rate, recent errors) for one artifact the signed-in user owns. " +
          "Requires sign-in by calling metahub_signin_begin then metahub_signin_complete.",
        inputSchema: MY_STATS_SCHEMA,
      },
      async (input) => {
        const bearer = requireBearer();
        if (!bearer) return signInHintError();
        try {
          const stats = await fetchMyStats(input, {
            bearer,
            baseUrl: opts.portalBaseUrl,
            fetcher: opts.portalFetcher,
          });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(stats, null, 2) }],
          };
        } catch (err) {
          return publisherToolError("metahub_my_stats", err, true);
        }
      },
    );

    server.registerTool(
      "metahub_submit_review",
      {
        title: "Submit a MetaHub review",
        description:
          "Submit a star-rated review (1–5) for a MetaHub artifact on behalf of the signed-in user. " +
          "Requires sign-in by calling metahub_signin_begin then metahub_signin_complete. The review is attributed to the user's GitHub identity.",
        inputSchema: SUBMIT_REVIEW_SCHEMA,
      },
      async (input) => {
        const bearer = requireBearer();
        if (!bearer) return signInHintError();
        try {
          const review = await submitReview(input, {
            bearer,
            baseUrl: opts.portalBaseUrl,
            fetcher: opts.portalFetcher,
          });
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ review }, null, 2) }],
          };
        } catch (err) {
          return publisherToolError("metahub_submit_review", err, true);
        }
      },
    );
  }

  server.registerResource(
    "catalog",
    "metahub://catalog",
    {
      title: "MetaHub catalog",
      description: "Full MetaHub catalog as JSON. Browse offline before searching.",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        const registry = await load();
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(registry, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = `metahub://catalog read failed: ${err instanceof Error ? err.message : String(err)}`;
        process.stderr.write(`[metahub-mcp] ${message}\n`);
        throw new Error(message, { cause: err });
      }
    },
  );

  return server;
}

/** Exposed for diagnostics / sanity-check logging. */
export function serverConfig(): { name: string; version: string; registryUrl: string } {
  return { name: SERVER_NAME, version: SERVER_VERSION, registryUrl: registryUrl() };
}
