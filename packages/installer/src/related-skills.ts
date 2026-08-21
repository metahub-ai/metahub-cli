/**
 * Related-skill discovery for skill installs.
 *
 * A catalog skill can be one member of a Claude Code plugin bundle. In
 * that case, installing only the catalog skill's repoPath drops the
 * other skills that Claude Code would load from the same plugin. This
 * module discovers those related directories from marketplace and
 * plugin manifests without sweeping unrelated repository content.
 *
 * Supported layouts follow Claude Code's plugin conventions:
 *
 * - `.claude-plugin/marketplace.json` entries with relative `source`
 *   directories, including `metadata.pluginRoot`.
 * - `.claude-plugin/plugin.json` at the repository or plugin root.
 * - `skills` as either a string or an array. Each path can identify a
 *   skill directly or a directory whose immediate children are skills.
 * - The conventional `<plugin-root>/skills/<name>/SKILL.md` layout,
 *   which is additive to custom `skills` paths.
 *
 * Only plugin declarations associated with the requested skill are
 * considered, so installing a skill from a multi-plugin marketplace
 * does not cascade into unrelated plugins.
 */
import fs from "node:fs";
import path from "node:path";

export interface RelatedSkill {
  /** Install slug — the skill directory's basename. */
  slug: string;
  /** Absolute path of the skill directory inside the extracted repo. */
  sourceDir: string;
  /** Path relative to the repo root. */
  relPath: string;
}

interface PluginDeclaration {
  name?: string;
  sourceDir: string;
  skills: string[];
  /** A standalone plugin.json owns its whole plugin root. */
  standaloneManifest: boolean;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Normalize a relative manifest path to forward slashes. */
function normalizeRel(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** Manifest paths must remain inside the extracted repository. */
function safeRel(value: string): string | null {
  const normalized = normalizeRel(value);
  if (normalized === ".") return "";
  if (/^(?:\/|[A-Za-z]:\/)/.test(normalized)) return null;
  if (normalized.split("/").includes("..")) return null;
  return normalized;
}

function joinRel(...parts: string[]): string | null {
  const safeParts: string[] = [];
  for (const part of parts) {
    const safe = safeRel(part);
    if (safe === null) return null;
    if (safe) safeParts.push(safe);
  }
  return safeParts.join("/");
}

/** A directory that directly contains a SKILL.md. */
function isSkillDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory() && fs.statSync(path.join(dir, "SKILL.md")).isFile();
  } catch {
    return false;
  }
}

function readJson(file: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function toStringArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function pluginManifest(repoRoot: string, sourceDir: string): JsonObject | null {
  return readJson(path.join(repoRoot, sourceDir, ".claude-plugin", "plugin.json"));
}

/**
 * Read every local plugin declaration available in the extracted repo.
 * Object-valued marketplace sources point to external repositories and
 * cannot safely be resolved from this tarball, so they are ignored.
 */
function pluginDeclarations(repoRoot: string): PluginDeclaration[] {
  const declarations: PluginDeclaration[] = [];
  const marketplace = readJson(path.join(repoRoot, ".claude-plugin", "marketplace.json"));
  const rawPlugins = marketplace?.plugins;
  const metadata = isObject(marketplace?.metadata) ? marketplace.metadata : null;
  const pluginRoot = typeof metadata?.pluginRoot === "string" ? safeRel(metadata.pluginRoot) : "";

  if (Array.isArray(rawPlugins) && pluginRoot !== null) {
    for (const rawPlugin of rawPlugins) {
      if (!isObject(rawPlugin)) continue;
      if (rawPlugin.source !== undefined && typeof rawPlugin.source !== "string") continue;
      const source = joinRel(pluginRoot, rawPlugin.source ?? "./");
      if (source === null) continue;

      const nestedManifest = pluginManifest(repoRoot, source);
      const useNestedManifest = rawPlugin.strict !== false;
      declarations.push({
        name:
          typeof rawPlugin.name === "string"
            ? rawPlugin.name
            : typeof nestedManifest?.name === "string"
              ? nestedManifest.name
              : undefined,
        sourceDir: source,
        skills: [
          ...toStringArray(rawPlugin.skills),
          ...(useNestedManifest ? toStringArray(nestedManifest?.skills) : []),
        ],
        standaloneManifest: false,
      });
    }
  }

  // A repository can itself be a plugin without being represented by
  // a root-sourced marketplace entry. Even a manifest with no custom
  // `skills` field activates conventional `skills/` discovery.
  const rootManifest = pluginManifest(repoRoot, "");
  if (rootManifest && !declarations.some((d) => d.sourceDir === "")) {
    declarations.push({
      name: typeof rootManifest.name === "string" ? rootManifest.name : undefined,
      sourceDir: "",
      skills: toStringArray(rootManifest.skills),
      standaloneManifest: true,
    });
  }

  return declarations;
}

/** Immediate skill children under a manifest-provided container path. */
function skillChildren(repoRoot: string, containerRel: string): string[] {
  const container = path.join(repoRoot, containerRel);
  try {
    return fs
      .readdirSync(container, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isSkillDir(path.join(container, entry.name)))
      .map((entry) => joinRel(containerRel, entry.name))
      .filter((entry): entry is string => entry !== null)
      .sort();
  } catch {
    return [];
  }
}

/** Resolve one custom skills path relative to its plugin source. */
function resolveSkillsPath(repoRoot: string, sourceDir: string, declaredPath: string): string[] {
  const rel = safeRel(declaredPath);
  if (rel === null || !rel) return [];

  // Component paths are plugin-root-relative. Some existing repos use
  // marketplace-root-relative paths, so fall back to that form only if
  // the source-relative form does not resolve to any skill.
  const candidates = [joinRel(sourceDir, rel), rel].filter(
    (candidate, index, all): candidate is string =>
      candidate !== null && all.indexOf(candidate) === index,
  );
  for (const candidate of candidates) {
    if (isSkillDir(path.join(repoRoot, candidate))) return [candidate];
    const children = skillChildren(repoRoot, candidate);
    if (children.length > 0) return children;
  }
  return [];
}

function declaredSkills(repoRoot: string, declaration: PluginDeclaration): string[] {
  const found = new Set<string>();
  for (const customPath of declaration.skills) {
    for (const skill of resolveSkillsPath(repoRoot, declaration.sourceDir, customPath)) {
      found.add(skill);
    }
  }

  const conventional = joinRel(declaration.sourceDir, "skills");
  if (conventional !== null) {
    for (const skill of skillChildren(repoRoot, conventional)) found.add(skill);
  }
  return [...found];
}

function declarationMatchScore(
  repoRoot: string,
  declaration: PluginDeclaration,
  declared: string[],
  installed: string,
  rootDeclarationCount: number,
): number | null {
  // An explicit component path is the strongest association. Prefer a
  // more deeply nested plugin source when more than one declaration
  // explicitly names the same skill.
  if (declared.includes(installed)) return 100_000 + declaration.sourceDir.length;
  if (
    installed === declaration.sourceDir &&
    isSkillDir(path.join(repoRoot, declaration.sourceDir))
  ) {
    return 90_000 + declaration.sourceDir.length;
  }

  if (declaration.sourceDir) {
    return installed.startsWith(`${declaration.sourceDir}/`)
      ? declaration.sourceDir.length + 1
      : null;
  }

  // A standalone root plugin owns the repository. For marketplace
  // entries sourced from the repository root, prefer an exact plugin
  // name match and only use the whole-repo fallback when that entry is
  // unambiguous. This prevents one root-sourced marketplace plugin from
  // pulling in another root-sourced plugin's skills.
  if (declaration.name === path.posix.basename(installed)) return 80_000;
  if (declaration.standaloneManifest) return 1;
  return rootDeclarationCount === 1 ? 0 : null;
}

/**
 * Find the sibling skills declared alongside `installedRelPath` (the
 * installed skill's repoPath, "" when the skill is the repo root).
 * Returns only directories that exist and contain a SKILL.md,
 * excluding the installed skill itself.
 */
export function findRelatedSkills(repoRoot: string, installedRelPath: string): RelatedSkill[] {
  const installed = safeRel(installedRelPath);
  if (installed === null) return [];

  const declarations = pluginDeclarations(repoRoot);
  const rootDeclarationCount = declarations.filter((d) => d.sourceDir === "").length;
  const related = new Map<string, RelatedSkill>();
  const matches = declarations
    .map((declaration) => {
      const declared = declaredSkills(repoRoot, declaration);
      return {
        declared,
        score: declarationMatchScore(
          repoRoot,
          declaration,
          declared,
          installed,
          rootDeclarationCount,
        ),
      };
    })
    .filter((match): match is typeof match & { score: number } => match.score !== null);
  const bestScore = Math.max(...matches.map((match) => match.score));

  for (const { declared, score } of matches) {
    if (score !== bestScore) continue;

    for (const relPath of declared) {
      if (relPath === installed) continue;
      const slug = path.posix.basename(relPath);
      // Related installs use the skill directory basename as their
      // canonical install slug. Deduplicate by that destination slug so
      // two declarations cannot overwrite the same target in one run.
      if (!slug || related.has(slug)) continue;
      related.set(slug, {
        slug,
        sourceDir: path.join(repoRoot, relPath),
        relPath,
      });
    }
  }

  return [...related.values()];
}
