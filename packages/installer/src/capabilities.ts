/**
 * Capability matrix — declarative source of truth for what each AI
 * client can consume and where its artifacts live on disk.
 *
 * Today, `hooks.ts` had hardcoded logic ("if kind === 'skill' put it
 * at ~/.claude/skills/..."). That's fine for one client but doesn't
 * scale: Cursor wants rules in `.cursor/rules/`, Continue wants them
 * in `~/.continue/rules/`, Zed exposes them as slash-command prompts,
 * etc.
 *
 * The matrix below is the single place where we declare:
 *   - Which clients CAN consume each artifact kind (skill / mcp /
 *     plugin / agent).
 *   - Where on disk each client expects that kind to live.
 *   - Which format the content needs to be in (verbatim SKILL.md vs.
 *     transformed `.mdc` for Cursor vs. YAML rules for Continue).
 *   - How the client picks up changes — hot-mtime (no restart),
 *     mcp-rpc (notification can be sent), or restart-required.
 *
 * Adding support for a new client + kind is a matter of adding an
 * entry here and a transformer in `skill-transformers.ts`. No code
 * paths in install.ts / hooks.ts / uninstall.ts need to change.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ArtifactKind } from "@metahub/shared";

/**
 * Stable identifier for each AI client we know about. Used as the
 * key in the wiring ledger and in artifact-config / `--only=<id>`
 * flags. The string values match the lowercased ClientAdapter.name
 * with spaces collapsed to dashes.
 */
export type ClientId =
  | "claude-code"
  | "claude-desktop"
  | "cursor"
  | "antigravity"
  | "vs-code"
  | "zed"
  | "windsurf"
  | "continue"
  | "cline"
  | "goose"
  | "codex-cli"
  | "opencode";

/**
 * How a (client, kind) pair is consumed. Each value implies a
 * transformer + a target-path convention.
 *
 *   anthropic-skill-md  : verbatim SKILL.md + frontmatter, dropped as
 *                         a folder per skill. Claude Code's native
 *                         format.
 *   cursor-rule-mdc     : Cursor 0.42+ rules format. A single .mdc
 *                         file per rule with YAML frontmatter:
 *                         `description`, optional `globs`. Body is
 *                         markdown.
 *   continue-rule-md    : Continue's per-rule markdown file with
 *                         YAML frontmatter: `name`, `if`, etc.
 *   zed-prompt-md       : Zed's slash-command prompts directory.
 *                         Plain markdown; filename becomes the slash
 *                         command.
 *   claude-plugin       : Claude Code's plugin bundle directory under
 *                         ~/.claude/plugins/<slug>/. Verbatim.
 *   mcp-json            : MCP server entry written into a JSON config
 *                         under `mcpServers` / `servers` /
 *                         `context_servers` (varies per client). The
 *                         existing wireMcpAcrossClients() handles
 *                         this; the matrix just declares which
 *                         clients are eligible.
 *   mcp-manual          : MCP servers handled via a manual paste
 *                         snippet (YAML / TOML / UI).
 *   node-import         : Node module imported by the developer; no
 *                         file goes anywhere on the AI client side.
 *   none                : Client doesn't consume this kind at all.
 */
export type WiringStrategy =
  | "anthropic-skill-md"
  | "opencode-skill-md"
  | "cursor-rule-mdc"
  | "continue-rule-md"
  | "zed-prompt-md"
  | "claude-plugin"
  | "mcp-json"
  | "mcp-manual"
  | "node-import"
  | "none";

/**
 * How a client picks up changes after we write.
 *   hot-mtime      : the client mtime-watches the path; no action
 *                    needed. We optionally `touch` the parent config
 *                    to force a debounce-reload.
 *   mcp-rpc        : if we have an active MCP connection (the
 *                    future-aware daemon does), we can send
 *                    `notifications/tools/list_changed`.
 *   restart-required: client only loads at startup; print precise hint.
 *   unknown        : we don't have a story yet — print generic hint.
 */
export type ReloadStrategy = "hot-mtime" | "mcp-rpc" | "restart-required" | "unknown";

/**
 * One entry in the matrix.
 */
export interface CapabilityRow {
  client: ClientId;
  kind: ArtifactKind;
  strategy: WiringStrategy;
  /** Reload strategy for this (client, kind) pair specifically. */
  reload: ReloadStrategy;
  /** Per-client precise reload hint when `reload === "restart-required"`. */
  reloadHint?: string;
  /**
   * Where on disk this kind lives for this client. Returns the path
   * that the install pipeline will write the artifact's content to.
   * Returns null when the kind isn't supported (kept for consistency
   * with the matrix lookup signature; callers should also check
   * strategy !== "none" before using).
   */
  targetPath: (slug: string) => string | null;
}

const HOME = os.homedir();

function xdgConfigDir(): string {
  if (process.platform === "darwin") return path.join(HOME, ".config");
  if (process.platform === "win32") {
    return process.env.APPDATA ?? path.join(HOME, "AppData", "Roaming");
  }
  return process.env.XDG_CONFIG_HOME ?? path.join(HOME, ".config");
}

function claudeDesktopDir(): string {
  if (process.platform === "darwin") {
    return path.join(HOME, "Library", "Application Support", "Claude");
  }
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA ?? path.join(HOME, "AppData", "Roaming");
    return path.join(appdata, "Claude");
  }
  return path.join(HOME, ".config", "Claude");
}

/**
 * Where opencode keeps its global config: ~/.config/opencode/opencode.json
 * (or .jsonc — the docs accept both; if a .jsonc already exists we target
 * that so we don't split a user's config across two files).
 *
 * The same helper is the single source of truth the opencode MCP adapter
 * in clients.ts uses, so the capability matrix and the adapter always agree.
 */
export function openCodeConfigPath(): string {
  const dir = path.join(xdgConfigDir(), "opencode");
  const jsonc = path.join(dir, "opencode.jsonc");
  try {
    const st = fs.statSync(jsonc);
    if (st.isFile()) return jsonc;
  } catch {
    /* no existing .jsonc — fall through to .json */
  }
  return path.join(dir, "opencode.json");
}

/**
 * The matrix. One row per (client, kind) — we omit "none" rows to
 * keep the table easy to read. Anything not listed = none.
 *
 * Skills wiring:
 *   - claude-code   : folder under ~/.claude/skills/<slug>/
 *   - opencode      : folder under ~/.config/opencode/skills/<slug>/ —
 *                     opencode reads the same verbatim SKILL.md format.
 *   - cursor        : ~/.cursor/rules/<slug>.mdc  (Cursor 0.42+, global rules)
 *   - continue      : ~/.continue/rules/<slug>.md
 *   - zed           : ~/.config/zed/prompts/<slug>.md
 *   - everyone else : none (manual hint via the wiring report)
 *
 * Plugins wiring:
 *   - claude-code   : folder under ~/.claude/plugins/<slug>/
 *   - everyone else : none (no portable plugin bundle format exists)
 *
 * MCP wiring: matches the existing wireMcpAcrossClients() set.
 *
 * Agents: node-import (no client wiring), regardless of client.
 */
export const CAPABILITY_MATRIX: CapabilityRow[] = [
  // ─── skills ────────────────────────────────────────────────────────
  {
    client: "claude-code",
    kind: "skill",
    strategy: "anthropic-skill-md",
    reload: "hot-mtime",
    targetPath: (slug) => path.join(HOME, ".claude", "skills", slug),
  },
  {
    client: "cursor",
    kind: "skill",
    strategy: "cursor-rule-mdc",
    reload: "hot-mtime",
    targetPath: (slug) => path.join(HOME, ".cursor", "rules", `${slug}.mdc`),
  },
  {
    client: "continue",
    kind: "skill",
    strategy: "continue-rule-md",
    reload: "hot-mtime",
    targetPath: (slug) => path.join(HOME, ".continue", "rules", `${slug}.md`),
  },
  {
    client: "zed",
    kind: "skill",
    strategy: "zed-prompt-md",
    reload: "hot-mtime",
    targetPath: (slug) => path.join(xdgConfigDir(), "zed", "prompts", `${slug}.md`),
  },
  {
    // opencode loads global skills from ~/.config/opencode/skills/<slug>/
    // using the same verbatim SKILL.md format as Claude Code — the whole
    // folder is copied (opencode-skill-md) so supporting files ride along.
    client: "opencode",
    kind: "skill",
    strategy: "opencode-skill-md",
    reload: "hot-mtime",
    targetPath: (slug) => path.join(xdgConfigDir(), "opencode", "skills", slug),
  },

  // ─── plugins ───────────────────────────────────────────────────────
  {
    client: "claude-code",
    kind: "plugin",
    strategy: "claude-plugin",
    reload: "restart-required",
    reloadHint: "Restart Claude Code so it discovers the new plugin bundle.",
    targetPath: (slug) => path.join(HOME, ".claude", "plugins", slug),
  },

  // ─── MCP servers ──────────────────────────────────────────────────
  {
    client: "claude-code",
    kind: "mcp",
    strategy: "mcp-json",
    reload: "mcp-rpc",
    reloadHint: "Run `/mcp` in Claude Code to reconnect.",
    targetPath: () => path.join(HOME, ".claude", "settings.json"),
  },
  {
    client: "claude-desktop",
    kind: "mcp",
    strategy: "mcp-json",
    reload: "restart-required",
    reloadHint: "Quit Claude Desktop (Cmd/Ctrl+Q) and reopen — MCP servers load only at launch.",
    targetPath: () => path.join(claudeDesktopDir(), "claude_desktop_config.json"),
  },
  {
    client: "cursor",
    kind: "mcp",
    strategy: "mcp-json",
    reload: "hot-mtime",
    targetPath: () => path.join(HOME, ".cursor", "mcp.json"),
  },
  {
    client: "antigravity",
    kind: "mcp",
    strategy: "mcp-manual",
    reload: "restart-required",
    reloadHint: "Open Antigravity → Settings → MCP servers and paste the snippet.",
    targetPath: () => "Antigravity → Settings → MCP servers",
  },
  {
    client: "vs-code",
    kind: "mcp",
    strategy: "mcp-json",
    reload: "restart-required",
    reloadHint: "Cmd/Ctrl+Shift+P → Developer: Reload Window.",
    targetPath: () => path.join(process.cwd(), ".vscode", "mcp.json"),
  },
  {
    client: "zed",
    kind: "mcp",
    strategy: "mcp-json",
    reload: "hot-mtime",
    targetPath: () => path.join(xdgConfigDir(), "zed", "settings.json"),
  },
  {
    client: "windsurf",
    kind: "mcp",
    strategy: "mcp-json",
    reload: "hot-mtime",
    targetPath: () => path.join(HOME, ".codeium", "windsurf", "mcp_config.json"),
  },
  {
    client: "continue",
    kind: "mcp",
    strategy: "mcp-manual",
    reload: "hot-mtime",
    targetPath: () => path.join(HOME, ".continue", "config.yaml"),
  },
  {
    client: "cline",
    kind: "mcp",
    strategy: "mcp-manual",
    reload: "restart-required",
    reloadHint: "Open the Cline panel → MCP Servers → Add and paste the snippet.",
    targetPath: () => "Cline panel → MCP Servers → Add",
  },
  {
    client: "goose",
    kind: "mcp",
    strategy: "mcp-manual",
    reload: "restart-required",
    reloadHint: "Restart Goose so the new extension is picked up.",
    targetPath: () => path.join(xdgConfigDir(), "goose", "config.yaml"),
  },
  {
    client: "codex-cli",
    kind: "mcp",
    strategy: "mcp-manual",
    reload: "restart-required",
    reloadHint: "Restart your Codex CLI shell so the new MCP server is loaded.",
    targetPath: () => path.join(HOME, ".codex", "config.toml"),
  },
  {
    // opencode declares stdio MCP servers under the `mcp` key of
    // ~/.config/opencode/opencode.json (or .jsonc). Auto-merged by a
    // dedicated adapter in clients.ts; reloaded hot on config change.
    client: "opencode",
    kind: "mcp",
    strategy: "mcp-json",
    reload: "hot-mtime",
    reloadHint: "Restart the opencode session so the new MCP server is loaded.",
    targetPath: () => openCodeConfigPath(),
  },

  // ─── agents ────────────────────────────────────────────────────────
  // Agents are imported by the developer's own Node code; no client
  // wiring needed. We still surface them in the matrix so install
  // output can show "no client wiring (imported from your Node app)".
  {
    client: "claude-code",
    kind: "agent",
    strategy: "node-import",
    reload: "unknown",
    targetPath: () => null,
  },
];

/**
 * Quick lookup. Returns null when (client, kind) isn't in the matrix
 * — caller treats that as "this client doesn't consume this kind".
 */
export function capabilityFor(client: ClientId, kind: ArtifactKind): CapabilityRow | null {
  return CAPABILITY_MATRIX.find((r) => r.client === client && r.kind === kind) ?? null;
}

/**
 * All clients that CAN consume the given kind. Used by the install
 * pipeline to know which adapters to invoke for a wire-to-all install.
 */
export function clientsForKind(kind: ArtifactKind): CapabilityRow[] {
  return CAPABILITY_MATRIX.filter((r) => r.kind === kind && r.strategy !== "none");
}
