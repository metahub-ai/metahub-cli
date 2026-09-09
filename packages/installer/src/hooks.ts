/**
 * Wire artifacts into the AI client(s) on the user's machine.
 *
 *   skill   — the canonical install lives at ~/.claude/skills/<slug>/
 *             (Claude Code reads nowhere else). It is then linked into
 *             ~/.agents/skills/<slug>/ — the Agent Skills directory that
 *             Codex CLI, Gemini CLI, Cursor, opencode and Goose all
 *             read — and into Antigravity's global skills directory when
 *             Antigravity is present. Clients that cannot read a
 *             SKILL.md folder (Continue, Zed) get a transformed file.
 *   plugin  — folder at ~/.claude/plugins/<slug>/. Currently
 *             Claude-Code-only.
 *   mcp     — iterate the multi-client adapter registry and wire the
 *             server into every detected client. JSON-based clients
 *             get auto-merged; YAML/TOML/UI-only clients return a
 *             copy-paste snippet for manual setup.
 *   agent   — no client wiring; the developer imports it directly.
 *
 * Every successful per-client write is recorded in the wiring ledger
 * (`~/.metahub/wirings.json`) so uninstall can cleanly walk + undo
 * each one, and `mh refresh` can detect gaps after new IDEs land.
 *
 * All kinds get a .metahub.json sidecar in their install dir so the
 * SDK can read its ingest credentials at runtime.
 */
import fs from "node:fs";
import path from "node:path";
import { installPathFor } from "./paths.js";
import {
  type ClientWriteResult,
  type LaunchSpec,
  unwireMcpAcrossClients,
  wireMcpAcrossClients,
} from "./clients.js";
import {
  type ClientId,
  type WiringStrategy,
  capabilityFor,
  clientIdFromLabel,
  clientLabel,
  clientsForKind,
} from "./capabilities.js";
import { detectClient } from "./detection.js";
import { type WiringEntry, dropWiring, findWiring, recordWiring } from "./wirings.js";
import { parseSkillSource, transformSkill } from "./skill-transformers.js";
import { readMcpPackageJson, resolveMcpEntry } from "./mcp-build.js";
import type { ArtifactKind } from "@metahub/shared";

/**
 * Resolve how to launch an MCP server from its install dir. Tries (in
 * order): bin → main → scripts.start → common entry filenames. A `node`
 * launch is only returned when the file is actually on disk — writing
 * `node dist/index.js` for a source tree that was never built gives
 * every client a server that fails to start with no explanation.
 */
function resolveMcpLaunch(installDir: string): { launch: LaunchSpec | null; reason?: string } {
  const pkg = readMcpPackageJson(installDir);
  const entry = resolveMcpEntry(installDir, pkg);
  if (entry) {
    if (!fs.existsSync(entry)) {
      return {
        launch: null,
        reason: `its entry point ${path.relative(installDir, entry)} is missing (the package was not built)`,
      };
    }
    return { launch: { command: "node", args: [entry] } };
  }
  if (pkg?.scripts?.start) {
    return { launch: { command: "npm", args: ["start", "--prefix", installDir] } };
  }
  for (const candidate of [
    "dist/index.js",
    "dist/server.js",
    "build/index.js",
    "index.js",
    "server.js",
    "server.mjs",
  ]) {
    if (fs.existsSync(path.join(installDir, candidate))) {
      return { launch: { command: "node", args: [path.join(installDir, candidate)] } };
    }
  }
  return {
    launch: null,
    reason: "no bin, main, start script or conventional entry file was found",
  };
}

interface WireInput {
  kind: ArtifactKind;
  slug: string;
  ingestApiKey: string;
  installId: string;
  artifactId: string;
  portalUrl: string;
  /**
   * MCP only: launch the server this way instead of resolving it from
   * the install dir (used when the pinned tree could not be built and
   * the published npm package stands in for it).
   */
  launch?: LaunchSpec;
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function writeSidecar(input: WireInput): void {
  const dir = installPathFor(input.kind, input.slug);
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, ".metahub.json"), {
    artifactId: input.artifactId,
    installId: input.installId,
    ingestApiKey: input.ingestApiKey,
    portalUrl: input.portalUrl,
    kind: input.kind,
    slug: input.slug,
  });
}

/**
 *   wrote               — a link, copy or transformed file was written.
 *   native              — nothing to write: the client reads a directory
 *                         the install already populates.
 *   skipped-not-detected — the client is not on this machine.
 *   skipped-no-source   — the canonical SKILL.md is missing.
 *   skipped-exists      — a foreign directory already owns the target
 *                         path; left alone rather than replaced.
 *   error               — the write threw; see `error`.
 */
export type SkillMirrorStatus =
  "wrote" | "native" | "skipped-not-detected" | "skipped-no-source" | "skipped-exists" | "error";

export interface SkillMirrorResult {
  client: ClientId;
  /** Friendly client name for the install-output line. */
  clientLabel: string;
  /** Path we wrote / skipped, or the directory a native client reads. */
  path: string;
  status: SkillMirrorStatus;
  /** Error message when status === "error". */
  error?: string;
}

export interface WireResult {
  /** Per-client outcome for MCP installs. Empty for non-MCP kinds. */
  clients: ClientWriteResult[];
  /**
   * Per-client outcomes for skill mirror writes. The MCP wiring
   * results stay in `clients` above for backwards-compat with the
   * MCP-only summary the CLI used to print.
   */
  skillMirrors: SkillMirrorResult[];
  /** Hard error to surface to the user, if any. */
  warning?: string;
}

/**
 * A copied skill directory (Windows, where symlinks need privileges)
 * carries the canonical install's `.metahub.json` sidecar. Its presence
 * is how we tell a directory we created from one the user already had
 * under the same name — the latter is never replaced.
 */
function ownsSkillCopy(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".metahub.json"));
}

/**
 * Link (or, on Windows, copy) the canonical skill folder to `target`.
 * A stale link or an earlier copy of ours is replaced; anything else
 * already at the path is left alone.
 */
function linkSkillDir(canonicalDir: string, target: string): "wrote" | "skipped-exists" {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let st: fs.Stats | null;
  try {
    st = fs.lstatSync(target);
  } catch {
    st = null;
  }
  if (st) {
    if (st.isSymbolicLink()) {
      fs.unlinkSync(target);
    } else if (st.isDirectory()) {
      if (!ownsSkillCopy(target)) return "skipped-exists";
      fs.rmSync(target, { recursive: true, force: true });
    } else {
      return "skipped-exists";
    }
  }
  if (process.platform === "win32") {
    fs.cpSync(canonicalDir, target, { recursive: true });
  } else {
    fs.symlinkSync(canonicalDir, target, "dir");
  }
  return "wrote";
}

/** Undo `linkSkillDir`. Only removes a link, or a directory we copied. */
function removeSkillLink(target: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(target);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) {
    fs.unlinkSync(target);
  } else if (st.isDirectory() && ownsSkillCopy(target)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

/**
 * Mirror a skill into every other place a detected harness reads.
 * Returns per-client results + the ledger entries to record.
 *
 * We re-read SKILL.md from the canonical install dir rather than
 * passing the source through — that way `mh refresh` can run the
 * same logic post-hoc with no in-memory state.
 */
function mirrorSkillToOtherClients(slug: string): {
  results: SkillMirrorResult[];
  wirings: WiringEntry[];
} {
  const canonicalDir = installPathFor("skill", slug);
  const sourcePath = path.join(canonicalDir, "SKILL.md");
  let raw: string;
  try {
    raw = fs.readFileSync(sourcePath, "utf8");
  } catch {
    return {
      results: clientsForKind("skill")
        .filter((row) => row.client !== "claude-code")
        .map((row) => ({
          client: row.client,
          clientLabel: clientLabel(row.client),
          path: row.targetPath(slug) ?? "(unknown)",
          status: "skipped-no-source" as const,
        })),
      wirings: [],
    };
  }
  const source = parseSkillSource(slug, raw);

  const results: SkillMirrorResult[] = [];
  const wirings: WiringEntry[] = [];
  const now = Date.now();

  for (const row of clientsForKind("skill")) {
    // Claude Code's SKILL.md is already sitting at the canonical
    // install path from tarball extraction — we record it but don't
    // re-write.
    if (row.client === "claude-code") {
      wirings.push({
        client: row.client,
        path: canonicalDir,
        strategy: row.strategy,
        writtenMs: now,
        status: "wrote",
      });
      continue;
    }

    const target = row.targetPath(slug);
    if (!target) continue;
    const label = clientLabel(row.client);

    if (row.strategy === "skill-dir-link") {
      // The Agent Skills directory is always linked: the harnesses that
      // read it do so whether or not they are installed yet. Any other
      // link target only when its client is present.
      if (row.client !== "agents-dir" && !detectClient(row.client)) {
        results.push({
          client: row.client,
          clientLabel: label,
          path: target,
          status: "skipped-not-detected",
        });
        continue;
      }
      try {
        const status = linkSkillDir(canonicalDir, target);
        results.push({ client: row.client, clientLabel: label, path: target, status });
        if (status === "wrote") {
          wirings.push({
            client: row.client,
            path: target,
            strategy: row.strategy,
            writtenMs: now,
            status: "wrote",
          });
        }
      } catch (err) {
        results.push({
          client: row.client,
          clientLabel: label,
          path: target,
          status: "error",
          error: (err as Error).message,
        });
      }
      continue;
    }

    if (row.strategy === "skill-native") {
      results.push({
        client: row.client,
        clientLabel: label,
        path: target,
        status: detectClient(row.client) ? "native" : "skipped-not-detected",
      });
      continue;
    }

    // Transformed single-file rules: only when the client is actually
    // detected. Writing to ~/.continue/rules/ for a user who doesn't
    // have Continue would be a surprise file.
    if (!detectClient(row.client)) {
      results.push({
        client: row.client,
        clientLabel: label,
        path: target,
        status: "skipped-not-detected",
      });
      continue;
    }
    try {
      const content = transformSkill(row.strategy as WiringStrategy, source);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, "utf8");
      results.push({ client: row.client, clientLabel: label, path: target, status: "wrote" });
      wirings.push({
        client: row.client,
        path: target,
        strategy: row.strategy,
        writtenMs: now,
        status: "wrote",
      });
    } catch (err) {
      results.push({
        client: row.client,
        clientLabel: label,
        path: target,
        status: "error",
        error: (err as Error).message,
      });
    }
  }

  return { results, wirings };
}

export function wireHook(input: WireInput): WireResult {
  writeSidecar(input);

  if (input.kind === "skill") {
    const { results, wirings } = mirrorSkillToOtherClients(input.slug);
    recordWiring({
      artifactId: input.artifactId,
      kind: input.kind,
      slug: input.slug,
      installedMs: Date.now(),
      wirings,
    });
    return { clients: [], skillMirrors: results };
  }

  if (input.kind === "plugin" || input.kind === "agent") {
    // Plugins are Claude-Code-only today; agents are imported as
    // Node modules. Record the canonical install in the ledger so
    // `mh refresh` knows we already wired what we can.
    const cap = capabilityFor("claude-code", input.kind);
    if (cap) {
      const target = cap.targetPath(input.slug);
      if (target) {
        recordWiring({
          artifactId: input.artifactId,
          kind: input.kind,
          slug: input.slug,
          installedMs: Date.now(),
          wirings: [
            {
              client: "claude-code",
              path: target,
              strategy: cap.strategy,
              writtenMs: Date.now(),
              status: "wrote",
            },
          ],
        });
      }
    }
    return { clients: [], skillMirrors: [] };
  }

  // MCP: wire across every detected client (the existing path).
  const installDir = installPathFor("mcp", input.slug);
  const resolved = input.launch ? { launch: input.launch } : resolveMcpLaunch(installDir);
  if (!resolved.launch) {
    // Record an empty wiring set so uninstall still finds the ledger entry.
    recordWiring({
      artifactId: input.artifactId,
      kind: input.kind,
      slug: input.slug,
      installedMs: Date.now(),
      wirings: [],
    });
    return {
      clients: [],
      skillMirrors: [],
      warning:
        `Couldn't infer how to launch ${input.slug}'s MCP server: ${resolved.reason}. ` +
        `Open ${installDir}/package.json and check for bin / main / scripts.start, ` +
        `then add the entry to your client's MCP config manually.`,
    };
  }
  const env = {
    METAHUB_INGEST_API_KEY: input.ingestApiKey,
    METAHUB_INSTALL_ID: input.installId,
    METAHUB_ARTIFACT_ID: input.artifactId,
    METAHUB_PORTAL_URL: input.portalUrl,
  };
  const mcpResults = wireMcpAcrossClients(input.slug, resolved.launch, env);

  // Record MCP wirings.
  const wirings: WiringEntry[] = mcpResults
    .filter((r) => r.status === "wrote")
    .map((r) => ({
      client: clientIdFromLabel(r.client),
      path: r.configPath,
      strategy: "mcp-json" as const,
      key: input.slug,
      writtenMs: Date.now(),
      status: "wrote" as const,
    }));
  recordWiring({
    artifactId: input.artifactId,
    kind: input.kind,
    slug: input.slug,
    installedMs: Date.now(),
    wirings,
  });

  return { clients: mcpResults, skillMirrors: [] };
}

export interface SkillRefreshResult {
  /** Per-client outcome of this pass. */
  results: SkillMirrorResult[];
  /** Ledger entries that did not exist before this pass. */
  added: WiringEntry[];
}

/**
 * Re-run the skill mirror for an installed skill and persist the
 * result. Used by `mh refresh` after a new harness lands on the
 * machine. The ledger is rewritten from what is on disk now, keeping
 * any older entries this pass did not touch (a 0.1.0 Cursor `.mdc`,
 * say) so uninstall can still remove them.
 */
export function refreshSkillWiring(
  slug: string,
  opts: { artifactId?: string } = {},
): SkillRefreshResult {
  const existing = findWiring("skill", slug);
  const { results, wirings } = mirrorSkillToOtherClients(slug);
  const keyOf = (w: WiringEntry) => `${w.client}|${w.path}`;
  const known = new Set((existing?.wirings ?? []).map(keyOf));
  const added = wirings.filter((w) => !known.has(keyOf(w)));
  const touched = new Set(wirings.map(keyOf));
  const kept = (existing?.wirings ?? []).filter((w) => !touched.has(keyOf(w)));
  recordWiring({
    artifactId: existing?.artifactId ?? opts.artifactId ?? "",
    kind: "skill",
    slug,
    installedMs: existing?.installedMs ?? Date.now(),
    wirings: [...wirings, ...kept],
  });
  return { results, added };
}

/**
 * Walk the wiring ledger and undo every per-client write. Falls back
 * to the legacy MCP-only unwire when no ledger entry exists (e.g.
 * artifacts installed before this PR landed).
 */
export function unwireHook(kind: ArtifactKind, slug: string): void {
  const set = dropWiring(kind, slug);
  if (!set || set.wirings.length === 0) {
    if (kind === "mcp") unwireMcpAcrossClients(slug);
    return;
  }
  for (const w of set.wirings) {
    try {
      if (w.strategy === "mcp-json") {
        unwireMcpAcrossClients(slug); // Splice from every JSON-config client.
        continue;
      }
      if (w.strategy === "anthropic-skill-md" || w.strategy === "claude-plugin") {
        // Folders — handled by the install dir removal in
        // uninstallArtifact(). Nothing else to do.
        continue;
      }
      if (w.strategy === "skill-dir-link") {
        removeSkillLink(w.path);
        continue;
      }
      if (w.strategy === "skill-native") continue;
      // Continue / Zed (and a 0.1.0 Cursor .mdc): single file per skill.
      if (fs.existsSync(w.path) && fs.statSync(w.path).isFile()) {
        fs.unlinkSync(w.path);
      }
    } catch {
      /* never let one client's failure block the others */
    }
  }
  // Backwards-compat MCP sweep.
  if (kind === "mcp") unwireMcpAcrossClients(slug);
}
