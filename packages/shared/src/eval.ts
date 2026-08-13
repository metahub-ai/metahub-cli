/**
 * Eval-job types. Synchronous in iteration 1 (the portal blocks on the
 * check, returns a report). Iteration 2 swaps the same wire format to
 * async with an email notification.
 */
import type { ArtifactKind } from "./artifact.js";

export type EvalCheckStatus = "pass" | "fail" | "warn";

/**
 * Coarse-grained grouping that lets the UI render checks in labelled
 * sections instead of one undifferentiated list. Each category has a
 * fixed display order in the portal's CategorizedChecks component:
 *
 *   1. structural    — "is this thing identifiable + addressable?"
 *                       repo reachable, manifest exists, slug is well-formed
 *                       and unique, version parses
 *   2. documentation — "can a human / agent figure out what this does?"
 *                       README presence + length, manifest description length
 *   3. safety        — "is publishing this likely to leak / harm?"
 *                       license declared, no sensitive files in repo
 *   4. kind-specific — "does the artifact's kind-shape actually hold up?"
 *                       skill body, MCP launch + tools, agent entry,
 *                       plugin bundle integrity
 *
 * "behavioral" is reserved for a near-future class of checks (sandbox
 * boot, LLM-judge prompt suite, tool-use compliance) and is rendered
 * by the portal today as a "Coming soon" preview block.
 */
export type EvalCheckCategory =
  "structural" | "documentation" | "safety" | "kind-specific" | "maintenance" | "behavioral";

/**
 * Resolve the category for a given check id. Centralised so the runner
 * (apps/portal/lib/eval-job.ts) and the UI both agree on the bucket
 * without each side re-encoding the mapping.
 *
 * Unknown ids → "kind-specific" so a new check defaults to the most
 * common bucket; the runner can override with an explicit
 * `category:` on emit.
 */
export function categoryForCheckId(id: string): EvalCheckCategory {
  switch (id) {
    case "repo-reachable":
    case "manifest-found":
    case "slug-format":
    case "slug-unique":
    case "version-format":
      return "structural";
    case "description-length":
    case "readme-present":
    case "tags-declared":
    case "examples-present":
    case "homepage-declared":
      return "documentation";
    case "license-present":
    case "no-sensitive-files":
    case "dep-known-vulns":
      return "safety";
    case "last-commit-recency":
    case "has-tests":
    case "has-ci":
    case "version-matches-release":
      return "maintenance";
    default:
      // skill-md-present, skill-body, skill-triggers, skill-allowed-tools,
      // trigger-quality, mcp-*, agent-*, plugin-* all fall through to
      // the kind-specific bucket.
      return "kind-specific";
  }
}

/** Human-readable section title, matched to the EvalCheckCategory union. */
export const EVAL_CATEGORY_LABEL: Record<EvalCheckCategory, string> = {
  structural: "Structural",
  documentation: "Documentation",
  safety: "Safety",
  "kind-specific": "Kind-specific",
  maintenance: "Maintenance",
  behavioral: "Behavioral",
};

/** Section ordering the UI honours top-to-bottom. */
export const EVAL_CATEGORY_ORDER: ReadonlyArray<EvalCheckCategory> = [
  "structural",
  "documentation",
  "safety",
  "kind-specific",
  "maintenance",
  "behavioral",
];

export interface EvalCheck {
  id: string;
  label: string;
  status: EvalCheckStatus;
  message?: string;
  /** Optional remediation hint, displayed inline under a failing check. */
  hint?: string;
  /**
   * Section the UI should place this check under. Optional for
   * backwards-compat with legacy reports persisted before the taxonomy
   * landed — newer code can derive a default via categoryForCheckId().
   */
  category?: EvalCheckCategory;
  /**
   * True for checks that are *declared* by the runner but not yet
   * *executed* — currently used by the behavioral category to surface
   * each planned behavioral check (sandbox boot, LLM judge, tool-use
   * compliance, safety deep-scan, perf baseline) in the same UI as
   * the live checks. The roll-up logic ignores pending entries so a
   * report with 5 pending behavioral checks + 12 passing live checks
   * still reads as 12/12 passed; once the behavioral engine ships,
   * the runner flips pending → false and writes the real status.
   *
   * Status is left as "pass" by convention so legacy consumers that
   * don't read `pending` treat them as benign (instead of as
   * spurious warnings or failures).
   */
  pending?: boolean;
}

export interface InferredManifest {
  name: string;
  slug: string;
  kind: ArtifactKind;
  description: string;
  version: string;
  tags?: string[];
  homepage?: string | null;
}

/**
 * Per-kind evidence we extracted from the repo. The shape of `data`
 * varies by kind so the UI can surface a tailored panel.
 */
export interface DetectedSkill {
  /** Frontmatter fields recognized in SKILL.md. */
  triggers: string[];
  hasSkillMd: boolean;
  /** Length in characters of SKILL.md body (post-frontmatter). */
  bodyLen?: number;
  /**
   * Word count of SKILL.md body (post-frontmatter), counted with the
   * CJK-aware tokenizer used by the description-quality check. Optional
   * for backwards compatibility with persisted reports written before
   * this field existed.
   */
  bodyWords?: number;
  /** `allowed-tools` frontmatter (Claude Code convention). */
  allowedTools?: string[];
  /** Count of `##`-level sections in the body. */
  sectionsCount?: number;
  /** Count of fenced code blocks in the body. */
  codeBlocksCount?: number;
  /** Manifest source — explicit metahub.json vs. SKILL.md frontmatter. */
  manifestSource?: "metahub.json" | "SKILL.md";
  /**
   * First substantive paragraph of the SKILL.md body (after frontmatter
   * and the H1). The "what does this do and when do I use it" pitch.
   * Trimmed to ~600 chars so we never blow up the detail page.
   */
  introParagraph?: string;
  /**
   * H2-level section titles in the order they appear in SKILL.md.
   * Surfaced on the detail page as a "What's covered" outline so
   * consumers can scan what the skill walks through.
   */
  sectionTitles?: string[];
}

/** A single MCP surface (tool / resource / prompt) we discovered. */
export interface DetectedMcpEntry {
  name: string;
  /** Description string we found alongside the registration call. */
  description?: string;
}

export interface DetectedMcp {
  /** package.json bin name(s) — what `npx ...` would invoke. */
  binNames: string[];
  /** True if package.json declared "mcp" or had an mcp-shaped entry. */
  hasMcpDeclaration: boolean;
  /** Names extracted from any inline tool registration we could find. */
  toolNamesPreview: string[];
  /** `@modelcontextprotocol/sdk` listed in dependencies. */
  hasMcpSdk?: boolean;
  /**
   * Version spec the project pinned `@modelcontextprotocol/sdk` at,
   * verbatim from package.json (e.g. "^1.2.0", "*", "latest"). Used
   * by the mcp-version-pin check to flag unbounded ranges. Optional —
   * persisted reports older than this field have it absent.
   */
  mcpSdkVersionSpec?: string | null;
  /**
   * Top-level direct deps (package.json `dependencies`) captured at
   * detection time. The dep-known-vulns check uses these to query
   * OSV.dev for high/critical advisories. Empty + optional for
   * backwards compatibility.
   */
  directDeps?: Record<string, string>;
  /** package.json declares `"type": "module"`. */
  isEsmModule?: boolean;
  /** A `start` script is present (alternate launch path if no bin). */
  hasStartScript?: boolean;
  /** Names from inline resource registration (e.g. `.resource("…")`). */
  resourceNames?: string[];
  /** Names from inline prompt registration. */
  promptNames?: string[];
  /**
   * Tools with their human-readable descriptions (parsed from the
   * second-string-literal argument of `.tool("name", "description", …)`
   * calls). Length parallel to `toolNamesPreview` but entries are
   * objects so the UI can show name + description on the same line.
   */
  tools?: DetectedMcpEntry[];
  /** Resources with their descriptions, same shape as `tools`. */
  resources?: DetectedMcpEntry[];
  /** Prompts with their descriptions, same shape as `tools`. */
  prompts?: DetectedMcpEntry[];
}

export interface DetectedAgent {
  /** Entry-point file relative to the artifact root. */
  entryFile: string | null;
  /** Whether a default exported function/object is present. */
  hasDefaultExport: boolean;
  /**
   * Truncated SyntaxError message from a CJS-syntax pre-flight parse
   * of the entry file (`node:vm` Script constructor), when the file
   * looked like CommonJS. `null` for clean parses, never-attempted
   * (ESM files), or missing entry. Surfaced as
   * `entrypoint-imports-clean`.
   */
  entrySyntaxError?: string | null;
  /**
   * Status of the artifact root's `package.json`. Used by
   * `package-json-valid` to warn when an agent ships one that doesn't
   * parse or is missing required fields. Optional for backwards
   * compatibility — older reports don't have it.
   */
  packageJsonStatus?: "ok" | "missing" | "malformed" | "no-name-or-version";
  /** Tools declared in agent.json `tools` array. */
  toolsDeclared?: string[];
  /**
   * When agent.json's `tools` is an array of `{ name, description }`
   * objects (the richer schema), we surface descriptions too. Falls
   * back to `[]` when `tools` was a plain string[].
   */
  toolDescriptions?: DetectedMcpEntry[];
  /** Model preference from agent.json (`model` field). */
  model?: string | null;
  /** First line of declared instructions, if any (truncated). */
  instructionsPreview?: string | null;
  /**
   * True for a PROMPT-BASED agent — a Claude-Code-style sub-agent
   * defined by a markdown file with frontmatter
   * (`.claude/agents/<name>.md`), where the body IS the agent. These
   * have no executable entry point, so `entryFile` is null by
   * definition and the entry/package.json checks and the exec-based
   * behavioral harness don't apply; they run through an LLM loop
   * instead, like a skill.
   *
   * Absent/false = the code-based shape declared by `agent.json`.
   */
  promptBased?: boolean;
}

/** A single sub-item bundled inside a plugin. */
export interface DetectedPluginItem {
  /** Sub-slug under the relevant convention dir (skills/, commands/, …). */
  name: string;
  /** One-line description we could find — manifest field or first line. */
  description?: string;
}

export interface DetectedPlugin {
  /** Sub-skills bundled in the plugin (count + first-few names). */
  bundledSkillsCount: number;
  bundledSkillNames: string[];
  /** Whether a bundled MCP server config was found. */
  hasMcpServer: boolean;
  /** plugin.json fields that were resolved. */
  manifestFields?: {
    hasName: boolean;
    hasVersion: boolean;
    hasDescription: boolean;
  };
  /** Hook script names declared in plugin.json or hooks/ dir. */
  hooks?: string[];
  /** Slash command names declared by the plugin. */
  commands?: string[];
  /** Subagents bundled with the plugin. */
  subagents?: string[];
  /**
   * Sub-skills with descriptions read from each bundle's SKILL.md
   * frontmatter — populated for plugins whose `skills/` directory
   * contains real Claude Code skills. Length tracks `bundledSkillsCount`.
   */
  bundledSkillSummaries?: DetectedPluginItem[];
  /**
   * Commands with descriptions read from each `commands/*.md` first
   * non-empty line.
   */
  commandSummaries?: DetectedPluginItem[];
  /**
   * Subagents with descriptions read from each `subagents/*.md`
   * frontmatter `description:` field.
   */
  subagentSummaries?: DetectedPluginItem[];
}

/**
 * Universal repo-level safety + housekeeping signals. Populated once
 * per scan from the tree index — no extra API calls.
 */
export interface RepoSafety {
  /** Path of a LICENSE-shaped file at repo root (e.g. "LICENSE", "LICENSE.txt"). */
  licenseFile: string | null;
  /**
   * Paths matching well-known secret patterns. Empty array means
   * nothing concerning was committed.
   */
  sensitivePaths: string[];
  /** README.md (case-insensitive) found at repo root. */
  hasReadme?: boolean;
}

export type KindEvidence =
  | { kind: "skill"; data: DetectedSkill }
  | { kind: "mcp"; data: DetectedMcp }
  | { kind: "agent"; data: DetectedAgent }
  | { kind: "plugin"; data: DetectedPlugin };

export interface DetectedArtifact {
  /** Stable id within a job — `det_skill_<idx>`. */
  detectionId: string;
  /** Path relative to repo root. Empty string = repo root. */
  path: string;
  manifest: InferredManifest;
  /** Filenames at `path` we used to identify the kind. */
  evidenceFiles: string[];
  /** Kind-specific surface area, narrowed by `kind`. */
  evidence: KindEvidence;
}

export interface RepoMeta {
  fullName: string;
  htmlUrl: string;
  description: string | null;
  homepage: string | null;
  defaultBranch: string;
  license: string | null;
  /** Star count from GitHub. */
  stars: number;
  /** Primary language identified by GitHub. */
  language: string | null;
  /** Topic tags ("topics") set on the GitHub repo. */
  topics: string[];
  /** Unix ms of the last commit on the captured branch. */
  pushedMs: number | null;
  /**
   * GitHub `archived` flag. Optional for backwards compatibility with
   * persisted reports written before this field existed. When true the
   * maintenance category short-circuits to a neutral "Archived" status
   * instead of warning on commit recency.
   */
  archived?: boolean;
  /** Fork count from GitHub — optional, useful as a quality signal. */
  forks?: number | null;
}

export interface EvalReport {
  jobId: string;
  artifactId: string | null;
  repoUrl: string;
  repoBranch: string;
  capturedSha: string | null;
  /**
   * Repo metadata pulled at scan time. Null if the repo couldn't be
   * reached.
   */
  repoMeta: RepoMeta | null;
  /** Universal safety signals derived from the repo tree. */
  repoSafety?: RepoSafety;
  /**
   * All artifacts the scanner detected in the repo. May contain more
   * than one entry for monorepos (e.g. modelcontextprotocol/servers).
   * Empty when no manifest was found anywhere.
   */
  detected: DetectedArtifact[];
  /**
   * Back-compat: the manifest the caller selected. For single-artifact
   * repos this matches `detected[0].manifest`. Null when nothing was
   * detected.
   */
  manifest: InferredManifest | null;
  /**
   * Back-compat: checks scoped to the selected manifest. Mirrors
   * `checksByDetection[selectedDetectionId]` (defaults to detected[0]).
   */
  checks: EvalCheck[];
  overall: EvalCheckStatus;
  /**
   * Checks computed for every detection, keyed by detectionId. In a
   * monorepo each detected artifact has its own slug-uniqueness +
   * kind-specific results, so the UI and the create gate must validate
   * the *selected* detection — not detected[0]. Absent only on the
   * legacy/partial-scan paths, where callers fall back to `checks`.
   */
  checksByDetection?: Record<string, EvalCheck[]>;
  /**
   * Set when the scan aborted because the GitHub API quota was exhausted:
   * the epoch-ms timestamp when the quota resets (or a conservative
   * estimate when GitHub omitted the reset header). A rate-limited scan
   * says nothing about the repo itself, so batch consumers (the eval
   * worker's import/reeval paths) requeue the work to run after this
   * time instead of recording a terminal eval failure.
   */
  rateLimitedUntilMs?: number | null;
  startedAt: string;
  finishedAt: string | null;
}
