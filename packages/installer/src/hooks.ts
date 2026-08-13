/**
 * Wire artifacts into the AI client(s) on the user's machine.
 *
 *   skill   — drop the canonical install at ~/.claude/skills/<slug>/
 *             (Claude Code's location). Then mirror it as the right
 *             format into every OTHER detected client that consumes
 *             skills (Cursor rules, Continue rules, Zed prompts).
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
import { type ClientWriteResult, unwireMcpAcrossClients, wireMcpAcrossClients } from "./clients.js";
import {
  type ClientId,
  type WiringStrategy,
  capabilityFor,
  clientsForKind,
} from "./capabilities.js";
import { detectClient } from "./detection.js";
import { type WiringEntry, dropWiring, recordWiring } from "./wirings.js";
import { parseSkillSource, transformSkill } from "./skill-transformers.js";
import type { ArtifactKind } from "@metahub/shared";

interface PackageJson {
  bin?: string | Record<string, string>;
  main?: string;
  scripts?: Record<string, string>;
}

/**
 * Resolve how to launch an MCP server from its install dir. Tries (in
 * order): bin → main → scripts.start → common entry filenames.
 */
function resolveMcpLaunch(installDir: string): { command: string; args: string[] } | null {
  const pkgPath = path.join(installDir, "package.json");
  let pkg: PackageJson | null = null;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as PackageJson;
  } catch {
    /* no package.json — fall through */
  }
  if (pkg?.bin) {
    const binFile = typeof pkg.bin === "string" ? pkg.bin : Object.values(pkg.bin)[0]!;
    return { command: "node", args: [path.join(installDir, binFile)] };
  }
  if (pkg?.main) {
    return { command: "node", args: [path.join(installDir, pkg.main)] };
  }
  if (pkg?.scripts?.start) {
    return { command: "npm", args: ["start", "--prefix", installDir] };
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
      return { command: "node", args: [path.join(installDir, candidate)] };
    }
  }
  return null;
}

interface WireInput {
  kind: ArtifactKind;
  slug: string;
  ingestApiKey: string;
  installId: string;
  artifactId: string;
  portalUrl: string;
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

export interface SkillMirrorResult {
  client: ClientId;
  /** Friendly client name for the install-output line. */
  clientLabel: string;
  /** Path we wrote / skipped. */
  path: string;
  status: "wrote" | "skipped-not-detected" | "skipped-no-source" | "error";
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

function clientLabelFor(id: ClientId): string {
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
  }
}

/**
 * Mirror a skill's SKILL.md into every detected non-Claude client
 * that has a capability row for skills. Returns per-client results +
 * the ledger entries to record.
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
          clientLabel: clientLabelFor(row.client),
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

    // Other clients: only mirror when the client is actually
    // detected. Writing to ~/.cursor/rules/ for a user who doesn't
    // have Cursor would be a surprise file.
    const detected = detectClient(row.client);
    if (!detected) {
      results.push({
        client: row.client,
        clientLabel: clientLabelFor(row.client),
        path: row.targetPath(slug) ?? "(unknown)",
        status: "skipped-not-detected",
      });
      continue;
    }

    const target = row.targetPath(slug);
    if (!target) continue;

    try {
      const content = transformSkill(row.strategy as WiringStrategy, source);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, "utf8");
      results.push({
        client: row.client,
        clientLabel: clientLabelFor(row.client),
        path: target,
        status: "wrote",
      });
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
        clientLabel: clientLabelFor(row.client),
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
  const launch = resolveMcpLaunch(installDir);
  if (!launch) {
    return {
      clients: [],
      skillMirrors: [],
      warning:
        `Couldn't infer how to launch ${input.slug}'s MCP server. ` +
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
  const mcpResults = wireMcpAcrossClients(input.slug, launch, env);

  // Record MCP wirings.
  const wirings: WiringEntry[] = mcpResults
    .filter((r) => r.status === "wrote")
    .map((r) => ({
      client: clientIdFromName(r.client),
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

/** Map ClientAdapter.name → ClientId. Conservative — leaves unknown names alone. */
function clientIdFromName(name: string): ClientId {
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
  }
  return name as ClientId;
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
      // Cursor / Continue / Zed: single file per skill.
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
