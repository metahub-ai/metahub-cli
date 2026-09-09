# Changelog

## 0.2.0

Ports the MCP server fixes from [metahub-monorepo#250](https://github.com/metahub-ai/metahub-monorepo/pull/250). The 0.1.0 bundle shipped a `metahub_get` and a `metahub://catalog` that failed for every user, so this is the release that actually delivers them.

### Fixed

- **`metahub_get` and `metahub://catalog` returned HTTP 404 for every caller.** The compiled-in `METAHUB_REGISTRY_URL` default pointed at `https://registry.metahub.ai/registry.json`, which is not served — the registry app builds that file as a private build input. Catalog reads now go to the portal's public catalog API (which `metahub_search` already used). `METAHUB_REGISTRY_URL` becomes an opt-in self-host override with no default, used only as a degraded fallback. This also restores `metahub_search`'s degraded path, dead for the same reason, so a portal blip degrades instead of failing outright.
- **`mh bootstrap` baked a non-catalog URL into every wired client.** It emitted `cfg.registryUrl || <portal fallback>`, but `loadAuthConfig()` always fills `registryUrl` in, so the fallback was unreachable and every client got `https://registry.metahub.ai` — a website root that serves HTML. It is now forwarded only when the user actually chose one (`METAHUB_REGISTRY_URL` or `mh config set registryUrl`), and the MCP server ignores the legacy value so clients wired by 0.1.0 heal without needing `mh bootstrap --force`.
- **`METAHUB_E2E_HOME` did not sandbox MCP-kind installs.** `clients.ts`, `detection.ts` and `capabilities.ts` called `os.homedir()` directly while `paths.ts` honoured the override, so an install placed the artifact in the sandbox but wired it — along with the per-install `mhi_` ingest credential — into the real Claude Code config. Ambient `XDG_CONFIG_HOME` re-escaped it for Zed/Goose/Cline. All three modules now share one `getHome()`, and the duplicated xdg/desktop/documents helpers are consolidated.
- **Client MCP configs holding the `mhi_` ingest credential are written 0600** rather than at the umask default (0644 on a typical Linux box), matching how `~/.metahub/config.json` and `installs.json` are already treated. VS Code is exempt: `.vscode/mcp.json` is a workspace file, not a per-user dotfile, and 0600 can lock out an editor server running under a different uid.
- **`metahub_search` hits now carry the publisher's `description`,** not just `tagline`. A listing can pair a benign tagline with a description disclosing that it is a deliberately vulnerable pentesting lab; dropping the description meant the model choosing what to install never saw the disclaimer.
- Slugs are bounded at 128 characters, and `metahub_install` names the artifact it could not find instead of relaying a bare `not found`.

### Changed

- **MCP tool descriptions rewritten for Claude Code's tool search** (on by default), which defers tool definitions and matches against tool names, descriptions and argument names/descriptions, returning five tools per search. The vocabulary users type ("registry", "marketplace", "discover", "capability", "extension", "editor") was absent from the tool surface, and seven of thirteen tools repeated the same kind-list boilerplate, crowding each other out of the five slots.
- **`metahub://catalog` is a bounded, slim browse view** (`fields=lean`, ≤200 items, `pageCounts` + `truncated`) instead of a whole-catalog dump. Measured against production: 576 ms / 183 KB, where the full projection is 8.1 s / 4.9 MB against a 15 s client timeout.
- `metahub-mcp --version` now reports the package version, so a fixed server is distinguishable from a 0.1.0 one in the field.

### Upgrade note — macOS users with `XDG_CONFIG_HOME` set

The installer's per-client config paths were triplicated and disagreed: one copy honoured `XDG_CONFIG_HOME` on macOS, the others did not. They now share one implementation that uses `~/.config` on macOS. If you are on macOS, export `XDG_CONFIG_HOME`, and wired a Zed or Goose MCP artifact under 0.1.0, the old entry (including its `METAHUB_INGEST_API_KEY`) still lives in `$XDG_CONFIG_HOME/{zed,goose}/` where `mh uninstall` will no longer look. Remove it by hand, or re-run `mh install` then `mh uninstall`.

## 0.1.0

- Initial standalone release. `@metahub-ai/mh`, `@metahub/mcp-server`, `@metahub/auth`, and `@metahub/installer` extracted from [metahub-monorepo](https://github.com/metahub-ai/metahub-monorepo) into this repository, with `@metahub/shared` vendored as a synced copy. Functionality is identical to the monorepo versions at the point of extraction.
