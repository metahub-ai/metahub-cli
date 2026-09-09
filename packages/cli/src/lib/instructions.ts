/**
 * Standing guidance for AI harnesses: "when a task needs a capability
 * you do not have, look on MetaHub first."
 *
 * The MetaHub MCP server carries the same guidance in its `initialize`
 * response, which Claude Code and other MCP hosts inject into the
 * system prompt. That covers every harness the server is connected to.
 * Harnesses that only have a shell (`mh`), and hosts that ignore server
 * instructions, need the text in their own global instruction file.
 * This module owns that file edit.
 *
 * Every write is a marker-fenced block, so:
 *   - re-running `mh bootstrap` replaces the block in place rather than
 *     appending a second copy,
 *   - `mh bootstrap --uninstall` removes exactly what was added,
 *   - anything the user wrote around the block is never touched.
 *
 * Cursor is the exception: its global rules are one file per rule, so
 * `metahub.mdc` is a file we own outright.
 */
import fs from "node:fs";
import path from "node:path";
import { geminiDir, getHome, userConfigDir } from "@metahub/installer";

export const INSTRUCTIONS_BEGIN = "<!-- metahub:begin -->";
export const INSTRUCTIONS_END = "<!-- metahub:end -->";

/** Windsurf caps global_rules.md; a block that would breach it is skipped. */
const WINDSURF_MAX_BYTES = 6000;

export interface InstructionTarget {
  id: string;
  label: string;
  detect: () => boolean;
  file: () => string;
  /** `markdown` appends a fenced block; `cursor-mdc` owns the whole file. */
  kind: "markdown" | "cursor-mdc";
  maxBytes?: number;
}

function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * One entry per instruction file, verified against each harness's docs:
 * Claude Code `~/.claude/CLAUDE.md`, Codex `~/.codex/AGENTS.md`, Gemini
 * CLI and Antigravity both `~/.gemini/GEMINI.md`, Cursor global rules
 * `~/.cursor/rules/*.mdc`, opencode `~/.config/opencode/AGENTS.md`,
 * Goose `~/.config/goose/.goosehints`, Windsurf
 * `~/.codeium/windsurf/memories/global_rules.md`.
 */
export const INSTRUCTION_TARGETS: InstructionTarget[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    detect: () => exists(path.join(getHome(), ".claude")),
    file: () => path.join(getHome(), ".claude", "CLAUDE.md"),
    kind: "markdown",
  },
  {
    id: "codex-cli",
    label: "Codex CLI",
    detect: () => exists(path.join(getHome(), ".codex")),
    file: () => path.join(getHome(), ".codex", "AGENTS.md"),
    kind: "markdown",
  },
  {
    id: "gemini",
    label: "Gemini CLI / Antigravity",
    detect: () => exists(geminiDir()),
    file: () => path.join(geminiDir(), "GEMINI.md"),
    kind: "markdown",
  },
  {
    id: "cursor",
    label: "Cursor",
    detect: () => exists(path.join(getHome(), ".cursor")),
    file: () => path.join(getHome(), ".cursor", "rules", "metahub.mdc"),
    kind: "cursor-mdc",
  },
  {
    id: "opencode",
    label: "opencode",
    detect: () => exists(path.join(userConfigDir(), "opencode")),
    file: () => path.join(userConfigDir(), "opencode", "AGENTS.md"),
    kind: "markdown",
  },
  {
    id: "goose",
    label: "Goose",
    detect: () => exists(path.join(userConfigDir(), "goose")),
    file: () => path.join(userConfigDir(), "goose", ".goosehints"),
    kind: "markdown",
  },
  {
    id: "windsurf",
    label: "Windsurf",
    detect: () => exists(path.join(getHome(), ".codeium", "windsurf")),
    file: () => path.join(getHome(), ".codeium", "windsurf", "memories", "global_rules.md"),
    kind: "markdown",
    maxBytes: WINDSURF_MAX_BYTES,
  },
];

/** The guidance itself, fenced. Kept short: it loads into every session. */
export function instructionBlock(): string {
  return [
    INSTRUCTIONS_BEGIN,
    "## Tool discovery via MetaHub",
    "",
    "When a task needs a capability you do not have (a file format, an external API, browser or data tooling, a domain workflow), check the MetaHub registry (https://metahub.ai) before writing one-off scripts. Artifact kinds: skill, mcp, agent, plugin.",
    "",
    "- With the MetaHub MCP server connected: call `metahub_list_installed` to see what is already here, `metahub_search` (query, optional kind) to find candidates, read each hit's description, then `metahub_install`.",
    '- From a shell: `mh search "<query>"`, `mh show <kind>/<slug>`, then `mh install <kind>/<slug>`.',
    "- Installed skills are available on the next turn. A newly installed MCP server may need the editor restarted; say so. Install only what the task needs and tell the user what you installed.",
    INSTRUCTIONS_END,
  ].join("\n");
}

function cursorRuleFile(): string {
  return [
    "---",
    "description: Discover skills and MCP servers on MetaHub when a task needs a capability you lack",
    "alwaysApply: true",
    "---",
    instructionBlock(),
    "",
  ].join("\n");
}

export type InstructionWriteStatus =
  "wrote" | "updated" | "current" | "skipped-not-detected" | "skipped-too-large" | "error";

export interface InstructionWriteResult {
  id: string;
  label: string;
  file: string;
  status: InstructionWriteStatus;
  error?: string;
}

function blockRange(text: string): { start: number; end: number } | null {
  const start = text.indexOf(INSTRUCTIONS_BEGIN);
  if (start === -1) return null;
  const endMarker = text.indexOf(INSTRUCTIONS_END, start);
  if (endMarker === -1) return null;
  return { start, end: endMarker + INSTRUCTIONS_END.length };
}

/** Merge the block into markdown `text`: replace an existing one, else append. */
function mergeBlock(text: string): { next: string; status: "wrote" | "updated" | "current" } {
  const block = instructionBlock();
  const range = blockRange(text);
  if (range) {
    if (text.slice(range.start, range.end) === block) return { next: text, status: "current" };
    return { next: text.slice(0, range.start) + block + text.slice(range.end), status: "updated" };
  }
  const trimmed = text.replace(/\s+$/, "");
  const next = trimmed.length === 0 ? `${block}\n` : `${trimmed}\n\n${block}\n`;
  return { next, status: "wrote" };
}

/** Remove the block from markdown `text`, tidying the blank lines around it. */
function stripBlock(text: string): string | null {
  const range = blockRange(text);
  if (!range) return null;
  const before = text.slice(0, range.start).replace(/\n{2,}$/, "\n");
  const after = text.slice(range.end).replace(/^\n+/, "");
  const joined = before.length > 0 && after.length > 0 ? `${before}\n${after}` : before + after;
  return joined.replace(/\s+$/, "") + (joined.trim().length > 0 ? "\n" : "");
}

/** Write the block into every detected harness's global instruction file. */
export function writeInstructionBlocks(): InstructionWriteResult[] {
  const out: InstructionWriteResult[] = [];
  for (const t of INSTRUCTION_TARGETS) {
    const file = t.file();
    const base = { id: t.id, label: t.label, file };
    if (!t.detect()) {
      out.push({ ...base, status: "skipped-not-detected" });
      continue;
    }
    try {
      if (t.kind === "cursor-mdc") {
        const desired = cursorRuleFile();
        const current = exists(file) ? fs.readFileSync(file, "utf8") : null;
        if (current === desired) {
          out.push({ ...base, status: "current" });
          continue;
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, desired, "utf8");
        out.push({ ...base, status: current === null ? "wrote" : "updated" });
        continue;
      }
      const current = exists(file) ? fs.readFileSync(file, "utf8") : "";
      const { next, status } = mergeBlock(current);
      if (status === "current") {
        out.push({ ...base, status });
        continue;
      }
      if (t.maxBytes !== undefined && Buffer.byteLength(next, "utf8") > t.maxBytes) {
        out.push({ ...base, status: "skipped-too-large" });
        continue;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, next, "utf8");
      out.push({ ...base, status });
    } catch (err) {
      out.push({ ...base, status: "error", error: (err as Error).message });
    }
  }
  return out;
}

export type InstructionRemoveStatus = "removed" | "absent" | "error";

export interface InstructionRemoveResult {
  id: string;
  label: string;
  file: string;
  status: InstructionRemoveStatus;
  error?: string;
}

/** Remove the block (or, for Cursor, the rule file) from every target. */
export function removeInstructionBlocks(): InstructionRemoveResult[] {
  const out: InstructionRemoveResult[] = [];
  for (const t of INSTRUCTION_TARGETS) {
    const file = t.file();
    const base = { id: t.id, label: t.label, file };
    try {
      if (!exists(file)) {
        out.push({ ...base, status: "absent" });
        continue;
      }
      if (t.kind === "cursor-mdc") {
        fs.unlinkSync(file);
        out.push({ ...base, status: "removed" });
        continue;
      }
      const current = fs.readFileSync(file, "utf8");
      const next = stripBlock(current);
      if (next === null) {
        out.push({ ...base, status: "absent" });
        continue;
      }
      if (next.trim().length === 0) {
        // The file held nothing but our block; leave no empty file behind.
        fs.unlinkSync(file);
      } else {
        fs.writeFileSync(file, next, "utf8");
      }
      out.push({ ...base, status: "removed" });
    } catch (err) {
      out.push({ ...base, status: "error", error: (err as Error).message });
    }
  }
  return out;
}

export interface InstructionStatusRow {
  id: string;
  label: string;
  file: string;
  state: "present" | "stale" | "absent" | "not-detected";
}

/** Per-target presence report for `mh bootstrap --status`. */
export function instructionStatus(): InstructionStatusRow[] {
  return INSTRUCTION_TARGETS.map((t) => {
    const file = t.file();
    const base = { id: t.id, label: t.label, file };
    if (!t.detect()) return { ...base, state: "not-detected" as const };
    if (!exists(file)) return { ...base, state: "absent" as const };
    const text = fs.readFileSync(file, "utf8");
    const range = blockRange(text);
    if (!range) return { ...base, state: "absent" as const };
    const current = text.slice(range.start, range.end) === instructionBlock();
    return { ...base, state: current ? ("present" as const) : ("stale" as const) };
  });
}
