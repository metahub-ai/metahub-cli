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
- **A client config that does not parse is never overwritten (issue #10).** "File absent" and "file corrupt" used to collapse into the same empty object, so a malformed Cursor, Zed, Windsurf or Claude config was replaced with one holding only the MetaHub entry. Unparsable files are now skipped with a warning naming the file. An empty file (Antigravity ships a zero-byte `mcp_config.json`) is still treated as empty, not corrupt.
- **The Cursor `.mdc` rule mirror is gone.** Cursor now loads SKILL.md folders from `~/.claude/skills` and `~/.agents/skills` natively, so the rule was a duplicate that fired alongside the skill. Rules written by 0.1.0 are still removed by `mh uninstall`.
- **`mh doctor` honours `METAHUB_E2E_HOME`**, understands the new client files, no longer reports a manual (YAML/UI) config as "unreadable" when it simply does not exist, and checks the Agent Skills link for skills.
- **Examples no longer point at `skills/pdf`**, which is not in the catalog; they use `skills/keynote-deck`.

### Added — every harness, not just Claude Code

- **Installed skills now reach Codex CLI, Gemini CLI, Cursor, opencode, Goose and Antigravity.** The canonical install stays at `~/.claude/skills/<slug>/` (Claude Code reads nowhere else), and it is now linked into `~/.agents/skills/<slug>/` — the Agent Skills directory that Codex, Gemini CLI, Cursor, opencode and Goose all read — and into `~/.gemini/config/skills/<slug>/` when Antigravity is present. Symlinks on macOS/Linux, copies on Windows; both are recorded in the wiring ledger so `mh uninstall` removes them and a directory that was never ours is left alone. `mh refresh` adds the links for skills installed by 0.1.0 and now persists what it wrote (issue #9).
- **The MetaHub MCP server is auto-wired into three more harnesses.** Gemini CLI (`~/.gemini/settings.json`), Antigravity (`~/.gemini/config/mcp_config.json`, with the pre-2.0 `~/.gemini/antigravity/mcp_config.json` as a fallback) and opencode (`opencode.json` / `.jsonc`, `mcp` key) get JSON entries like Cursor does. Codex CLI is wired through `codex mcp add` when the `codex` binary is on PATH; the TOML snippet remains the fallback and now includes the env table. Gemini CLI and opencode are new clients throughout (`mh install`, `mh doctor`, `mh bootstrap --status`).
- **`mh bootstrap` tells every detected harness to look on MetaHub first.** It appends a marker-fenced block to `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md` (Gemini CLI and Antigravity), `~/.config/opencode/AGENTS.md`, `~/.config/goose/.goosehints` and Windsurf's `global_rules.md`, and writes an always-apply `~/.cursor/rules/metahub.mdc`. Re-runs replace the block in place; `mh bootstrap --uninstall` removes it; `--no-instructions` or `METAHUB_NO_INSTRUCTIONS=1` opts out; `--instructions` writes only the blocks; `--status` reports which files carry it. This is the answer to [metahub-cli#18](https://github.com/metahub-ai/metahub-cli/issues/18).
- **The MCP server ships `instructions` in its `initialize` response** with the same guidance, which MCP hosts such as Claude Code place in the system prompt for the whole session. Unlike tool definitions, instructions are never deferred by tool search.
- **MCP-kind installs are made runnable before they are wired.** The registry hands out the pinned source tree, which for most TypeScript servers has no `dist/` and no `node_modules/`; 0.1.0 wired `node dist/index.js` anyway and every client failed to start it. `mh install` now runs `npm install` (lifecycle scripts disabled) and `npm run build` when that is what the package needs, reports the steps, and refuses to wire an entry point that is not on disk.
- **`npx @metahub-ai/mh bootstrap` works without a global install.** When the CLI runs from npm's npx cache, clients are wired to `npx -y --package=@metahub-ai/mh metahub-mcp` instead of a cache path npm may evict later.

### Changed

- **MCP tool descriptions rewritten for Claude Code's tool search** (on by default), which defers tool definitions and matches against tool names, descriptions and argument names/descriptions, returning five tools per search. The vocabulary users type ("registry", "marketplace", "discover", "capability", "extension", "editor") was absent from the tool surface, and seven of thirteen tools repeated the same kind-list boilerplate, crowding each other out of the five slots.
- **`metahub://catalog` is a bounded, slim browse view** (`fields=lean`, ≤200 items, `pageCounts` + `truncated`) instead of a whole-catalog dump. Measured against production: 576 ms / 183 KB, where the full projection is 8.1 s / 4.9 MB against a 15 s client timeout.
- `metahub-mcp --version` now reports the package version, so a fixed server is distinguishable from a 0.1.0 one in the field.

### Upgrade note — coming from 0.1.0

Run `mh bootstrap --force` once so every client points at the new bundle and picks up the instruction blocks, then `mh refresh` to link skills you already installed into `~/.agents/skills`. Codex, Gemini CLI, Cursor, opencode and Goose see them from the next session.

### Upgrade note — macOS users with `XDG_CONFIG_HOME` set

The installer's per-client config paths were triplicated and disagreed: one copy honoured `XDG_CONFIG_HOME` on macOS, the others did not. They now share one implementation that uses `~/.config` on macOS. If you are on macOS, export `XDG_CONFIG_HOME`, and wired a Zed or Goose MCP artifact under 0.1.0, the old entry (including its `METAHUB_INGEST_API_KEY`) still lives in `$XDG_CONFIG_HOME/{zed,goose}/` where `mh uninstall` will no longer look. Remove it by hand, or re-run `mh install` then `mh uninstall`.

## 0.1.0

- Initial standalone release. `@metahub-ai/mh`, `@metahub/mcp-server`, `@metahub/auth`, and `@metahub/installer` extracted from [metahub-monorepo](https://github.com/metahub-ai/metahub-monorepo) into this repository, with `@metahub/shared` vendored as a synced copy. Functionality is identical to the monorepo versions at the point of extraction.
