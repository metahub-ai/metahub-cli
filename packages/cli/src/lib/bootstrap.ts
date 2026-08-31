/**
 * MetaHub MCP auto-install (Phase C).
 *
 * When `@metahub/cli` is installed (globally via `npm install -g`,
 * or via the shell installer at registry.metahub.ai/install.sh),
 * npm pulls `@metahub/mcp-server` along with it. The bundled MCP
 * server speaks the Model Context Protocol over stdio and exposes
 * `metahub_search`, `metahub_install`, `metahub_show`, etc. — so the
 * AI client itself can browse and install MetaHub artifacts via
 * natural language.
 *
 * This module owns:
 *   - findMetahubMcpBin()  : resolve the bundled bin path on disk
 *   - bootstrapMetahubMcp(): wire `metahub` into every detected
 *                            MCP-capable JSON client (idempotent —
 *                            re-runs skip clients that already have
 *                            the entry pointing at the same bin)
 *   - bootstrapStatus()    : per-client "wired / not wired" report
 *   - unbootstrap()        : remove `metahub` from every client
 *
 * No new shape on disk. We reuse:
 *   - `wireMcpAcrossClients` from @metahub/installer (same path
 *     skill/MCP installs use)
 *   - The wiring ledger at `~/.metahub/wirings.json` is NOT touched.
 *     The MetaHub MCP isn't a per-user-installed artifact — it's
 *     CLI infrastructure. We detect "already wired" by inspecting
 *     each client's JSON config for the `metahub` key, not by ledger.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAuthConfig } from "@metahub/auth";
import {
  CLIENT_ADAPTERS,
  unwireMcpAcrossClients,
  wireMcpAcrossClients,
  type ClientWriteResult,
} from "@metahub/installer";

const SLUG = "metahub";

/**
 * Resolve the bundled MCP server's bin script at runtime.
 *
 * Tries (in order):
 *   1. `require.resolve('@metahub/cli/bin/metahub-mcp.js')` — the
 *      STANDALONE-bundle layout where the MCP entry ships INSIDE
 *      the @metahub/cli package itself. This is what the install.sh
 *      tarball and the npm-published package both produce.
 *   2. `require.resolve('@metahub/mcp-server/bin/metahub-mcp.js')` —
 *      the legacy split-package layout where @metahub/mcp-server is
 *      a separate node_modules sibling. Still works for dev installs
 *      that haven't run `pnpm bundle`.
 *   3. Sibling-folder traversal — handles the workspace dev case
 *      where the CLI is invoked from its own `dist/` while the
 *      mcp-server sits at `packages/mcp-server/` next door.
 *
 * Throws when none resolve. The CLI should treat this as a
 * non-fatal warning (bootstrap is a convenience, not a requirement
 * for the install/uninstall flow).
 */
export function findMetahubMcpBin(): string {
  const r = createRequire(import.meta.url);
  // Path 1: bundled-into-@metahub/cli (the standalone shape).
  try {
    const p = r.resolve("@metahub/cli/bin/metahub-mcp.js");
    if (fs.existsSync(p)) return p;
  } catch {
    /* fall through */
  }
  // Path 2: legacy separate package (only present in dev installs
  // that didn't go through the standalone bundler).
  try {
    const p = r.resolve("@metahub/mcp-server/bin/metahub-mcp.js");
    if (fs.existsSync(p)) return p;
  } catch {
    /* fall through */
  }
  // Path 3: dev / monorepo fallback. Walk up from this file.
  let cur = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(cur, "..", "mcp-server", "bin", "metahub-mcp.js");
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved)) return resolved;
    const up = path.resolve(cur, "..");
    if (up === cur) break;
    cur = up;
  }
  throw new Error(
    "Could not locate the MetaHub MCP server. Reinstall the CLI with " +
      "`curl -fsSL https://metahub.ai/install.sh | sh`.",
  );
}

/**
 * Inspect each MCP-capable client's config and report whether the
 * `metahub` entry is already present pointing at the bundled bin.
 *
 * This is what powers `mh bootstrap --status` and the
 * "skip — already wired" short-circuit in bootstrapMetahubMcp().
 *
 * For non-JSON clients (Continue YAML, Codex TOML, Cline UI), we
 * can't reliably detect presence — we treat those as "manual" and
 * always re-emit the paste snippet.
 */
export interface ClientBootstrapStatus {
  client: string;
  configPath: string;
  state: "wired" | "wired-elsewhere" | "absent" | "not-detected" | "manual";
  /** When state === "wired-elsewhere", the path the existing entry points at. */
  existingArgs?: string[];
}

export function bootstrapStatus(bin: string): ClientBootstrapStatus[] {
  const out: ClientBootstrapStatus[] = [];
  for (const adapter of CLIENT_ADAPTERS) {
    if (!adapter.detect()) {
      out.push({
        client: adapter.name,
        configPath: adapter.configPath(),
        state: "not-detected",
      });
      continue;
    }
    const cfgPath = adapter.configPath();
    if (!/\.jsonc?$/.test(cfgPath) || !fs.existsSync(cfgPath)) {
      out.push({
        client: adapter.name,
        configPath: cfgPath,
        state: cfgPath.endsWith(".json") || cfgPath.endsWith(".jsonc")
          ? "absent"
          : "manual",
      });
      continue;
    }
    try {
      const raw = fs.readFileSync(cfgPath, "utf8");
      const cfg = JSON.parse(raw) as Record<string, unknown>;
      // Claude-style clients use `mcpServers`; Continue uses `servers`;
      // Codex uses `context_servers`; opencode uses `mcp`.
      const key = (["mcpServers", "servers", "context_servers", "mcp"] as const).find(
        (k) => k in cfg,
      );
      if (!key) {
        out.push({ client: adapter.name, configPath: cfgPath, state: "absent" });
        continue;
      }
      const entry = (cfg[key] as Record<string, unknown>)[SLUG] as
        | { command?: string | string[]; args?: string[] }
        | undefined;
      if (!entry) {
        out.push({ client: adapter.name, configPath: cfgPath, state: "absent" });
        continue;
      }
      // opencode stores the launch as `command: [bin, ...]` under `mcp`;
      // everyone else stores `args: [bin]` under mcpServers/servers/etc.
      const argMatch =
        key === "mcp"
          ? Array.isArray(entry.command) && entry.command[entry.command.length - 1] === bin
          : entry.args?.[0] === bin;
      out.push({
        client: adapter.name,
        configPath: cfgPath,
        state: argMatch ? "wired" : "wired-elsewhere",
        existingArgs: key === "mcp" && Array.isArray(entry.command)
          ? (entry.command as string[])
          : entry.args,
      });
    } catch {
      out.push({ client: adapter.name, configPath: cfgPath, state: "absent" });
    }
  }
  return out;
}

/**
 * Wire the MetaHub MCP into every detected client. Returns one
 * result per client we touched (or attempted).
 *
 * Idempotent by default — if `force` is false (the default) and the
 * client already has a `metahub` entry pointing at this exact bin,
 * we skip the write. Passing `force=true` overwrites the entry
 * (useful after a CLI upgrade where the bundled bin path changed).
 */
export interface BootstrapResult {
  bin: string;
  results: ClientWriteResult[];
  /** Friendly per-client status, including skipped clients. */
  status: ClientBootstrapStatus[];
}

export function bootstrapMetahubMcp(opts: { force?: boolean } = {}): BootstrapResult {
  const bin = findMetahubMcpBin();
  const before = bootstrapStatus(bin);
  const cfg = loadAuthConfig();

  // Filter to clients that need (re-)wiring. We always re-emit for
  // manual clients (YAML/TOML/UI) so the user sees the paste snippet
  // when they run `mh bootstrap`.
  const needWire = before.filter((s) => {
    if (s.state === "not-detected") return false;
    if (s.state === "wired" && !opts.force) return false;
    return true;
  });
  if (needWire.length === 0) {
    return { bin, results: [], status: before };
  }

  // The MetaHub MCP is CLI infrastructure, not a per-user install —
  // it doesn't need install-attribution env vars. We pass empty
  // strings for those to satisfy the McpEnv shape; the MCP server
  // itself never reads them (it uses the user's session token from
  // ~/.metahub/config.json to talk to the portal).
  //
  // METAHUB_REGISTRY_URL is forwarded explicitly. The portal endpoint
  // is the live public catalog; registry.metahub.ai/registry.json
  // returns 404 today so the MCP server needs to be pointed at the
  // portal URL until the static registry is rebuilt. We honor the
  // user's auth-config override when set so self-hosters don't get
  // overridden by the default.
  const env = {
    METAHUB_INGEST_API_KEY: "",
    METAHUB_INSTALL_ID: "",
    METAHUB_ARTIFACT_ID: "",
    METAHUB_PORTAL_URL: cfg.portalUrl,
    METAHUB_REGISTRY_URL: cfg.registryUrl || "https://developer.metahub.ai/api/public/artifacts",
  };
  const launch = { command: "node", args: [bin] };

  // The `wireMcpAcrossClients` helper writes to EVERY detected
  // client. We let it do its thing and then map the result back.
  const results = wireMcpAcrossClients(SLUG, launch, env);
  return { bin, results, status: before };
}

/** Remove the MetaHub MCP entry from every client. Idempotent. */
export function unbootstrap(): void {
  unwireMcpAcrossClients(SLUG);
}
