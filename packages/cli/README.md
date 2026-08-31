# @metahub-ai/mh

The `mh` binary, the terminal interface for MetaHub. Search, install, update, uninstall, list, and sign in to MetaHub artifacts from a shell.

The CLI is a thin wrapper. All install, uninstall, and auth logic lives in shared libraries:

- [`@metahub/installer`](../installer/README.md) owns the install ledger at `~/.metahub/installs.json`, the multi-client MCP wiring, tarball fetch + extract, and the high-level `installArtifact` / `uninstallArtifact` / `listInstalled` orchestration.
- [`@metahub/auth`](../auth/README.md) owns the persisted token at `~/.metahub/config.json` and the GitHub device-code flow against the portal.

The CLI commands (`install`, `uninstall`, `list`, `update`, `login`, `outdated`, `search`, `show`, `doctor`, `trace`) call those libraries and add the terminal UI (progress lines, post-install summary, prompts). If you want the same behaviour from an AI client instead of a terminal, use [`@metahub/mcp-server`](../mcp-server/README.md), which is built on the same two libraries and shares state with the CLI: install via the MCP server, then `mh list` shows it; run `mh login`, then the MCP server's authenticated tools work without re-signing in.

## When to use the CLI

The CLI and the MCP server are complementary.

| Surface                                          | Best for                                                       |
| ------------------------------------------------ | -------------------------------------------------------------- |
| `mh` CLI                                         | Power users, CI, dotfiles, scripted installs, exact reruns     |
| [`@metahub/mcp-server`](../mcp-server/README.md) | In-editor discovery, prompt-driven install, browsing by intent |

## Install

### npm

```bash
npm install -g @metahub-ai/mh
mh bootstrap
mh --version
```

`mh bootstrap` connects the bundled MetaHub MCP server to supported AI clients
after an npm installation.

### Shell installer

```bash
curl -fsSL https://metahub.ai/install.sh | sh
mh --version
```

The installer downloads a self-contained tarball from
`registry.metahub.ai/cli/mh-latest.tgz` and installs it via your
local package manager. Both `mh` and `metahub-mcp` land on PATH.
It also runs the editor bootstrap automatically. Both installation paths ship
the same standalone bundle.

You can substitute `pnpm add -g @metahub-ai/mh` or
`bun add -g @metahub-ai/mh` for the npm command.

## Use

```bash
mh search pdf
mh install skills/pdf
mh list
mh update skills/pdf
mh uninstall skills/pdf
mh login
mh outdated
mh doctor
```

See [`docs/INSTALL.md`](../../docs/INSTALL.md) for the full end-user guide and [`docs/MCP_SERVER.md`](../../docs/MCP_SERVER.md) for the AI-client alternative.

## Sample output

The CLI uses a consistent visual language across commands. Headers are accent-colored brackets (`[install]`, `[search]`, `[doctor]`). Progress steps render with a green `✓` for success / yellow `⚠` for warning / red `✗` for failure / dim `▸` for in-progress. Paths are tildeified (`~/.claude/skills/foo`, not `/Users/<you>/.claude/...`). Versions and SHAs render in cyan. Durations show in milliseconds-aware form (`234ms`, `1.4s`, `2m 5s`).

```text
$ mh install skills/pdf
[install]  skill/pdf

  ▸ resolve    checking catalog…
  ⚠ replace    existing install at ~/.claude/skills/pdf
  ✓ download   2964d6a  (subdir skills/pdf)  333ms
  ✓ wire       telemetry sidecar  1.1s

  pdf  v0.1.0  in 1.4s
    Pinned     2964d6a
    Location   ~/.claude/skills/pdf
    Telemetry  ~/.claude/skills/pdf/.metahub.json

  Next steps
    ▸ Restart Claude Code / Claude Desktop to pick up the new skill
    ▸ Use the skill from your AI client — spans flow to developer.metahub.ai
    ▸ Publisher-driven spans? Add `mh trace skill/pdf` to SKILL.md

  To remove: mh uninstall skills/pdf
```

```text
$ mh outdated
[outdated]  1 update available                                    ── 3 unchecked

  Available
    skills/algorithmic-art  v0.1.0  2964d6a → 690f15c  1 day ago

  Unchecked  (no public catalog entry — curator imports or private artifacts)
    skills/pptx
    skills/webapp-testing
    skills/canvas-design

  Run mh update <ref> or mh update --all
```

```text
$ mh doctor skill/frontend-design1
[doctor]  skill/frontend-design1                         ── 4 of 4 checks passed

  ✓ install dir         ~/.claude/skills/frontend-design1 (dir)
  ✓ telemetry sidecar   mhi_bHcX…  artifact art_409f3151…
  ✓ claude code path    ~/.claude/skills/frontend-design1
  ✓ SKILL.md            ~/.claude/skills/frontend-design1/SKILL.md

  Pinned at 2964d6a
```

## CLI style guide (for contributors)

Every command imports its visual primitives from [`src/lib/ui.ts`](./src/lib/ui.ts):

- `header(label, subtitle?, trailing?)` — the `[label] subtitle ── trailing` one-liner that opens output for a major command.
- `step(status, label, value)` — a single progress row with the `✓`/`⚠`/`✗`/`▸` glyph + column-aligned value.
- `kv([[key, value], …])` — column-aligned key/value rows. Indented 2 spaces; key column dimmed.
- `box(content)` — unicode frame for emphasis (login device code).
- `spinner(initial)` — cursor-overwriting braille spinner. Falls back to a single printed line when stdout isn't a TTY.
- `c.bold / dim / accent / red / green / yellow / cyan / muted` — style helpers. ALL of them auto no-op under `NO_COLOR=1` and when stdout isn't a TTY.
- `tildeify(path)` — collapse `/Users/<you>/.x` to `~/.x`. Use this on every path you print.
- `relTime(date)` / `bytes(n)` / `ms(n)` — human-friendly formatters.
- `link(label, url)` — OSC 8 hyperlink in modern terminals, plain `label (url)` everywhere else.

**Rules**

1. Never reach for raw `\x1b[...m` ANSI escapes in command files — go through `c.*` so `NO_COLOR` works automatically.
2. Never use emoji beyond `✓ ✗ ⚠ ▸ ★` (the core unicode set we've verified across iTerm2, Ghostty, Wezterm, GNOME Terminal, Windows Terminal).
3. Always tildeify paths before printing.
4. Errors go to `stderr` (`console.error`); progress and success go to `stdout`.
5. Exit codes: `0` = success, `1` = real failure (network, auth, missing install), `2` = usage error.
6. Tests run with `NO_COLOR=1` baked into the vitest env so snapshot output stays deterministic across local + CI.

## Machine-readable output: `--json`

Read-only commands (`search`, `show`, `list`, `outdated`, `doctor`) accept a `--json` flag and emit a stable JSON document to stdout (no headers, no ANSI). Errors emit `{"error": {"code": "...", "message": "..."}}` to stderr; exit codes are unchanged.

`mh search --json <query>`:

```json
{
  "query": "pdf",
  "kind": "skill",
  "count": 3,
  "results": [{ "kind": "skill", "slug": "pdf", "name": "PDF", "tagline": "…", "version": "0.1.0" }]
}
```

`mh show --json <kind>/<slug>`:

```json
{
  "kind": "skill",
  "slug": "pdf",
  "ref": "skills/pdf",
  "name": "PDF",
  "tagline": "…",
  "description": "…",
  "version": "0.1.0",
  "publishedSha": "…",
  "publishedAt": "2026-…",
  "authorHandle": "…",
  "repoUrl": "https://github.com/…",
  "repoBranch": "main",
  "tags": [],
  "badges": [],
  "reviewSummary": { "count": 0, "avg": 0 },
  "installed": null
}
```

`mh list --json`:

```json
{
  "count": 1,
  "installs": [
    {
      "kind": "skill",
      "slug": "pdf",
      "ref": "skills/pdf",
      "version": "0.1.0",
      "publishedSha": "…",
      "installPath": "/Users/you/.claude/skills/pdf",
      "installedAt": "2026-…",
      "artifactId": "art_…",
      "installId": "ins_…"
    }
  ]
}
```

`mh outdated --json`:

```json
{
  "count": 1,
  "available": [
    {
      "ref": "skills/pdf",
      "localSha": "2964d6a",
      "remoteSha": "690f15c",
      "remoteVersion": "0.1.1",
      "publishedAt": "2026-…"
    }
  ],
  "unchecked": ["skills/canvas-design"]
}
```

`mh doctor --json <kind>/<slug>`:

```json
{
  "ref": "skills/pdf",
  "installed": true,
  "pinnedSha": "…",
  "passed": 4,
  "failed": 0,
  "checks": [{ "status": "ok", "label": "install dir", "value": "~/.claude/skills/pdf (dir)" }]
}
```
