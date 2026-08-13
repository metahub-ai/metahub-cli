# @metahub/mcp-server

The MetaHub MCP server. Speaks the [Model Context Protocol](https://modelcontextprotocol.io/) over stdio so an AI client (Claude Code, Cursor, Antigravity, Claude Desktop, Continue, etc.) can search, install, sign in, and review MetaHub artifacts via natural language. No separate CLI required.

Not to be confused with [`@metahub/mcp`](../mcp/README.md), which is the publisher SDK developers import into _their_ MCP servers to ship telemetry. This package is the MetaHub-as-MCP-server distribution that end users install into their AI client.

The MCP server and the [`mh` CLI](../cli/README.md) share the same install library ([`@metahub/installer`](../installer/README.md)) and the same auth library ([`@metahub/auth`](../auth/README.md)). State is interoperable: install via the MCP server, then `mh list` shows it; `mh login`, then the MCP server's authenticated tools work without re-signing in.

## Architecture

```
packages/mcp-server/
├── bin/metahub-mcp.js        node shebang wrapper, runs dist/cli.js
├── src/
│   ├── cli.ts                argv parsing (--version, --help) and process bootstrap
│   ├── index.ts              exports run(); boots stdio when called from bin
│   ├── server.ts             registers tools + the catalog resource on an McpServer
│   ├── registry-client.ts    HTTP fetch + shape-check for the baked registry.json
│   ├── env.ts                METAHUB_REGISTRY_URL / METAHUB_PORTAL_URL defaults
│   ├── types.ts              local RegistryItem / Registry shapes
│   ├── lib/
│   │   ├── host.ts           host identifier + sign-in hint shared across tools
│   │   └── portal-client.ts  authenticated fetch helper for portal endpoints
│   └── tools/
│       ├── search.ts             metahub_search
│       ├── get.ts                metahub_get
│       ├── install.ts            metahub_install, calls @metahub/installer
│       ├── uninstall.ts          metahub_uninstall, calls @metahub/installer
│       ├── list-installed.ts     metahub_list_installed, calls @metahub/installer
│       ├── install-command.ts    metahub_install_command, emits the `mh install` string
│       ├── signin.ts             metahub_signin_begin / _complete, two-step device-code flow via @metahub/auth
│       ├── signout.ts            metahub_signout, clears the persisted token via @metahub/auth
│       ├── whoami.ts             metahub_whoami, reads persisted identity via @metahub/auth
│       ├── my-artifacts.ts       metahub_my_artifacts, publisher list
│       ├── my-stats.ts           metahub_my_stats, publisher observability
│       └── submit-review.ts      metahub_submit_review, submit a star-rated review
└── tests/                    vitest, library + fetch mocks only (no network, no spawn, no FS)
```

## Local dev

From the repo root:

```bash
pnpm --filter @metahub/mcp-server build      # one-shot tsc
pnpm --filter @metahub/mcp-server dev        # tsc --watch
pnpm --filter @metahub/mcp-server test       # vitest
pnpm --filter @metahub/mcp-server typecheck
pnpm --filter @metahub/mcp-server lint
```

Smoke-test the built binary:

```bash
node packages/mcp-server/bin/metahub-mcp.js --version
# metahub 0.1.0
```

To exercise the tools, point a real MCP client (or `npx @modelcontextprotocol/inspector`) at the binary. With no arguments the process waits for MCP frames on stdin.

## Tool reference

| Tool                      | Mode  | Purpose                                                                                                                                                                                                     |
| ------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `metahub_search`          | both  | Search the catalog. Args: `query: string`, `kind?: "skill" \| "mcp" \| "agent" \| "plugin"`, `limit?: number` (default 10).                                                                                 |
| `metahub_get`             | both  | Fetch one artifact's full record. Args: `kind`, `slug`. Returns the registry item or an error.                                                                                                              |
| `metahub_install_command` | both  | Return the exact `mh install <kind>/<slug>` command plus a tip. For users who prefer the CLI.                                                                                                               |
| `metahub_install`         | stdio | Install an artifact directly (no CLI required). Args: `kind`, `slug`. Calls `installArtifact()` from `@metahub/installer`: fetches the tarball, wires MCP across detected clients, records the install.     |
| `metahub_uninstall`       | stdio | Remove a previously installed artifact. Args: `kind`, `slug`. Calls `uninstallArtifact()`.                                                                                                                  |
| `metahub_list_installed`  | stdio | List installed artifacts. No args. Reads the install ledger via `@metahub/installer`.                                                                                                                       |
| `metahub_signin_begin`    | stdio | Start the GitHub device-code flow via `@metahub/auth`. Returns immediately with the verification URL, user code, and a `handle` to pass to `metahub_signin_complete`. No polling.                           |
| `metahub_signin_complete` | stdio | **Long-running.** Pass the `handle` from `metahub_signin_begin`. Polls for up to 5 minutes (tolerates short network blips, retry budget of 3 consecutive errors) and persists the session token on success. |
| `metahub_signout`         | stdio | Clear the persisted MetaHub session token. Idempotent.                                                                                                                                                      |
| `metahub_whoami`          | stdio | Return the signed-in MetaHub user, or `null`.                                                                                                                                                               |
| `metahub_my_artifacts`    | stdio | **Lazy auth.** List artifacts published by the signed-in user. No args.                                                                                                                                     |
| `metahub_my_stats`        | stdio | **Lazy auth.** Publisher observability for one artifact. Args: `kind`, `slug`, `windowDays?` (default 30).                                                                                                  |
| `metahub_submit_review`   | stdio | **Lazy auth.** Submit a 1-5 star review. Args: `kind`, `slug`, `rating`, `body`, `title?`.                                                                                                                  |

Plus one resource:

- `metahub://catalog` (both modes): the full catalog JSON, for offline browsing.

`stdio` tools are only registered when the server runs over stdio (`npx -y @metahub/mcp-server` inside an AI client, one process per user). They depend on the local filesystem (`~/.metahub/`) to read the install ledger and the session token; a remote/hosted transport has no such state.

## Authentication

The MCP server speaks to the MetaHub portal directly. No `mh` CLI required, though sessions are shared if you have both surfaces installed.

The first time any auth-required tool is called without a session token on disk, the tool returns a structured `isError: true` response asking the AI to walk the two-step signin flow:

1. `metahub_signin_begin` calls `startDeviceCodeFlow()` from `@metahub/auth` and **returns immediately** with the verification URL, user code, and an opaque `handle`. The AI surfaces the URL to the user.
2. The user opens the URL and completes the OAuth dance in their browser.
3. The AI calls `metahub_signin_complete` with the `handle` from step 1. The tool polls `pollDeviceCode()` (with a 3-error retry budget for transient network blips) until the user finishes, or up to 5 minutes, whichever comes first.
4. On success, `@metahub/auth` persists the session token to `~/.metahub/config.json` and the AI re-invokes whatever tool the user originally asked for.

The two-tool split is mandatory: MCP only sends one response per tool call, after the handler returns. A single `metahub_signin` tool that fetched the URL and then blocked polling would never deliver the URL to the AI until polling completed (deadlock).

`metahub_signout` clears the token. `metahub_whoami` returns the cached identity (or `null` if not signed in).

### Portal-side limitations

Some publisher endpoints (`/api/artifacts`, `/api/artifacts/[id]/observability`, `/api/public/reviews`) don't yet accept `sess_*` user-bearer tokens; they only honour the portal session cookie or `mhrg_*` service tokens. While that's true, `metahub_my_artifacts`, `metahub_my_stats`, and `metahub_submit_review` return a distinct **"portal hasn't deployed user-bearer auth on this endpoint yet"** message instead of looping the user back through signin. The CLI's `mh` equivalents work today; the MCP-side flow will work end-to-end once the portal change ships.

Auth-required tools are **stdio-only**. A remote/hosted transport (the planned `mcp.metahub.dev` endpoint) has no view of any caller's local `~/.metahub/config.json`, so it would expose only the read tools.

## Environment variables

| Variable               | Default                                     | Purpose                                                                                                            |
| ---------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `METAHUB_REGISTRY_URL` | `https://registry.metahub.ai/registry.json` | Where to fetch the baked catalog JSON.                                                                             |
| `METAHUB_PORTAL_URL`   | `https://developer.metahub.ai`              | Where to send authenticated publisher + auth requests. Self-host knob.                                             |
| `METAHUB_E2E_HOME`     | `os.homedir()`                              | Override the home dir used by `@metahub/auth` and `@metahub/installer` for the persisted token and install ledger. |

## User-facing integration guide

End-user install + AI-client configuration instructions live in [`docs/MCP_SERVER.md`](../../docs/MCP_SERVER.md). This README covers the package internals; the user-facing guide covers how to wire it into Claude Code, Cursor, etc.
