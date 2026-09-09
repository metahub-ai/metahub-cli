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
import path from "node:path";
import type { ClientId } from "./capabilities.js";
import { claudeDesktopDir, documentsDir, geminiDir, getHome, userConfigDir } from "./paths.js";

function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
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
      return exists(path.join(getHome(), ".claude"));
    case "claude-desktop":
      return exists(claudeDesktopDir());
    case "cursor":
      return exists(path.join(getHome(), ".cursor"));
    case "antigravity":
      // Antigravity keeps its state under ~/.gemini/antigravity; the
      // editor build also has a VS Code-style ~/.antigravity.
      return (
        exists(path.join(geminiDir(), "antigravity")) ||
        exists(path.join(getHome(), ".antigravity"))
      );
    case "gemini-cli":
      return exists(geminiDir());
    case "vs-code":
      return exists(path.join(process.cwd(), ".vscode"));
    case "zed":
      return exists(path.join(userConfigDir(), "zed"));
    case "windsurf":
      return exists(path.join(getHome(), ".codeium", "windsurf"));
    case "continue":
      return exists(path.join(getHome(), ".continue"));
    case "cline":
      return (
        exists(path.join(documentsDir(), "Cline", "MCP")) || exists(path.join(getHome(), ".vscode"))
      );
    case "goose":
      return exists(path.join(userConfigDir(), "goose"));
    case "codex-cli":
      return exists(path.join(getHome(), ".codex"));
    case "opencode":
      return exists(path.join(userConfigDir(), "opencode"));
    case "agents-dir":
      // Not a client: the shared Agent Skills directory is always a
      // valid target because the harnesses that read it look there
      // whether or not it exists yet.
      return true;
  }
}

/** Every real client id, in catalog order. Excludes the `agents-dir` pseudo-client. */
export const CLIENT_IDS: readonly ClientId[] = [
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
  "gemini-cli",
  "opencode",
];

/** All detected clients. Used by `mh refresh` / `mh doctor`. */
export function detectedClients(): ClientId[] {
  return CLIENT_IDS.filter(detectClient);
}
