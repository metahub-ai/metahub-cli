/**
 * Badge taxonomy. Each badge is a binary "earned / not earned" signal
 * computed at catalog-build time from evidence + counts. The catalog
 * is the source of truth — re-running the build re-evaluates badges,
 * which means we can tweak criteria without republishing artifacts.
 *
 * Badges are data, not code: the rule and "what's missing" copy live
 * here so the portal can show them as criteria text on the publish
 * page and the registry can display the same copy as a "how to earn
 * this" hint.
 */
import type { ArtifactKind } from "./artifact.js";

export type BadgeId =
  // Universal
  | "verified-publisher"
  | "curated"
  | "licensed"
  | "documented"
  | "actively-maintained"
  | "clean-repo"
  | "battle-tested"
  | "well-reviewed"
  | "behaviorally-verified"
  // Skill-specific
  | "trigger-explicit"
  | "has-examples"
  | "structured"
  // MCP-specific
  | "mcp-sdk"
  | "tool-catalog"
  | "runnable"
  // Agent-specific
  | "entry-declared"
  | "tools-enumerated"
  | "model-pinned"
  // Plugin-specific
  | "multi-skill"
  | "hooks-declared"
  | "mcp-bundled";

/** Category drives the icon + grouping in the UI. */
export type BadgeCategory = "trust" | "maintenance" | "documentation" | "structure" | "adoption";

export interface BadgeDefinition {
  id: BadgeId;
  /** Short label shown on chips and in the quality panel. */
  label: string;
  /** One-line description of the criterion the publisher must meet. */
  criterion: string;
  /** Category for icon + grouping. */
  category: BadgeCategory;
  /** Empty array = applies to every kind. */
  appliesTo: ArtifactKind[];
  /**
   * If you don't earn this badge, what does the publisher need to fix?
   * Used inline in the "Quality" panel and on the portal publish page.
   */
  remediation: string;
}

const ALL_KINDS: ArtifactKind[] = [];

export const BADGE_CATALOG: BadgeDefinition[] = [
  // ─── Universal ──────────────────────────────────────────────────────
  {
    id: "verified-publisher",
    label: "Verified publisher",
    criterion: "Published through the portal with a confirmed GitHub identity.",
    category: "trust",
    appliesTo: ALL_KINDS,
    remediation:
      "Re-publish from the developer portal so the catalog can record the publishing user.",
  },
  {
    id: "curated",
    label: "Curated by MetaHub",
    criterion:
      "Onboarded by MetaHub from public GitHub data. The original repo author can claim the listing to take over publishing.",
    category: "trust",
    appliesTo: ALL_KINDS,
    remediation:
      "Claim this repository via the MetaHub portal — sign in with the GitHub account that owns the repo and use the onboard flow.",
  },
  {
    id: "licensed",
    label: "Licensed",
    criterion: "A recognized LICENSE file exists at the repo root.",
    category: "trust",
    appliesTo: ALL_KINDS,
    remediation:
      "Add a LICENSE file at the repo root. GitHub recognizes most OSS licenses out of the box (e.g. MIT, Apache-2.0).",
  },
  {
    id: "documented",
    label: "Documented",
    criterion: "Repo has a README and the catalog listing has a tagline or long description.",
    category: "documentation",
    appliesTo: ALL_KINDS,
    remediation:
      "Add a README.md at repo root, and fill in the tagline or long description on the publish page.",
  },
  {
    id: "actively-maintained",
    label: "Actively maintained",
    criterion: "Most recent commit on the default branch is within 90 days.",
    category: "maintenance",
    appliesTo: ALL_KINDS,
    remediation:
      "Push a commit. Even a small README polish counts — the registry checks the last push timestamp.",
  },
  {
    id: "clean-repo",
    label: "Clean repo",
    criterion: "No files at well-known sensitive paths (e.g. .env, *.pem, *.key) are committed.",
    category: "trust",
    appliesTo: ALL_KINDS,
    remediation:
      "Remove any committed secret files. Use .gitignore + git-filter-repo to scrub history if needed.",
  },
  {
    id: "battle-tested",
    label: "Battle-tested",
    criterion: "10+ unique installs or 5+ reviews.",
    category: "adoption",
    appliesTo: ALL_KINDS,
    remediation: "Earned automatically once the catalog records enough unique installs or reviews.",
  },
  {
    id: "well-reviewed",
    label: "Well-reviewed",
    criterion: "3+ reviews with an average rating of 4.0 or higher.",
    category: "adoption",
    appliesTo: ALL_KINDS,
    remediation: "Earned automatically once 3 reviewers leave a rating averaging 4.0★ or higher.",
  },

  // ─── Skill ──────────────────────────────────────────────────────────
  {
    id: "trigger-explicit",
    label: "Trigger-explicit",
    criterion: "At least one explicit phrase declared under triggers: in SKILL.md frontmatter.",
    category: "structure",
    appliesTo: ["skill"],
    remediation:
      'Add triggers: "keyword1, keyword2" to your SKILL.md frontmatter so the model has explicit invocation phrases.',
  },
  {
    id: "has-examples",
    label: "Has examples",
    criterion: "2+ fenced code blocks in SKILL.md.",
    category: "documentation",
    appliesTo: ["skill"],
    remediation:
      "Add concrete usage examples to SKILL.md as fenced code blocks — they help the model match the right intent.",
  },
  {
    id: "structured",
    label: "Structured",
    criterion: "3+ ## sections in SKILL.md.",
    category: "structure",
    appliesTo: ["skill"],
    remediation: "Split SKILL.md into sections: When to use, When not to use, Examples, Caveats.",
  },

  // ─── MCP ────────────────────────────────────────────────────────────
  {
    id: "mcp-sdk",
    label: "MCP SDK linked",
    criterion: "@modelcontextprotocol/sdk listed in package.json dependencies.",
    category: "structure",
    appliesTo: ["mcp"],
    remediation:
      "Add @modelcontextprotocol/sdk to your dependencies so consumers know which protocol version you target.",
  },
  {
    id: "tool-catalog",
    label: "Tool catalog",
    criterion: "3+ tools registered in the server source.",
    category: "structure",
    appliesTo: ["mcp"],
    remediation:
      "Expose a handful of tools — a single-tool MCP is usually better written as a skill or agent.",
  },
  {
    id: "runnable",
    label: "Runnable",
    criterion: "package.json declares a bin entry or a start script.",
    category: "structure",
    appliesTo: ["mcp"],
    remediation:
      'Add either "bin": { "<name>": "./dist/index.js" } or "scripts": { "start": "node dist/index.js" } so consumers can launch the server.',
  },

  // ─── Agent ──────────────────────────────────────────────────────────
  {
    id: "entry-declared",
    label: "Entry declared",
    criterion: "agent.json declares an entry file with a default export.",
    category: "structure",
    appliesTo: ["agent"],
    remediation: 'Set "entry": "src/index.ts" in agent.json and export your agent as default.',
  },
  {
    id: "tools-enumerated",
    label: "Tools enumerated",
    criterion: "agent.json declares a non-empty tools array.",
    category: "documentation",
    appliesTo: ["agent"],
    remediation:
      'List the tools your agent uses in agent.json ("tools": ["Read", "Bash"]) so consumers understand its surface area.',
  },
  {
    id: "model-pinned",
    label: "Model pinned",
    criterion: "agent.json declares a model preference.",
    category: "structure",
    appliesTo: ["agent"],
    remediation:
      'Pin a model in agent.json ("model": "claude-sonnet-4-6") so behavior is reproducible across consumers.',
  },

  // ─── Plugin ─────────────────────────────────────────────────────────
  {
    id: "multi-skill",
    label: "Multi-skill",
    criterion: "Bundles 2+ skills.",
    category: "structure",
    appliesTo: ["plugin"],
    remediation:
      "Plugins shine when they bundle related capabilities. Add a second skill to skills/ or pivot to publishing the single skill directly.",
  },
  {
    id: "hooks-declared",
    label: "Hooks declared",
    criterion: "plugin.json declares hooks or a hooks/ directory is present.",
    category: "structure",
    appliesTo: ["plugin"],
    remediation:
      "Add hook scripts under hooks/ (e.g. PreToolUse, PostToolUse) for plugins that need lifecycle integration.",
  },
  {
    id: "mcp-bundled",
    label: "MCP bundled",
    criterion: "Plugin includes an MCP server (mcp/ directory or mcp.json).",
    category: "structure",
    appliesTo: ["plugin"],
    remediation:
      "Optional — many plugins ship just skills. Add an mcp/ directory if your plugin needs to expose programmatic tools.",
  },
];

/** Indexed lookup. */
export const BADGES_BY_ID: Record<BadgeId, BadgeDefinition> = Object.fromEntries(
  BADGE_CATALOG.map((b) => [b.id, b]),
) as Record<BadgeId, BadgeDefinition>;

/** All badges that apply to a given kind (universal + kind-specific). */
export function badgesForKind(kind: ArtifactKind): BadgeDefinition[] {
  return BADGE_CATALOG.filter((b) => b.appliesTo.length === 0 || b.appliesTo.includes(kind));
}

/**
 * Stable display priority — used to choose which badges to surface
 * first on cards (where space is tight). Higher = more important.
 */
const BADGE_PRIORITY: Record<BadgeId, number> = {
  "battle-tested": 100,
  "well-reviewed": 95,
  "behaviorally-verified": 92,
  "verified-publisher": 90,
  curated: 85,
  "actively-maintained": 80,
  licensed: 70,
  documented: 60,
  "tool-catalog": 55,
  "multi-skill": 55,
  "trigger-explicit": 50,
  "entry-declared": 50,
  "mcp-sdk": 45,
  "model-pinned": 45,
  "tools-enumerated": 40,
  structured: 35,
  "has-examples": 35,
  runnable: 30,
  "hooks-declared": 25,
  "mcp-bundled": 20,
  "clean-repo": 15,
};

export function sortBadgesByPriority(ids: BadgeId[]): BadgeId[] {
  return [...ids].sort((a, b) => (BADGE_PRIORITY[b] ?? 0) - (BADGE_PRIORITY[a] ?? 0));
}
