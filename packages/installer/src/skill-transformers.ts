/**
 * Per-client skill transformers.
 *
 * A "skill" in MetaHub is conceptually a markdown document + frontmatter
 * that tells the AI when to invoke it ("triggers") and what to do.
 * Different clients consume that data in different shapes:
 *
 *   Claude Code — verbatim SKILL.md inside a per-skill folder.
 *   Cursor      — single .mdc file under ~/.cursor/rules/ with a
 *                 YAML frontmatter block: `description`, optional
 *                 `globs`, optional `alwaysApply`.
 *   Continue    — single .md file under ~/.continue/rules/ with a
 *                 minimal YAML frontmatter: `name`, `if` (free-form
 *                 description of when to apply).
 *   Zed         — plain .md under ~/.config/zed/prompts/. Filename
 *                 becomes the slash command (`/<filename>`).
 *
 * All four start from the SAME SKILL.md content. The transformers
 * below take the source (`SKILL.md` text + parsed frontmatter +
 * slug) and emit the right shape for the target client.
 *
 * Keeping these pure (string → string) makes them trivially
 * snapshot-testable.
 */
import type { WiringStrategy } from "./capabilities.js";

/**
 * What every transformer takes. The source is the verbatim SKILL.md
 * pulled from the install dir.
 */
export interface SkillSource {
  slug: string;
  /** Full SKILL.md text including the YAML frontmatter. */
  raw: string;
  /** Parsed frontmatter fields when present. */
  frontmatter: {
    name?: string;
    description?: string;
    triggers?: string[];
  };
  /** Body text (post-frontmatter), stripped of leading whitespace. */
  body: string;
}

/**
 * Parse a SKILL.md file into the SkillSource shape. Tolerant — if
 * the frontmatter is missing or malformed we fall through to a body-
 * only source. (The eval pipeline catches this earlier; this is
 * defensive in case the file on disk differs from what the eval
 * saw at publish time.)
 */
export function parseSkillSource(slug: string, raw: string): SkillSource {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) {
    return { slug, raw, frontmatter: {}, body: raw.trim() };
  }
  const frontmatterBlock = m[1] ?? "";
  const body = (m[2] ?? "").trim();
  const fm: SkillSource["frontmatter"] = {};
  for (const line of frontmatterBlock.split("\n")) {
    const km = line.match(/^([a-zA-Z_-]+)\s*:\s*(.+?)\s*$/);
    if (!km) continue;
    const key = km[1]!.toLowerCase();
    const value = unquote(km[2]!);
    if (key === "name") fm.name = value;
    else if (key === "description") fm.description = value;
    else if (key === "triggers") {
      fm.triggers = value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return { slug, raw, frontmatter: fm, body };
}

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Cursor rule (.mdc). Cursor reads:
 *   description : shown in the rule picker; we use the SKILL.md
 *                 description.
 *   globs       : optional file-pattern scope. We omit for skills
 *                 (general-purpose).
 *   alwaysApply : false — let Cursor pick when to inject based on
 *                 the description match. (`true` would force-inject
 *                 every turn, which is rarely what a skill wants.)
 */
export function toCursorRule(s: SkillSource): string {
  const description = (s.frontmatter.description || s.frontmatter.name || s.slug).replace(
    /"/g,
    '\\"',
  );
  const lines = ["---", `description: "${description}"`, "alwaysApply: false", "---", "", s.body];
  return lines.join("\n") + "\n";
}

/**
 * Continue rule (.md). Continue's rules system reads YAML
 * frontmatter `name` + `if`. We use `if` for the trigger description
 * (Continue's matcher is description-based, not regex).
 */
export function toContinueRule(s: SkillSource): string {
  const name = (s.frontmatter.name || s.slug).replace(/"/g, '\\"');
  const ifText = (s.frontmatter.description || `Use the ${s.slug} skill.`).replace(/"/g, '\\"');
  const lines = ["---", `name: "${name}"`, `if: "${ifText}"`, "---", "", s.body];
  return lines.join("\n") + "\n";
}

/**
 * Zed prompt (.md). Zed slash commands are plain markdown — the
 * filename (sans `.md`) becomes `/<slug>`. The first line is shown
 * in the picker, so we lead with a one-liner description.
 */
export function toZedPrompt(s: SkillSource): string {
  const header = s.frontmatter.description || s.frontmatter.name || s.slug;
  return `${header}\n\n${s.body}\n`;
}

/**
 * Dispatcher. Pick the transformer for a strategy; return the source
 * `raw` unchanged for verbatim formats.
 */
export function transformSkill(strategy: WiringStrategy, s: SkillSource): string {
  switch (strategy) {
    case "anthropic-skill-md":
      return s.raw; // verbatim
    case "cursor-rule-mdc":
      return toCursorRule(s);
    case "continue-rule-md":
      return toContinueRule(s);
    case "zed-prompt-md":
      return toZedPrompt(s);
    default:
      return s.raw;
  }
}
