/**
 * Where the installer puts files on the user's machine.
 *
 * The auth package owns the shared `~/.metahub/` root; this module only
 * adds the per-kind install path resolution and a couple of derived
 * paths (the installs ledger, the Claude Code user config file).
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type { ArtifactKind } from "@metahub/shared";
import { configRoot } from "@metahub/auth";

/**
 * The home directory every installer path resolves against.
 *
 * `METAHUB_E2E_HOME` must be honoured by **every** module that touches
 * the filesystem, not just this one. `clients.ts` and `detection.ts`
 * used to call `os.homedir()` directly, which split the installer's
 * view of "home" in two: an MCP-kind install wrote the artifact under
 * the overridden home but wired it — along with the `mhi_` ingest
 * credential in the launch env — into the *real* `~/.claude/settings.json`.
 * That leaked test/CI/eval-worker state into the developer's own editor
 * config and left the two halves pointing at different trees.
 *
 * Exported so those modules share this one definition.
 */
export function getHome(): string {
  return process.env.METAHUB_E2E_HOME || os.homedir();
}

/**
 * True when the caller has explicitly sandboxed the installer via
 * `METAHUB_E2E_HOME`.
 *
 * Ambient location env vars (`XDG_CONFIG_HOME`, `APPDATA`, `OneDrive`)
 * point at the *real* user profile, so honouring them inside a sandbox
 * silently re-escapes it — on a typical Linux desktop `XDG_CONFIG_HOME`
 * is set to `~/.config`, which sent Zed / Goose / Cline wiring to the
 * developer's actual config while everything else went to the sandbox.
 * Under an explicit override the sandbox wins.
 */
function sandboxed(): boolean {
  return Boolean(process.env.METAHUB_E2E_HOME);
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
 * Cross-platform "user config" root. `$XDG_CONFIG_HOME` (or
 * `~/.config`) on *nix, `%APPDATA%` on Windows. Used by Goose, Zed,
 * Cline, etc. Shared by `clients.ts`, `detection.ts` and
 * `capabilities.ts` so the three cannot drift apart again.
 */
export function userConfigDir(): string {
  const home = getHome();
  if (process.platform === "darwin") return path.join(home, ".config");
  if (process.platform === "win32") {
    const appdata = sandboxed() ? undefined : process.env.APPDATA;
    return appdata ?? path.join(home, "AppData", "Roaming");
  }
  const xdg = sandboxed() ? undefined : process.env.XDG_CONFIG_HOME;
  return xdg && xdg.length > 0 ? xdg : path.join(home, ".config");
}

/** Claude Desktop's per-OS config directory. */
export function claudeDesktopDir(): string {
  const home = getHome();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Claude");
  }
  if (process.platform === "win32") {
    const appdata = sandboxed() ? undefined : process.env.APPDATA;
    return path.join(appdata ?? path.join(home, "AppData", "Roaming"), "Claude");
  }
  return path.join(home, ".config", "Claude");
}

/**
 * Best-effort "Documents" location. On Windows it may be redirected to
 * OneDrive; if both candidates exist we prefer OneDrive (the newer Win
 * 11 default). On macOS / Linux it is always `~/Documents`.
 */
export function documentsDir(): string {
  const home = getHome();
  if (process.platform === "win32" && !sandboxed()) {
    const onedrive = process.env.OneDrive ?? process.env.OneDriveConsumer;
    if (onedrive && exists(path.join(onedrive, "Documents"))) {
      return path.join(onedrive, "Documents");
    }
  }
  return path.join(home, "Documents");
}

export function installsFile(): string {
  return path.join(configRoot(), "installs.json");
}

/**
 * The on-disk install path for each kind. Iteration 1 targets Claude
 * Code. Other hosts come later.
 */
export function installPathFor(kind: ArtifactKind, slug: string): string {
  const home = getHome();
  switch (kind) {
    case "skill":
      return path.join(home, ".claude", "skills", slug);
    case "plugin":
      return path.join(home, ".claude", "plugins", slug);
    case "agent":
      return path.join(configRoot(), "agents", slug);
    case "mcp":
      // MCP servers are config entries, not files. We still create a
      // metadata folder so `mh list` / `mh uninstall` have something
      // concrete to enumerate.
      return path.join(configRoot(), "mcp", slug);
  }
}

export function claudeSettingsFile(): string {
  return path.join(getHome(), ".claude.json");
}

export { configRoot, configFile, writePrivateFile, isPrivateFile } from "@metahub/auth";
