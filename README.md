# MetaHub CLI

The MetaHub client toolchain: everything that runs on an **end-user machine** to browse, install, and manage AI artifacts (skills, MCP servers, agents, plugins) from [MetaHub](https://registry.metahub.ai).

## Install

Install from npm:

```bash
npm install -g @metahub-ai/mh
mh bootstrap
```

Or use the shell installer:

```bash
curl -fsSL https://metahub.ai/install.sh | sh
```

Both options install the same `mh` CLI and bundled `metahub-mcp` server. The
shell installer runs the editor bootstrap automatically; npm users run
`mh bootstrap` once after installation.

This installs two binaries on your PATH:

- **`mh`** — the CLI: `install`, `update`, `list`, `search`, `uninstall`, `login`, `trace`, `bootstrap`, `upgrade`
- **`metahub-mcp`** — the MetaHub MCP server, so any MCP-capable AI client (Claude Code, Cursor, Antigravity, …) can search and install artifacts from inside the client. `mh bootstrap` wires it up.

## Packages

This is a small pnpm workspace. The four published packages mirror what used to live in the [metahub monorepo](https://github.com/metahub-ai/metahub-monorepo):

| Package                  | What it is                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `packages/cli`           | `@metahub-ai/mh` — the public npm package containing `mh` and `metahub-mcp`                               |
| `packages/mcp-server`    | `@metahub/mcp-server` — MCP server exposing the catalog (search, install, sign-in, reviews)               |
| `packages/installer`     | `@metahub/installer` — install ledger (`~/.metahub/installs.json`), multi-client wiring, tarball download |
| `packages/auth`          | `@metahub/auth` — persisted token (`~/.metahub/config.json`) + GitHub device-code flow                    |
| `packages/shared`        | `@metahub/shared` — **vendored copy** of the wire-format contract (see below)                             |
| `packages/eslint-config` | internal lint tooling (not published)                                                                     |

The CLI and MCP server share the installer and auth libraries — the MCP server's `metahub_install` / `metahub_signin_*` tools call the same functions the `mh` commands do. Never shell out to `mh` from the MCP server; call the library.

## Relationship to the monorepo

Two deliberate coupling points with [metahub-monorepo](https://github.com/metahub-ai/metahub-monorepo):

1. **`packages/shared` is a synced copy, not the source of truth.** The monorepo's `packages/shared` (used by the portal, registry, and publisher SDKs) is canonical. When the wire format changes there, run `pnpm sync:shared` (expects a sibling `../metahub-monorepo` checkout) to pull the new `src/`. Once `@metahub/shared` is published to npm, the vendored copy should be replaced by a regular dependency.
2. **npm and the shell installer ship the same standalone build.** `pnpm bundle` produces both the npm publish directory (`packages/cli/standalone/package`) and a self-contained tarball (`packages/cli/standalone/mh-latest.tgz`) with every workspace dependency baked in. `pnpm tarball:monorepo` copies the tarball into the monorepo's `apps/registry/public/cli/`, where it is committed and served at `registry.metahub.ai/cli/mh-latest.tgz` for `install.sh`.

## Development

```bash
pnpm install
pnpm verify        # build + typecheck + lint + test, in dependency order
pnpm bundle        # build the standalone tarball
pnpm publish:check # dry-run the exact package that will be sent to npm
```

Node ≥ 20 (`.nvmrc`), pnpm ≥ 9. Tests are Vitest, per package under `packages/<name>/tests/`.

Client state on an end-user machine lives in `~/.metahub/` — `config.json` (login token + telemetry prefs) and `installs.json` (per-install API keys). Installed artifacts land in client-specific dirs (`~/.claude/skills/<slug>/`, `~/.claude.json` for user-scoped Claude Code MCP servers, `~/.metahub/agents/<slug>/`, …).

## License

[MIT](LICENSE)
