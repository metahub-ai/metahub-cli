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
 *       context_servers vs mcp, JSON vs YAML vs TOML)
 *
 * For JSON-based clients we read → merge → write the file in place.
 * For YAML / TOML / UI-driven clients we emit a copy-paste snippet
 * the user can apply manually (no extra deps for those parsers), or
 * shell out to the client's own CLI when it ships one (Codex).
 *
 * ─── Platform support ──────────────────────────────────────────────
 * Paths use the installer's shared `getHome()` (which honours
 * `METAHUB_E2E_HOME`) + `path.join()` so they resolve correctly
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
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import {
  antigravityMcpConfigPath,
  claudeDesktopDir,
  documentsDir,
  geminiDir,
  geminiSettingsFile,
  getHome,
  openCodeConfigPath,
  userConfigDir,
  writePrivateFile,
} from "./paths.js";

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
  /** "wrote" — auto-merged. "manual" — emit snippet. "skipped" — not detected or not writable. */
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
  return getHome();
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
 * Outcome of reading a client's JSON config.
 *
 * "absent" and "invalid" used to collapse into the same empty object,
 * so a config that existed but could not be parsed (a half-written
 * file, a stray trailing comma, a `.jsonc` full of comments) was
 * silently replaced by `{ mcpServers: { <slug>: … } }` on the next
 * wire — every other server the user had configured was gone. The
 * three states are kept apart so an invalid file is never written to.
 */
export type JsonConfigRead =
  | { state: "absent" }
  | { state: "ok"; data: Record<string, unknown> }
  | { state: "invalid"; error: string };

export function readJsonConfig(file: string): JsonConfigRead {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
    return { state: "invalid", error: (err as Error).message };
  }
  // An empty file is what several clients leave behind before their
  // first save (Antigravity ships a zero-byte mcp_config.json); treat
  // it as an empty object rather than as corruption.
  if (raw.trim().length === 0) return { state: "ok", data: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { state: "invalid", error: "top-level value is not an object" };
    }
    return { state: "ok", data: parsed as Record<string, unknown> };
  } catch (err) {
    return { state: "invalid", error: (err as Error).message };
  }
}

function invalidConfigWarning(file: string, error: string): string {
  return (
    `${file} exists but is not valid JSON (${error}). ` +
    `Left untouched so nothing is lost — fix or remove it, then re-run.`
  );
}

/**
 * Write a client's MCP config.
 *
 * Uses `writePrivateFile` (0600, re-chmod'd on every write) rather than
 * a bare `writeFileSync`, because the entry we merge in carries the
 * per-install `METAHUB_INGEST_API_KEY` — an `mhi_` write credential —
 * in its launch env. These files were previously left at the umask
 * default (0644 on a typical Linux box), so every MCP-kind install put
 * a live credential in a world-readable file while `~/.metahub/config.json`
 * and `installs.json` were carefully locked down for exactly this reason.
 *
 * These are user-level dotfiles owned by the same user that runs the
 * client, so tightening the mode does not change who can read them in
 * practice — it only removes the other/group bits. `unwire` writes
 * through here too: a config that no longer holds a secret keeps the
 * tighter mode, which is the safe direction.
 */
function writeJson(file: string, data: unknown, opts: { private?: boolean } = {}): void {
  if (opts.private === false) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
    return;
  }
  writePrivateFile(file, JSON.stringify(data, null, 2));
}

function jsonAdapter(opts: {
  name: string;
  detect: () => boolean;
  configPath: () => string;
  /** Some clients use a key other than "mcpServers". */
  schemaKey?: "mcpServers" | "servers" | "context_servers";
  /**
   * Whether this client's config is a private per-user dotfile.
   *
   * Defaults to true, which is what gets it 0600 — the entry we merge in
   * carries the `mhi_` ingest credential. Set false for a config that is
   * NOT per-user: VS Code's lives in the *workspace* (`.vscode/mcp.json`),
   * where 0600 can lock the editor server out entirely if it runs under a
   * different uid than the one that ran the install — a devcontainer or CI
   * image, say — and the file may legitimately be shared or committed.
   */
  privateConfig?: boolean;
}): ClientAdapter {
  const key = opts.schemaKey ?? "mcpServers";
  const isPrivate = opts.privateConfig ?? true;
  return {
    name: opts.name,
    detect: opts.detect,
    configPath: opts.configPath,
    wire(slug, launch, env) {
      const file = opts.configPath();
      const read = readJsonConfig(file);
      if (read.state === "invalid") {
        return {
          client: opts.name,
          status: "skipped",
          configPath: file,
          warning: invalidConfigWarning(file, read.error),
        };
      }
      try {
        const config = read.state === "ok" ? read.data : {};
        const existing = (config[key] as Record<string, unknown>) ?? {};
        existing[slug] = { command: launch.command, args: launch.args, env };
        config[key] = existing;
        writeJson(file, config, { private: isPrivate });
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
      const read = readJsonConfig(file);
      if (read.state !== "ok") return;
      const config = read.data;
      const existing = (config[key] as Record<string, unknown>) ?? {};
      if (slug in existing) {
        delete existing[slug];
        config[key] = existing;
        writeJson(file, config, { private: isPrivate });
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

/**
 * opencode declares MCP servers under the `mcp` key of its global
 * config as `{ type: "local", command: [cmd, ...args], environment,
 * enabled }` — a different shape from the `mcpServers` family, so it
 * gets its own adapter rather than a `schemaKey`.
 */
function opencodeAdapter(): ClientAdapter {
  const name = "opencode";
  return {
    name,
    detect: () => exists(path.join(userConfigDir(), "opencode")),
    configPath: () => openCodeConfigPath(),
    wire(slug, launch, env) {
      const file = openCodeConfigPath();
      const read = readJsonConfig(file);
      if (read.state === "invalid") {
        return {
          client: name,
          status: "skipped",
          configPath: file,
          warning: invalidConfigWarning(file, read.error),
        };
      }
      try {
        const config = read.state === "ok" ? read.data : {};
        const existing = (config.mcp as Record<string, unknown>) ?? {};
        existing[slug] = {
          type: "local",
          command: [launch.command, ...launch.args],
          environment: env,
          enabled: true,
        };
        config.mcp = existing;
        writeJson(file, config);
        return { client: name, status: "wrote", configPath: file };
      } catch (err) {
        return {
          client: name,
          status: "skipped",
          configPath: file,
          warning: (err as Error).message,
        };
      }
    },
    unwire(slug) {
      const file = openCodeConfigPath();
      const read = readJsonConfig(file);
      if (read.state !== "ok") return;
      const config = read.data;
      const existing = (config.mcp as Record<string, unknown>) ?? {};
      if (slug in existing) {
        delete existing[slug];
        config.mcp = existing;
        writeJson(file, config);
      }
    },
  };
}

/**
 * The `codex` binary, when it is on PATH. `METAHUB_CODEX_BIN` overrides
 * the lookup (tests point it at a stub; an empty value forces the
 * snippet path).
 */
export function codexBinary(): string | null {
  const override = process.env.METAHUB_CODEX_BIN;
  if (override !== undefined) return override.length > 0 && exists(override) ? override : null;
  const names = process.platform === "win32" ? ["codex.cmd", "codex.exe", "codex"] : ["codex"];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const candidate = path.join(dir, n);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

function codexSnippet(slug: string, launch: LaunchSpec, env: McpEnv): string {
  const lines = [
    `[mcp_servers.${slug}]`,
    `command = ${JSON.stringify(launch.command)}`,
    `args = [${launch.args.map((a) => JSON.stringify(a)).join(", ")}]`,
  ];
  const kv = Object.entries(env).filter(([, v]) => typeof v === "string" && v.length > 0);
  if (kv.length > 0) {
    lines.push("", `[mcp_servers.${slug}.env]`);
    for (const [k, v] of kv) lines.push(`${k} = ${JSON.stringify(v)}`);
  }
  return lines.join("\n");
}

/**
 * Codex CLI keeps MCP servers in `~/.codex/config.toml`. There is no
 * TOML writer in this package, so when the `codex` binary is present
 * the entry is added through `codex mcp add` (the supported way to
 * edit that file); otherwise the TOML snippet is returned for pasting.
 */
function codexAdapter(): ClientAdapter {
  const name = "Codex CLI";
  const configPath = () => path.join(home(), ".codex", "config.toml");
  const codexEnv = () => ({
    ...process.env,
    // Keep codex pointed at the same home the installer resolves, so a
    // sandboxed run never edits the real ~/.codex/config.toml.
    CODEX_HOME: process.env.METAHUB_E2E_HOME
      ? path.join(home(), ".codex")
      : (process.env.CODEX_HOME ?? path.join(home(), ".codex")),
  });
  const run = (bin: string, args: string[]) =>
    spawnSync(bin, args, {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: codexEnv(),
      shell: process.platform === "win32",
    });
  return {
    name,
    detect: () => exists(path.join(home(), ".codex")),
    configPath,
    wire(slug, launch, env) {
      const file = configPath();
      const manual = (): ClientWriteResult => ({
        client: name,
        status: "manual",
        configPath: file,
        manualSnippet: codexSnippet(slug, launch, env),
      });
      const bin = codexBinary();
      if (!bin) return manual();
      // `add` does not replace an existing entry; drop any old one first.
      run(bin, ["mcp", "remove", slug]);
      const args = ["mcp", "add", slug];
      for (const [k, v] of Object.entries(env)) {
        if (typeof v === "string" && v.length > 0) args.push("--env", `${k}=${v}`);
      }
      args.push("--", launch.command, ...launch.args);
      const res = run(bin, args);
      if (res.status === 0) return { client: name, status: "wrote", configPath: file };
      const detail =
        `${res.stderr ?? ""}\n${res.stdout ?? ""}`.trim().split("\n").filter(Boolean).pop() ??
        res.error?.message ??
        `exit ${res.status}`;
      return {
        ...manual(),
        warning: `codex mcp add failed (${detail}) — paste the snippet instead.`,
      };
    },
    unwire(slug) {
      const bin = codexBinary();
      if (!bin) return;
      run(bin, ["mcp", "remove", slug]);
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

  // 4. Antigravity — JSON at ~/.gemini/config/mcp_config.json (legacy
  //    ~/.gemini/antigravity/mcp_config.json), standard `mcpServers` schema.
  jsonAdapter({
    name: "Antigravity",
    detect: () =>
      exists(path.join(geminiDir(), "antigravity")) || exists(path.join(home(), ".antigravity")),
    configPath: () => antigravityMcpConfigPath(),
  }),

  // 5. VS Code — uses `servers` key, in .vscode/mcp.json (workspace).
  //    We only auto-write when run from inside a project that already
  //    has a .vscode folder — otherwise we'd be guessing.
  jsonAdapter({
    name: "VS Code",
    detect: () => exists(path.join(process.cwd(), ".vscode")),
    configPath: () => path.join(process.cwd(), ".vscode", "mcp.json"),
    // Workspace file, not a per-user dotfile — see `privateConfig`.
    privateConfig: false,
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

  // 11. Codex CLI — TOML via `codex mcp add`, snippet otherwise
  codexAdapter(),

  // 12. Gemini CLI — JSON at ~/.gemini/settings.json, standard schema
  jsonAdapter({
    name: "Gemini CLI",
    detect: () => exists(geminiDir()),
    configPath: () => geminiSettingsFile(),
  }),

  // 13. opencode — JSON at ~/.config/opencode/opencode.json(c), `mcp` key
  opencodeAdapter(),
];

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
  opts: {
    /**
     * Restrict the write to these adapter names. `mh bootstrap` passes
     * the clients whose entry is missing or stale, so a client that is
     * already correct is not rewritten (and reported as "wired") on
     * every run just because a paste-snippet client sits beside it.
     */
    only?: string[];
  } = {},
): ClientWriteResult[] {
  const detected = CLIENT_ADAPTERS.filter((a) => a.detect());
  let targets = detected.length > 0 ? detected : [CLIENT_ADAPTERS[0]!];
  if (opts.only) {
    const wanted = new Set(opts.only);
    targets = targets.filter((a) => wanted.has(a.name));
  }
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
