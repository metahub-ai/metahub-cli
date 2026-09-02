/**
 * Detect whether an AI client is installed on this machine. Returns
 * a boolean per ClientId. Used by:
 *   - The matrix-driven wiring pipeline (skip clients we don't see)
 *   - `mh refresh` (re-detect what's present now vs. when we last
 *     installed an artifact)
 *
 * Detection is path-based today — when a client's user-config dir
 * exists, we treat it as installed. This is consistent with the
 * existing `ClientAdapter.detect()` behavior in clients.ts; we
 * extract it here so the matrix can use the same logic without
 * pulling in the MCP-write surface.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClientId } from "./capabilities.js";

const HOME = os.homedir();

function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function xdgConfigDir(): string {
  if (process.platform === "darwin") return path.join(HOME, ".config");
  if (process.platform === "win32") {
    return process.env.APPDATA ?? path.join(HOME, "AppData", "Roaming");
  }
  return process.env.XDG_CONFIG_HOME ?? path.join(HOME, ".config");
}

function claudeDesktopDir(): string {
  if (process.platform === "darwin") {
    return path.join(HOME, "Library", "Application Support", "Claude");
  }
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA ?? path.join(HOME, "AppData", "Roaming");
    return path.join(appdata, "Claude");
  }
  return path.join(HOME, ".config", "Claude");
}

function documentsDir(): string {
  if (process.platform === "win32") {
    const onedrive = process.env.OneDrive ?? process.env.OneDriveConsumer;
    if (onedrive) return path.join(onedrive, "Documents");
    return path.join(HOME, "Documents");
  }
  return path.join(HOME, "Documents");
}

/**
 * Best-effort detection. Returns true when we have signal the client
 * is on disk; false otherwise. False negatives are safer than false
 * positives — surprising the user with a write to ~/.cursor/rules/
 * when they don't use Cursor is the failure mode we avoid.
 */
export function detectClient(id: ClientId): boolean {
  switch (id) {
    case "claude-code":
      return exists(path.join(HOME, ".claude"));
    case "claude-desktop":
      return exists(claudeDesktopDir());
    case "cursor":
      return exists(path.join(HOME, ".cursor"));
    case "antigravity":
      return exists(path.join(HOME, ".antigravity"));
    case "vs-code":
      return exists(path.join(process.cwd(), ".vscode"));
    case "zed":
      return exists(path.join(xdgConfigDir(), "zed"));
    case "windsurf":
      return exists(path.join(HOME, ".codeium", "windsurf"));
    case "continue":
      return exists(path.join(HOME, ".continue"));
    case "cline":
      return (
        exists(path.join(documentsDir(), "Cline", "MCP")) || exists(path.join(HOME, ".vscode"))
      );
    case "goose":
      return exists(path.join(xdgConfigDir(), "goose"));
    case "codex-cli":
      return exists(path.join(HOME, ".codex"));
    case "opencode":
      return exists(path.join(xdgConfigDir(), "opencode"));
  }
}

/** All detected clients. Used by `mh refresh` / `mh doctor`. */
export function detectedClients(): ClientId[] {
  const ids: ClientId[] = [
    "claude-code",
    "claude-desktop",
    "cursor",
    "antigravity",
    "vs-code",
    "zed",
    "windsurf",
    "continue",
    "cline",
    "goose",
    "codex-cli",
    "opencode",
  ];
  return ids.filter(detectClient);
}
