/**
 * MetaHub MCP auto-install (Phase C).
 *
 * When `@metahub-ai/mh` is installed (globally via `npm install -g`,
 * via `npx`, or via the shell installer at metahub.ai/install.sh),
 * the standalone package includes the MetaHub MCP server. It speaks
 * the Model Context Protocol over stdio and exposes
 * `metahub_search`, `metahub_install`, `metahub_get`, etc. — so the
 * AI client itself can browse and install MetaHub artifacts via
 * natural language.
 *
 * This module owns:
 *   - findMetahubMcpBin()  : resolve the bundled bin path on disk
 *   - launchSpecFor()      : the command clients should run for it
 *   - bootstrapMetahubMcp(): wire `metahub` into every detected
 *                            MCP-capable client (idempotent — re-runs
 *                            skip clients that already have the entry
 *                            pointing at the same launch), and write
 *                            the MetaHub guidance block into each
 *                            harness's global instruction file
 *   - bootstrapStatus()    : per-client "wired / not wired" report
 *   - unbootstrap()        : remove `metahub` and the guidance block
 *                            from every client
 *
 * No new shape on disk. We reuse:
 *   - `wireMcpAcrossClients` from @metahub/installer (same path
 *     skill/MCP installs use)
 *   - The wiring ledger at `~/.metahub/wirings.json` is NOT touched.
 *     The MetaHub MCP isn't a per-user-installed artifact — it's
 *     CLI infrastructure. We detect "already wired" by inspecting
 *     each client's config for the `metahub` key, not by ledger.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { explicitRegistryUrl, loadAuthConfig } from "@metahub/auth";
import {
  CLIENT_ADAPTERS,
  codexBinary,
  readJsonConfig,
  unwireMcpAcrossClients,
  wireMcpAcrossClients,
  type ClientWriteResult,
  type LaunchSpec,
  type McpEnv,
} from "@metahub/installer";
import {
  removeInstructionBlocks,
  writeInstructionBlocks,
  type InstructionRemoveResult,
  type InstructionWriteResult,
} from "./instructions.js";

const SLUG = "metahub";

/** The npm package the `npx` launch form pulls the server from. */
export const NPX_PACKAGE = "@metahub-ai/mh";

/**
 * Resolve the bundled MCP server's bin script at runtime.
 *
 * Tries (in order):
 *   1. `require.resolve('@metahub-ai/mh/bin/metahub-mcp.js')` — the
 *      STANDALONE-bundle layout where the MCP entry ships INSIDE
 *      the @metahub-ai/mh package itself. This is what the install.sh
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
  // Path 1: bundled-into-@metahub-ai/mh (the standalone shape).
  try {
    const p = r.resolve("@metahub-ai/mh/bin/metahub-mcp.js");
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
      "`npm install -g @metahub-ai/mh` or `curl -fsSL https://metahub.ai/install.sh | sh`.",
  );
}

/**
 * True when `bin` lives inside npm's npx cache (`~/.npm/_npx/<hash>/…`).
 * That directory is evicted whenever npm feels like it, so a client
 * config pointing into it stops working without warning.
 */
export function isNpxCachePath(bin: string): boolean {
  return bin.split(path.sep).join("/").includes("/_npx/");
}

/**
 * The command clients should run to start the server.
 *
 * A global install gets the absolute bin path (instant start, no
 * network). An `npx @metahub-ai/mh bootstrap` run instead gets the
 * cache-independent `npx -y --package=@metahub-ai/mh metahub-mcp`
 * form, which resolves the package on every start.
 */
export function launchSpecFor(bin: string): LaunchSpec {
  if (isNpxCachePath(bin)) {
    return { command: "npx", args: ["-y", `--package=${NPX_PACKAGE}`, "metahub-mcp"] };
  }
  return { command: "node", args: [bin] };
}

/**
 * Inspect each MCP-capable client's config and report whether the
 * `metahub` entry is already present pointing at the bundled bin.
 *
 * This is what powers `mh bootstrap --status` and the
 * "skip — already wired" short-circuit in bootstrapMetahubMcp().
 *
 * For non-JSON clients (Continue YAML, Cline UI, Goose YAML), we
 * can't reliably detect presence — we treat those as "manual" and
 * always re-emit the paste snippet. Codex's TOML is checked with a
 * plain text scan, which is enough to tell "present" from "absent".
 */
export interface ClientBootstrapStatus {
  client: string;
  configPath: string;
  state: "wired" | "wired-elsewhere" | "absent" | "not-detected" | "manual";
  /** When state === "wired-elsewhere", the launch the existing entry uses. */
  existingArgs?: string[];
}

function sameArgs(a: string[] | undefined, b: string[]): boolean {
  return Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);
}

const JSON_KEYS = ["mcpServers", "servers", "context_servers", "mcp"] as const;

function jsonEntryState(
  cfgPath: string,
  launch: LaunchSpec,
): { state: "absent" | "wired" | "wired-elsewhere"; existingArgs?: string[] } {
  const read = readJsonConfig(cfgPath);
  if (read.state !== "ok") return { state: "absent" };
  const key = JSON_KEYS.find((k) => k in read.data);
  const entry = key
    ? ((read.data[key] as Record<string, unknown>)[SLUG] as
        { command?: string | string[]; args?: string[] } | undefined)
    : undefined;
  if (!entry) return { state: "absent" };
  // opencode spells the launch as one `command` array; everyone else
  // splits it into `command` + `args`.
  const existing = Array.isArray(entry.command)
    ? entry.command
    : [entry.command ?? "", ...(entry.args ?? [])];
  const wanted = [launch.command, ...launch.args];
  return {
    state: sameArgs(existing, wanted) ? "wired" : "wired-elsewhere",
    existingArgs: Array.isArray(entry.command) ? entry.command.slice(1) : (entry.args ?? []),
  };
}

/** Rows keep `existingArgs` whenever an entry was found, wired or not. */

function tomlEntryState(
  cfgPath: string,
  launch: LaunchSpec,
): "absent" | "wired" | "wired-elsewhere" | "manual" {
  let text: string;
  try {
    text = fs.readFileSync(cfgPath, "utf8");
  } catch {
    return codexBinary() ? "absent" : "manual";
  }
  // Collect the lines of the `[mcp_servers.metahub]` table: from its
  // header up to the next table header or the end of the file.
  const lines = text.split(/\r?\n/);
  const header = lines.findIndex((l) => l.trim() === "[mcp_servers.metahub]");
  if (header === -1) return codexBinary() ? "absent" : "manual";
  const section: string[] = [];
  for (const line of lines.slice(header + 1)) {
    if (/^\s*\[/.test(line) && !line.trim().startsWith("[mcp_servers.metahub.")) break;
    section.push(line);
  }
  const marker = launch.command === "npx" ? NPX_PACKAGE : launch.args[0]!;
  return section.join("\n").includes(marker) ? "wired" : "wired-elsewhere";
}

export function bootstrapStatus(bin: string): ClientBootstrapStatus[] {
  const launch = launchSpecFor(bin);
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
    if (cfgPath.endsWith(".json") || cfgPath.endsWith(".jsonc")) {
      if (!fs.existsSync(cfgPath)) {
        out.push({ client: adapter.name, configPath: cfgPath, state: "absent" });
        continue;
      }
      const probe = jsonEntryState(cfgPath, launch);
      out.push({
        client: adapter.name,
        configPath: cfgPath,
        state: probe.state,
        ...(probe.existingArgs ? { existingArgs: probe.existingArgs } : {}),
      });
      continue;
    }
    if (cfgPath.endsWith(".toml")) {
      out.push({
        client: adapter.name,
        configPath: cfgPath,
        state: tomlEntryState(cfgPath, launch),
      });
      continue;
    }
    out.push({ client: adapter.name, configPath: cfgPath, state: "manual" });
  }
  return out;
}

/**
 * Wire the MetaHub MCP into every detected client and write the
 * guidance block into every detected harness's instruction file.
 *
 * Idempotent by default — if `force` is false (the default) and the
 * client already has a `metahub` entry pointing at this exact launch,
 * we skip the write. Passing `force=true` overwrites the entry
 * (useful after a CLI upgrade where the bundled bin path changed).
 *
 * The instruction blocks are written unless `instructions` is false or
 * `METAHUB_NO_INSTRUCTIONS=1` is set. They are marker-fenced and
 * idempotent on their own, so no `force` is needed for them.
 */
export interface BootstrapResult {
  bin: string;
  /** What every wired client was told to run. */
  launch: LaunchSpec;
  results: ClientWriteResult[];
  /** Friendly per-client status, including skipped clients. */
  status: ClientBootstrapStatus[];
  /** Per-instruction-file outcome; empty when instructions were skipped. */
  instructions: InstructionWriteResult[];
}

export function instructionsEnabledByEnv(): boolean {
  return process.env.METAHUB_NO_INSTRUCTIONS !== "1";
}

export function bootstrapMetahubMcp(
  opts: { force?: boolean; instructions?: boolean } = {},
): BootstrapResult {
  const bin = findMetahubMcpBin();
  const launch = launchSpecFor(bin);
  const before = bootstrapStatus(bin);
  const cfg = loadAuthConfig();

  // Filter to clients that need (re-)wiring. We always re-emit for
  // manual clients (YAML/UI) so the user sees the paste snippet
  // when they run `mh bootstrap`.
  const needWire = before.filter((s) => {
    if (s.state === "not-detected") return false;
    if (s.state === "wired" && !opts.force) return false;
    return true;
  });

  let results: ClientWriteResult[] = [];
  if (needWire.length > 0) {
    // The MetaHub MCP is CLI infrastructure, not a per-user install —
    // it doesn't need install-attribution env vars. We pass empty
    // strings for those to satisfy the McpEnv shape; the MCP server
    // itself never reads them (it uses the user's session token from
    // ~/.metahub/config.json to talk to the portal).
    //
    // METAHUB_REGISTRY_URL is forwarded ONLY when the user actually chose
    // one. It used to be `cfg.registryUrl || <portal fallback>`, but
    // `loadAuthConfig()` always fills `registryUrl` in, so the `||` branch
    // was dead and every wired client got `https://registry.metahub.ai`
    // baked in — a website root that serves HTML, not a catalog. The MCP
    // server now reads the portal's public catalog API by default and
    // treats this var as an opt-in self-host override, so emitting the
    // default actively breaks it. Omit it unless it is a real override.
    const env: McpEnv = {
      METAHUB_INGEST_API_KEY: "",
      METAHUB_INSTALL_ID: "",
      METAHUB_ARTIFACT_ID: "",
      METAHUB_PORTAL_URL: cfg.portalUrl,
    };
    const chosenRegistry = explicitRegistryUrl();
    if (chosenRegistry) env.METAHUB_REGISTRY_URL = chosenRegistry;

    // The `wireMcpAcrossClients` helper writes to EVERY detected
    // client. We let it do its thing and then map the result back.
    results = wireMcpAcrossClients(SLUG, launch, env, {
      only: needWire.map((s) => s.client),
    });
  }

  const wantInstructions = opts.instructions ?? instructionsEnabledByEnv();
  const instructions = wantInstructions ? writeInstructionBlocks() : [];
  return { bin, launch, results, status: before, instructions };
}

/**
 * Remove the MetaHub MCP entry and the guidance block from every
 * client. Idempotent.
 */
export function unbootstrap(): InstructionRemoveResult[] {
  unwireMcpAcrossClients(SLUG);
  return removeInstructionBlocks();
}
