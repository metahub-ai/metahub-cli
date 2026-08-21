/**
 * High-level orchestration for `installArtifact` / `uninstallArtifact` /
 * `listInstalled`. This is the surface both the CLI and the MCP server
 * consume — the library has no `console.log` so the caller decides how
 * to surface progress (spinner, MCP tool message, structured stream).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { ArtifactKind } from "@metahub/shared";
import { loadAuthConfig } from "@metahub/auth";
import { getInstallInfo } from "./portal-api.js";
import { installPathFor } from "./paths.js";
import { fetchAndExtractTarball } from "./tarball.js";
import { wireHook, unwireHook, type SkillMirrorResult } from "./hooks.js";
import { findRelatedSkills } from "./related-skills.js";
import {
  findInstall,
  listInstalls,
  recordInstall,
  removeInstall,
  type InstalledRecord,
} from "./installs.js";
import type { ClientWriteResult } from "./clients.js";

export type ClientName = string;

/**
 * The host string the installer reports to the portal when registering
 * an install. Defaults to "metahub-installer" but the CLI overrides to
 * "mh-cli" and the MCP server (Phase 7) will pass its own.
 */
export interface InstallOptions {
  kind: ArtifactKind;
  slug: string;
  /** Bearer token override. Defaults to `~/.metahub/config.json`. */
  token?: string;
  /** Progress events for callers that want to render status. */
  onProgress?: (event: InstallProgressEvent) => void;
  /**
   * Host identifier reported to the portal. Used to attribute installs
   * back to the consuming surface. Defaults to "metahub-installer".
   */
  host?: string;
  /**
   * Version string surfaced to the portal alongside `host` + `platform`.
   * Callers should pass their own package.json version.
   */
  hostVersion?: string;
}

export interface InstallResult {
  artifactId: string;
  installId: string;
  /** Published SHA the install was pinned to. */
  sha: string | null;
  /** Artifact display name + semver (when available). */
  name: string;
  version: string | null;
  /** Absolute path of the install dir. */
  installPath: string;
  /** MCP-only — one entry per client probed at install time. */
  clientsWired: ClientWriteResult[];
  /**
   * For skill installs: per-client mirror results. Empty for other
   * kinds. Surfaces where the skill was wired (Cursor rules, Continue
   * rules, Zed prompts) and which clients were skipped/errored.
   */
  skillMirrors: SkillMirrorResult[];
  /**
   * For skill installs: sibling skills from the same repo that were
   * installed alongside the requested one (the specialist skills a
   * `.claude-plugin/marketplace.json` groups with the requested
   * skill). Empty for other kinds and for single-skill repos.
   */
  relatedSkills: Array<{ slug: string; installPath: string }>;
  /** Non-fatal warnings that surfaced during wiring. */
  warning?: string;
}

export interface UninstallResult {
  removed: boolean;
  record: InstalledRecord | null;
}

export type InstallProgressEvent =
  | { stage: "resolve"; kind: ArtifactKind; slug: string }
  | { stage: "replace-existing"; path: string }
  | { stage: "download"; sha: string | null; subPath: string | null }
  | { stage: "related"; slug: string; path: string }
  | { stage: "wire"; kind: ArtifactKind; slug: string }
  | { stage: "record"; installPath: string };

/**
 * Copy `src` into `dest` atomically: stage into `<dest>.tmp`, then
 * swap. A slow or interrupted copy must never leave the existing
 * install wiped — only a complete copy replaces it.
 */
function promoteDir(
  src: string,
  dest: string,
  onProgress?: (event: InstallProgressEvent) => void,
): void {
  const tmp = `${dest}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    fs.cpSync(src, tmp, { recursive: true });
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  if (fs.existsSync(dest)) {
    onProgress?.({ stage: "replace-existing", path: dest });
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.renameSync(tmp, dest);
}

export async function installArtifact(opts: InstallOptions): Promise<InstallResult> {
  const { kind, slug, onProgress } = opts;
  onProgress?.({ stage: "resolve", kind, slug });

  const info = await getInstallInfo(
    kind,
    slug,
    {
      host: opts.host ?? "metahub-installer",
      platform: `${process.platform}-${process.arch}`,
      cliVersion: opts.hostVersion ?? "0.0.0",
    },
    opts.token,
  );

  const dest = installPathFor(kind, slug);
  const subPath = info.artifact.repoPath ?? null;
  onProgress?.({
    stage: "download",
    sha: info.artifact.publishedSha ?? null,
    subPath,
  });

  // Skills extract the whole repo into a staging dir first so sibling
  // skills the repo groups with this one (via .claude-plugin
  // marketplace.json / plugin.json) can be discovered and installed
  // alongside — matching what Claude Code's plugin install picks up.
  // Other kinds stream straight into their dest as before.
  const relatedInstalled: Array<{ slug: string; installPath: string }> = [];
  if (kind === "skill") {
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "mh-skill-extract-"));
    try {
      await fetchAndExtractTarball(info.tarballUrl, staging);
      const src = subPath ? path.join(staging, subPath) : staging;
      if (!fs.existsSync(src)) {
        throw new Error(`Sub-path "${subPath}" not found in the downloaded archive.`);
      }
      promoteDir(src, dest, onProgress);
      // Promote the related skills while staging is still on disk. A
      // sibling the user installed (or manages) on its own is left
      // alone — only satellites of this same skill move with it, so
      // an explicit standalone install is never clobbered by a
      // sibling's update.
      for (const rel of findRelatedSkills(staging, subPath ?? "")) {
        // A differently nested directory can share the requested
        // artifact's install slug. Never let a related directory
        // overwrite the primary install destination.
        if (rel.slug === slug) continue;
        const existing = findInstall("skill", rel.slug);
        if (existing && existing.installedWith !== slug) continue;
        const relDest = installPathFor("skill", rel.slug);
        onProgress?.({ stage: "related", slug: rel.slug, path: relDest });
        promoteDir(rel.sourceDir, relDest, onProgress);
        relatedInstalled.push({ slug: rel.slug, installPath: relDest });
      }
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  } else {
    // Extract into a temp dir first, then atomically swap it into place. A slow
    // or failed download (now timeout-bounded) must never leave the existing
    // install wiped — only replace it once the new copy is fully on disk.
    const tmp = `${dest}.tmp`;
    fs.rmSync(tmp, { recursive: true, force: true });
    try {
      await fetchAndExtractTarball(info.tarballUrl, tmp, { subPath });
    } catch (err) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw err;
    }
    if (fs.existsSync(dest)) {
      onProgress?.({ stage: "replace-existing", path: dest });
      fs.rmSync(dest, { recursive: true, force: true });
    }
    fs.renameSync(tmp, dest);
  }

  const cfg = loadAuthConfig();
  onProgress?.({ stage: "wire", kind, slug });
  const wired = wireHook({
    kind,
    slug,
    ingestApiKey: info.ingestApiKey,
    installId: info.installId,
    artifactId: info.artifact.id,
    portalUrl: cfg.portalUrl,
  });

  onProgress?.({ stage: "record", installPath: dest });
  recordInstall({
    artifactId: info.artifact.id,
    installId: info.installId,
    slug,
    kind,
    version: info.artifact.version,
    installPath: dest,
    ingestApiKey: info.ingestApiKey,
    publishedSha: info.artifact.publishedSha,
    installedAt: new Date().toISOString(),
  });

  // Same treatment as the primary for every related skill: telemetry
  // sidecar, client mirrors, wiring ledger, install ledger. Each is
  // its own ledger row so list / update / uninstall see it.
  for (const rel of relatedInstalled) {
    wireHook({
      kind: "skill",
      slug: rel.slug,
      ingestApiKey: info.ingestApiKey,
      installId: info.installId,
      artifactId: info.artifact.id,
      portalUrl: cfg.portalUrl,
    });
    recordInstall({
      artifactId: info.artifact.id,
      installId: info.installId,
      slug: rel.slug,
      kind: "skill",
      version: info.artifact.version,
      installPath: rel.installPath,
      ingestApiKey: info.ingestApiKey,
      publishedSha: info.artifact.publishedSha,
      installedAt: new Date().toISOString(),
      installedWith: slug,
    });
  }

  return {
    artifactId: info.artifact.id,
    installId: info.installId,
    sha: info.artifact.publishedSha ?? null,
    name: info.artifact.name,
    version: info.artifact.version,
    installPath: dest,
    clientsWired: wired.clients,
    skillMirrors: wired.skillMirrors,
    relatedSkills: relatedInstalled,
    warning: wired.warning,
  };
}

export async function uninstallArtifact(opts: {
  kind: ArtifactKind;
  slug: string;
}): Promise<UninstallResult> {
  const removed = removeInstall(opts.kind, opts.slug);
  if (!removed) {
    return { removed: false, record: null };
  }
  if (fs.existsSync(removed.installPath)) {
    fs.rmSync(removed.installPath, { recursive: true, force: true });
  }
  unwireHook(opts.kind, opts.slug);
  return { removed: true, record: removed };
}

export async function listInstalled(): Promise<InstalledRecord[]> {
  return listInstalls();
}

export { findInstall };
