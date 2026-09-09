/**
 * Capability matrix — declarative source of truth for what each AI
 * client can consume and where its artifacts live on disk.
 *
 * The matrix is the single place where we declare:
 *   - Which clients CAN consume each artifact kind (skill / mcp /
 *     plugin / agent).
 *   - Where on disk each client expects that kind to live.
 *   - Which format the content needs to be in (verbatim SKILL.md
 *     folder, a link to it, a transformed rule file, ...).
 *   - How the client picks up changes — hot-mtime (no restart),
 *     mcp-rpc (notification can be sent), or restart-required.
 *
 * Adding support for a new client + kind is a matter of adding an
 * entry here (and, for a new file format, a transformer in
 * `skill-transformers.ts`). No code paths in install.ts / hooks.ts /
 * uninstall.ts need to change.
 */
import path from "node:path";
import {
  agentsSkillsDir,
  antigravityMcpConfigPath,
  antigravitySkillsDir,
  claudeDesktopDir,
  geminiSettingsFile,
  getHome,
  openCodeConfigPath,
  userConfigDir,
} from "./paths.js";
import type { ArtifactKind } from "@metahub/shared";

/**
 * Stable identifier for each AI client we know about. Used as the
 * key in the wiring ledger and in artifact-config / `--only=<id>`
 * flags. The string values match the lowercased ClientAdapter.name
 * with spaces collapsed to dashes.
 *
 * `agents-dir` is not a client. It names the shared Agent Skills
 * directory (`~/.agents/skills`) that Codex CLI, Gemini CLI, Cursor,
 * opencode and Goose all read, so a skill linked there once is visible
 * to every one of them.
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
  | "gemini-cli"
  | "opencode"
  | "agents-dir";

/**
 * How a (client, kind) pair is consumed. Each value implies a
 * transformer + a target-path convention.
 *
 *   anthropic-skill-md  : verbatim SKILL.md + frontmatter, dropped as
 *                         a folder per skill. Claude Code's native
 *                         format and the canonical install.
 *   skill-dir-link      : the canonical skill folder linked (symlink on
 *                         macOS/Linux, copy on Windows) into another
 *                         directory that a harness reads verbatim.
 *   skill-native        : nothing to write — the client reads a
 *                         directory we already populate (the canonical
 *                         folder or the Agent Skills directory). Listed
 *                         so install output can say so.
 *   cursor-rule-mdc     : legacy. Cursor now loads SKILL.md folders
 *                         natively, so no row uses this any more; the
 *                         value survives so ledgers written by 0.1.0
 *                         still unwire cleanly.
 *   continue-rule-md    : Continue's per-rule markdown file with
 *                         YAML frontmatter: `name`, `if`, etc.
 *   zed-prompt-md       : Zed's slash-command prompts directory.
 *                         Plain markdown; filename becomes the slash
 *                         command.
 *   claude-plugin       : Claude Code's plugin bundle directory under
 *                         ~/.claude/plugins/<slug>/. Verbatim.
 *   mcp-json            : MCP server entry written into a JSON config
 *                         under `mcpServers` / `servers` /
 *                         `context_servers` / `mcp` (varies per
 *                         client). `wireMcpAcrossClients()` handles
 *                         this; the matrix just declares which
 *                         clients are eligible.
 *   mcp-manual          : MCP servers handled via a manual paste
 *                         snippet (YAML / TOML / UI), or by shelling
 *                         out to the client's own CLI when present.
 *   node-import         : Node module imported by the developer; no
 *                         file goes anywhere on the AI client side.
 *   none                : Client doesn't consume this kind at all.
 */
export type WiringStrategy =
  | "anthropic-skill-md"
  | "skill-dir-link"
  | "skill-native"
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
   * that the install pipeline will write the artifact's content to
   * (or, for `skill-native`, the directory the client reads it from).
   * Returns null when the kind isn't supported (kept for consistency
   * with the matrix lookup signature; callers should also check
   * strategy !== "none" before using).
   */
  targetPath: (slug: string) => string | null;
}

/**
 * The matrix. One row per (client, kind) — we omit "none" rows to
 * keep the table easy to read. Anything not listed = none.
 *
 * Skills wiring:
 *   - claude-code   : canonical folder under ~/.claude/skills/<slug>/
 *   - agents-dir    : link to it under ~/.agents/skills/<slug>/ — the
 *                     Agent Skills standard location
 *   - antigravity   : link under ~/.gemini/config/skills/<slug>/
 *   - cursor, codex-cli, gemini-cli, opencode, goose
 *                   : native readers of one of the two above; nothing
 *                     to write
 *   - continue      : ~/.continue/rules/<slug>.md
 *   - zed           : ~/.config/zed/prompts/<slug>.md
 *   - everyone else : none
 *
 * Plugins wiring:
 *   - claude-code   : folder under ~/.claude/plugins/<slug>/
 *   - everyone else : none (no portable plugin bundle format exists)
 *
 * MCP wiring: matches the `wireMcpAcrossClients()` adapter set.
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
    targetPath: (slug) => path.join(getHome(), ".claude", "skills", slug),
  },
  {
    client: "agents-dir",
    kind: "skill",
    strategy: "skill-dir-link",
    reload: "hot-mtime",
    targetPath: (slug) => path.join(agentsSkillsDir(), slug),
  },
  {
    client: "antigravity",
    kind: "skill",
    strategy: "skill-dir-link",
    reload: "hot-mtime",
    targetPath: (slug) => path.join(antigravitySkillsDir(), slug),
  },
  {
    client: "cursor",
    kind: "skill",
    strategy: "skill-native",
    reload: "hot-mtime",
    targetPath: (slug) => path.join(agentsSkillsDir(), slug),
  },
  {
    client: "codex-cli",
    kind: "skill",
    strategy: "skill-native",
    reload: "hot-mtime",
    targetPath: (slug) => path.join(agentsSkillsDir(), slug),
  },
  {
    client: "gemini-cli",
    kind: "skill",
    strategy: "skill-native",
    reload: "hot-mtime",
    targetPath: (slug) => path.join(agentsSkillsDir(), slug),
  },
  {
    client: "opencode",
    kind: "skill",
    strategy: "skill-native",
    reload: "hot-mtime",
    targetPath: (slug) => path.join(agentsSkillsDir(), slug),
  },
  {
    client: "goose",
    kind: "skill",
    strategy: "skill-native",
    reload: "hot-mtime",
    targetPath: (slug) => path.join(agentsSkillsDir(), slug),
  },
  {
    client: "continue",
    kind: "skill",
    strategy: "continue-rule-md",
    reload: "hot-mtime",
    targetPath: (slug) => path.join(getHome(), ".continue", "rules", `${slug}.md`),
  },
  {
    client: "zed",
    kind: "skill",
    strategy: "zed-prompt-md",
    reload: "hot-mtime",
    targetPath: (slug) => path.join(userConfigDir(), "zed", "prompts", `${slug}.md`),
  },

  // ─── plugins ───────────────────────────────────────────────────────
  {
    client: "claude-code",
    kind: "plugin",
    strategy: "claude-plugin",
    reload: "restart-required",
    reloadHint: "Restart Claude Code so it discovers the new plugin bundle.",
    targetPath: (slug) => path.join(getHome(), ".claude", "plugins", slug),
  },

  // ─── MCP servers ──────────────────────────────────────────────────
  {
    client: "claude-code",
    kind: "mcp",
    strategy: "mcp-json",
    reload: "mcp-rpc",
    reloadHint: "Run `/mcp` in Claude Code to reconnect.",
    targetPath: () => path.join(getHome(), ".claude.json"),
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
    targetPath: () => path.join(getHome(), ".cursor", "mcp.json"),
  },
  {
    client: "antigravity",
    kind: "mcp",
    strategy: "mcp-json",
    reload: "restart-required",
    reloadHint: "Open Antigravity → Settings → MCP servers and refresh, or restart Antigravity.",
    targetPath: () => antigravityMcpConfigPath(),
  },
  {
    client: "gemini-cli",
    kind: "mcp",
    strategy: "mcp-json",
    reload: "restart-required",
    reloadHint: "Restart Gemini CLI (or run /mcp refresh) to load the new server.",
    targetPath: () => geminiSettingsFile(),
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
    targetPath: () => path.join(userConfigDir(), "zed", "settings.json"),
  },
  {
    client: "windsurf",
    kind: "mcp",
    strategy: "mcp-json",
    reload: "hot-mtime",
    targetPath: () => path.join(getHome(), ".codeium", "windsurf", "mcp_config.json"),
  },
  {
    client: "opencode",
    kind: "mcp",
    strategy: "mcp-json",
    reload: "restart-required",
    reloadHint: "Start a new opencode session so the new MCP server is loaded.",
    targetPath: () => openCodeConfigPath(),
  },
  {
    client: "continue",
    kind: "mcp",
    strategy: "mcp-manual",
    reload: "hot-mtime",
    targetPath: () => path.join(getHome(), ".continue", "config.yaml"),
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
    targetPath: () => path.join(userConfigDir(), "goose", "config.yaml"),
  },
  {
    client: "codex-cli",
    kind: "mcp",
    strategy: "mcp-manual",
    reload: "restart-required",
    reloadHint: "Restart your Codex CLI session so the new MCP server is loaded.",
    targetPath: () => path.join(getHome(), ".codex", "config.toml"),
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

/** Human label for a client id, shared by the CLI and the install summary. */
export function clientLabel(id: ClientId): string {
  switch (id) {
    case "claude-code":
      return "Claude Code";
    case "claude-desktop":
      return "Claude Desktop";
    case "cursor":
      return "Cursor";
    case "antigravity":
      return "Antigravity";
    case "vs-code":
      return "VS Code";
    case "zed":
      return "Zed";
    case "windsurf":
      return "Windsurf";
    case "continue":
      return "Continue";
    case "cline":
      return "Cline";
    case "goose":
      return "Goose";
    case "codex-cli":
      return "Codex CLI";
    case "gemini-cli":
      return "Gemini CLI";
    case "opencode":
      return "opencode";
    case "agents-dir":
      return "Agent Skills dir";
  }
}

/** Map a ClientAdapter display name back to its id. Unknown names pass through. */
export function clientIdFromLabel(name: string): ClientId {
  switch (name) {
    case "Claude Code":
      return "claude-code";
    case "Claude Desktop":
      return "claude-desktop";
    case "Cursor":
      return "cursor";
    case "Antigravity":
      return "antigravity";
    case "VS Code":
      return "vs-code";
    case "Zed":
      return "zed";
    case "Windsurf":
      return "windsurf";
    case "Continue":
      return "continue";
    case "Cline":
      return "cline";
    case "Goose":
      return "goose";
    case "Codex CLI":
      return "codex-cli";
    case "Gemini CLI":
      return "gemini-cli";
    case "opencode":
      return "opencode";
    case "Agent Skills dir":
      return "agents-dir";
  }
  return name as ClientId;
}
