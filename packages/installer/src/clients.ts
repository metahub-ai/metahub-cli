/**
 * Multi-client MCP wiring.
 *
 * The homepage and detail page promise that `mh install mcp/<slug>`
 * wires the server into every supported client. This file is the
 * other end of that promise: an adapter list with one entry per
 * client.
 *
 *   Each adapter knows:
 *     - how to detect the client (does its config dir exist?)
 *     - where its MCP config file lives
 *     - which schema variant to use (mcpServers vs servers vs
 *       context_servers, JSON vs YAML vs TOML)
 *
 * For JSON-based clients we read → merge → write the file in place.
 * For YAML / TOML / UI-driven clients we emit a copy-paste snippet
 * the user can apply manually (no extra deps for those parsers).
 *
 * ─── Platform support ──────────────────────────────────────────────
 * Paths use `os.homedir()` + `path.join()` so they resolve correctly
 * on macOS, Linux, and Windows. Where a client's actual config dir
 * genuinely differs by OS (Claude Desktop, Cline's Documents path
 * on Windows with OneDrive redirect, Goose on Windows), we branch
 * on `process.platform` explicitly. Anything else uses the same
 * `~/.<tool>/...` convention on all three OSes.
 *
 * Sources for these paths: each tool's own docs. Kept aligned with
 * `apps/registry/src/lib/registry/client-catalog.ts` — if you add a
 * client there, add it here too so the installer actually delivers what
 * the catalog promises.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { openCodeConfigPath } from "./capabilities.js";

export interface LaunchSpec {
  command: string;
  args: string[];
}

export interface McpEnv {
  METAHUB_INGEST_API_KEY: string;
  METAHUB_INSTALL_ID: string;
  METAHUB_ARTIFACT_ID: string;
  METAHUB_PORTAL_URL: string;
  /**
   * Override the public-catalog endpoint the MCP server hits when
   * resolving `metahub_search` / `metahub_show`. Optional — the
   * server falls back to its compiled-in default when unset. We
   * forward whatever the CLI's auth-config has so the CLI and the
   * bundled MCP always agree on which catalog to read.
   */
  METAHUB_REGISTRY_URL?: string;
}

export interface ClientWriteResult {
  client: string;
  /** "wrote" — auto-merged. "manual" — emit snippet. "skipped" — not detected. */
  status: "wrote" | "manual" | "skipped";
  configPath: string;
  /** Set when status === "manual" — what the user should paste in. */
  manualSnippet?: string;
  /** Set when something went wrong but we want to continue with other clients. */
  warning?: string;
}

export interface ClientAdapter {
  name: string;
  /** Whether this client appears to be present on the machine. */
  detect: () => boolean;
  /** Config file location, expanded with $HOME. */
  configPath: () => string;
  /** Merge the entry; return new status. */
  wire: (slug: string, launch: LaunchSpec, env: McpEnv) => ClientWriteResult;
  /** Remove the entry. No-op when status === "skipped" on install. */
  unwire: (slug: string) => void;
}

// ─── helpers ────────────────────────────────────────────────────────────────

function home(): string {
  return os.homedir();
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
 * Best-effort "Documents" location. On Windows it may be redirected
 * to OneDrive; if both candidates exist we prefer OneDrive (newer
 * default in Win 11). On macOS / Linux it's always `~/Documents`.
 */
function documentsDir(): string {
  if (process.platform === "win32") {
    const onedrive = process.env.OneDrive ?? process.env.OneDriveConsumer;
    if (onedrive && exists(path.join(onedrive, "Documents"))) {
      return path.join(onedrive, "Documents");
    }
    return path.join(home(), "Documents");
  }
  return path.join(home(), "Documents");
}

/**
 * Cross-platform "user config" root. On *nix this is `$XDG_CONFIG_HOME`
 * (or `~/.config` when unset). On Windows it's `%APPDATA%` (or a
 * sensible default). Used by Goose, Zed, etc.
 */
function userConfigDir(): string {
  if (process.platform === "win32") {
    return process.env.APPDATA ?? path.join(home(), "AppData", "Roaming");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg && xdg.length > 0 ? xdg : path.join(home(), ".config");
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function jsonAdapter(opts: {
  name: string;
  detect: () => boolean;
  configPath: () => string;
  /** Some clients use a key other than "mcpServers". */
  schemaKey?: "mcpServers" | "servers" | "context_servers";
}): ClientAdapter {
  const key = opts.schemaKey ?? "mcpServers";
  return {
    name: opts.name,
    detect: opts.detect,
    configPath: opts.configPath,
    wire(slug, launch, env) {
      const file = opts.configPath();
      try {
        const config = readJson<Record<string, unknown>>(file, {});
        const existing = (config[key] as Record<string, unknown>) ?? {};
        existing[slug] = { command: launch.command, args: launch.args, env };
        config[key] = existing;
        writeJson(file, config);
        return { client: opts.name, status: "wrote", configPath: file };
      } catch (err) {
        return {
          client: opts.name,
          status: "skipped",
          configPath: file,
          warning: (err as Error).message,
        };
      }
    },
    unwire(slug) {
      const file = opts.configPath();
      if (!exists(file)) return;
      const config = readJson<Record<string, unknown>>(file, {});
      const existing = (config[key] as Record<string, unknown>) ?? {};
      if (slug in existing) {
        delete existing[slug];
        config[key] = existing;
        writeJson(file, config);
      }
    },
  };
}

/**
 * Claude Code stores user-scoped MCP servers in ~/.claude.json. Older
 * MetaHub releases incorrectly wrote them to ~/.claude/settings.json,
 * which Claude Code reserves for settings such as permissions and hooks.
 * Remove that stale entry after a successful write, and from both locations
 * during uninstall, so upgrading repairs existing installations.
 */
function claudeCodeAdapter(): ClientAdapter {
  const current = jsonAdapter({
    name: "Claude Code",
    detect: () => exists(path.join(home(), ".claude")),
    configPath: () => path.join(home(), ".claude.json"),
  });
  const legacy = jsonAdapter({
    name: "Claude Code",
    detect: () => exists(path.join(home(), ".claude")),
    configPath: () => path.join(home(), ".claude", "settings.json"),
  });

  return {
    ...current,
    wire(slug, launch, env) {
      const result = current.wire(slug, launch, env);
      if (result.status === "wrote") legacy.unwire(slug);
      return result;
    },
    unwire(slug) {
      current.unwire(slug);
      legacy.unwire(slug);
    },
  };
}

/**
 * For clients we can't safely auto-edit (YAML, TOML, UI-only), return
 * a copy-paste snippet so the user can wire it manually. The CLI
 * surfaces this in its post-install summary.
 */
function manualAdapter(opts: {
  name: string;
  detect: () => boolean;
  configPath: () => string;
  snippet: (slug: string, launch: LaunchSpec, env: McpEnv) => string;
}): ClientAdapter {
  return {
    name: opts.name,
    detect: opts.detect,
    configPath: opts.configPath,
    wire(slug, launch, env) {
      return {
        client: opts.name,
        status: "manual",
        configPath: opts.configPath(),
        manualSnippet: opts.snippet(slug, launch, env),
      };
    },
    // We can't safely remove from a hand-edited YAML/TOML/UI config.
    unwire() {
      /* no-op */
    },
  };
}

// ─── adapter list — order matters: matches catalog order ────────────────────

export const CLIENT_ADAPTERS: ClientAdapter[] = [
  // 1. Claude Code — user-scoped MCP JSON at ~/.claude.json
  claudeCodeAdapter(),

  // 2. Claude Desktop — JSON at platform-specific path
  jsonAdapter({
    name: "Claude Desktop",
    detect: () => exists(claudeDesktopDir()),
    configPath: () => path.join(claudeDesktopDir(), "claude_desktop_config.json"),
  }),

  // 3. Cursor — JSON at ~/.cursor/mcp.json
  jsonAdapter({
    name: "Cursor",
    detect: () => exists(path.join(home(), ".cursor")),
    configPath: () => path.join(home(), ".cursor", "mcp.json"),
  }),

  // 4. Antigravity — UI-driven; emit a snippet
  manualAdapter({
    name: "Antigravity",
    detect: () => exists(path.join(home(), ".antigravity")),
    configPath: () => "Antigravity → Settings → MCP servers",
    snippet: (slug, launch, env) =>
      JSON.stringify(
        { mcpServers: { [slug]: { command: launch.command, args: launch.args, env } } },
        null,
        2,
      ),
  }),

  // 5. VS Code — uses `servers` key, in .vscode/mcp.json (workspace).
  //    We only auto-write when run from inside a project that already
  //    has a .vscode folder — otherwise we'd be guessing.
  jsonAdapter({
    name: "VS Code",
    detect: () => exists(path.join(process.cwd(), ".vscode")),
    configPath: () => path.join(process.cwd(), ".vscode", "mcp.json"),
    schemaKey: "servers",
  }),

  // 6. Zed — uses `context_servers` key
  //    Zed is unreleased on Windows; the path follows XDG on *nix.
  jsonAdapter({
    name: "Zed",
    detect: () => exists(path.join(userConfigDir(), "zed")),
    configPath: () => path.join(userConfigDir(), "zed", "settings.json"),
    schemaKey: "context_servers",
  }),

  // 7. Windsurf
  jsonAdapter({
    name: "Windsurf",
    detect: () => exists(path.join(home(), ".codeium", "windsurf")),
    configPath: () => path.join(home(), ".codeium", "windsurf", "mcp_config.json"),
  }),

  // 8. Continue — YAML; emit snippet
  manualAdapter({
    name: "Continue",
    detect: () => exists(path.join(home(), ".continue")),
    configPath: () => path.join(home(), ".continue", "config.yaml"),
    snippet: (slug, launch) =>
      `mcpServers:
  - name: ${slug}
    command: ${launch.command}
    args:
${launch.args.map((a) => `      - ${a}`).join("\n")}`,
  }),

  // 9. Cline — VS Code extension; managed via UI panel.
  //    On Windows the Documents folder may be redirected to OneDrive.
  manualAdapter({
    name: "Cline",
    detect: () =>
      exists(path.join(documentsDir(), "Cline", "MCP")) || exists(path.join(home(), ".vscode")),
    configPath: () => "Cline panel → MCP Servers → Add",
    snippet: (slug, launch, env) =>
      JSON.stringify(
        {
          mcpServers: {
            [slug]: { command: launch.command, args: launch.args, env },
          },
        },
        null,
        2,
      ),
  }),

  // 10. Goose — YAML; uses `extensions` key. XDG on *nix, %APPDATA% on Win.
  manualAdapter({
    name: "Goose",
    detect: () => exists(path.join(userConfigDir(), "goose")),
    configPath: () => path.join(userConfigDir(), "goose", "config.yaml"),
    snippet: (slug, launch) =>
      `extensions:
  ${slug}:
    type: stdio
    cmd: ${launch.command}
    args:
${launch.args.map((a) => `      - ${a}`).join("\n")}
    enabled: true`,
  }),

  // 11. Codex CLI — TOML
  manualAdapter({
    name: "Codex CLI",
    detect: () => exists(path.join(home(), ".codex")),
    configPath: () => path.join(home(), ".codex", "config.toml"),
    snippet: (slug, launch) =>
      `[mcp_servers.${slug}]
command = "${launch.command}"
args = [${launch.args.map((a) => `"${a}"`).join(", ")}]`,
  }),

  // 12. opencode — JSON at ~/.config/opencode/opencode.json (or .jsonc).
  //     Deletes from the shared opencode MCP schema: servers live under the
  //     `mcp` key as `{ "type": "local", "command": [...], "environment": {...} }`.
  {
    name: "opencode",
    detect: () => exists(path.join(userConfigDir(), "opencode")),
    configPath: openCodeConfigPath,
    wire(slug, launch, env) {
      const file = openCodeConfigPath();
      try {
        const config = readJson<Record<string, unknown>>(file, {});
        const existing = (config["mcp"] as Record<string, unknown>) ?? {};
        existing[slug] = {
          type: "local",
          command: [launch.command, ...launch.args],
          environment: env,
          enabled: true,
        };
        config["mcp"] = existing;
        writeJson(file, config);
        return { client: "opencode", status: "wrote", configPath: file };
      } catch (err) {
        return {
          client: "opencode",
          status: "skipped",
          configPath: file,
          warning: (err as Error).message,
        };
      }
    },
    unwire(slug) {
      const file = openCodeConfigPath();
      if (!exists(file)) return;
      const config = readJson<Record<string, unknown>>(file, {});
      const existing = (config["mcp"] as Record<string, unknown>) ?? {};
      if (slug in existing) {
        delete existing[slug];
        config["mcp"] = existing;
        writeJson(file, config);
      }
    },
  },
];

function claudeDesktopDir(): string {
  if (process.platform === "darwin") {
    return path.join(home(), "Library", "Application Support", "Claude");
  }
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA ?? path.join(home(), "AppData", "Roaming");
    return path.join(appdata, "Claude");
  }
  // Linux is unofficial — best guess.
  return path.join(home(), ".config", "Claude");
}

/**
 * Wire the MCP into every detected client. Returns per-client results
 * so the caller can render a clean summary.
 *
 * Behavior:
 *   - For detected JSON clients: merges the entry and reports "wrote"
 *   - For detected non-JSON clients: emits a copy-paste snippet
 *   - For undetected clients: skipped silently (no surprise files)
 *   - Falls back to Claude Code if nothing was detected (since that's
 *     the historical "default" and ensures `mh install` always does
 *     SOMETHING the user can act on)
 */
export function wireMcpAcrossClients(
  slug: string,
  launch: LaunchSpec,
  env: McpEnv,
): ClientWriteResult[] {
  const detected = CLIENT_ADAPTERS.filter((a) => a.detect());
  const targets = detected.length > 0 ? detected : [CLIENT_ADAPTERS[0]!];
  return targets.map((a) => a.wire(slug, launch, env));
}

/** Remove the entry from every client we know about. Idempotent. */
export function unwireMcpAcrossClients(slug: string): void {
  for (const a of CLIENT_ADAPTERS) {
    try {
      a.unwire(slug);
    } catch {
      /* never let one client's failure block the others */
    }
  }
}
