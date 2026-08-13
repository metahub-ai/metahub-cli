/**
 * High-level orchestration for `installArtifact` / `uninstallArtifact` /
 * `listInstalled`. This is the surface both the CLI and the MCP server
 * consume — the library has no `console.log` so the caller decides how
 * to surface progress (spinner, MCP tool message, structured stream).
 */
import fs from "node:fs";
import process from "node:process";
import type { ArtifactKind } from "@metahub/shared";
import { loadAuthConfig } from "@metahub/auth";
import { getInstallInfo } from "./portal-api.js";
import { installPathFor } from "./paths.js";
import { fetchAndExtractTarball } from "./tarball.js";
import { wireHook, unwireHook, type SkillMirrorResult } from "./hooks.js";
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
  | { stage: "wire"; kind: ArtifactKind; slug: string }
  | { stage: "record"; installPath: string };

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

  return {
    artifactId: info.artifact.id,
    installId: info.installId,
    sha: info.artifact.publishedSha ?? null,
    name: info.artifact.name,
    version: info.artifact.version,
    installPath: dest,
    clientsWired: wired.clients,
    skillMirrors: wired.skillMirrors,
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
