/**
 * Where the installer puts files on the user's machine.
 *
 * The auth package owns the shared `~/.metahub/` root; this module only
 * adds the per-kind install path resolution and a couple of derived
 * paths (the installs ledger, the Claude Code user config file).
 */
import path from "node:path";
import os from "node:os";
import type { ArtifactKind } from "@metahub/shared";
import { configRoot } from "@metahub/auth";

function getHome(): string {
  return process.env.METAHUB_E2E_HOME || os.homedir();
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
