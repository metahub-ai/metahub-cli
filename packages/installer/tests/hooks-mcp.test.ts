/**
 * Deterministic coverage for the MCP branch of wireHook + the
 * resolveMcpLaunch helper + clientIdFromName mapping.
 *
 * clients.js is mocked so wireMcpAcrossClients returns a controlled
 * set of results regardless of which AI clients are actually on the
 * host. That isolates these tests from the platform-dependent
 * filesystem detection in clients.ts (which is exercised separately,
 * and only behaves on Linux CI).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mcpResults: Array<{ client: string; status: string; configPath: string }> = [];
let lastWireArgs: { slug?: string; launch?: unknown; env?: Record<string, string> } = {};

vi.mock("../src/clients.js", () => ({
  wireMcpAcrossClients: (slug: string, launch: unknown, env: Record<string, string>) => {
    lastWireArgs = { slug, launch, env };
    return mcpResults;
  },
  unwireMcpAcrossClients: () => {},
}));

const STATE_KEYS = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "METAHUB_E2E_HOME"] as const;
const saved: Record<string, string | undefined> = {};
let tmp: string;
let origCwd: () => string;

beforeEach(() => {
  for (const k of STATE_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-installer-hooksmcp-"));
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.XDG_CONFIG_HOME = path.join(tmp, ".config");
  process.env.METAHUB_E2E_HOME = tmp;
  origCwd = process.cwd;
  process.cwd = () => tmp;
  mcpResults.length = 0;
  lastWireArgs = {};
});

afterEach(() => {
  process.cwd = origCwd;
  for (const k of STATE_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const baseInput = {
  ingestApiKey: "mhi_abc",
  installId: "ins_x",
  artifactId: "art_x",
  portalUrl: "http://portal.test",
};

/** Drop an MCP server install dir with the given files under the canonical mcp path. */
function writeMcpServer(slug: string, files: Record<string, string>): string {
  const dir = path.join(tmp, ".metahub", "mcp", slug);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(dir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  return dir;
}

describe("wireHook (mcp) launch resolution + env forwarding", () => {
  it("resolves bin (string) and forwards the ingest env to wireMcpAcrossClients", async () => {
    writeMcpServer("srv-bin", {
      "package.json": JSON.stringify({ bin: "dist/cli.js" }),
      "dist/cli.js": "#!/usr/bin/env node",
    });
    mcpResults.push({
      client: "Claude Code",
      status: "wrote",
      configPath: path.join(tmp, ".claude", "settings.json"),
    });
    const { wireHook } = await import("../src/hooks");
    const res = wireHook({ kind: "mcp", slug: "srv-bin", ...baseInput });
    expect(res.warning).toBeUndefined();
    expect(res.clients).toBe(mcpResults);
    // launch should be node + the bin file under the install dir.
    expect(lastWireArgs.launch).toMatchObject({ command: "node" });
    expect((lastWireArgs.launch as { args: string[] }).args[0]).toContain("dist");
    // env carries the four ingest vars.
    expect(lastWireArgs.env).toMatchObject({
      METAHUB_INGEST_API_KEY: "mhi_abc",
      METAHUB_INSTALL_ID: "ins_x",
      METAHUB_ARTIFACT_ID: "art_x",
      METAHUB_PORTAL_URL: "http://portal.test",
    });
  });

  it("records a wiring entry per 'wrote' client (clientIdFromName mapping)", async () => {
    writeMcpServer("srv-map", {
      "package.json": JSON.stringify({ main: "lib/index.js" }),
      "lib/index.js": "",
    });
    mcpResults.push(
      { client: "Claude Code", status: "wrote", configPath: path.join(tmp, "a.json") },
      { client: "Cursor", status: "wrote", configPath: path.join(tmp, "b.json") },
      { client: "Zed", status: "manual", configPath: path.join(tmp, "c.json") },
    );
    const { wireHook } = await import("../src/hooks");
    wireHook({ kind: "mcp", slug: "srv-map", ...baseInput });

    const { findWiring } = await import("../src/wirings");
    const set = findWiring("mcp", "srv-map");
    expect(set).not.toBeNull();
    // Only the two "wrote" results are recorded; the "manual" one is filtered.
    const clients = set!.wirings.map((w) => w.client).sort();
    expect(clients).toEqual(["claude-code", "cursor"]);
    expect(set!.wirings.every((w) => w.strategy === "mcp-json")).toBe(true);
  });

  it("maps every known ClientAdapter name to its ClientId", async () => {
    writeMcpServer("srv-allnames", {
      "package.json": JSON.stringify({ main: "i.js" }),
      "i.js": "",
    });
    const names: Array<[string, string]> = [
      ["Claude Code", "claude-code"],
      ["Claude Desktop", "claude-desktop"],
      ["Cursor", "cursor"],
      ["Antigravity", "antigravity"],
      ["VS Code", "vs-code"],
      ["Zed", "zed"],
      ["Windsurf", "windsurf"],
      ["Continue", "continue"],
      ["Cline", "cline"],
      ["Goose", "goose"],
      ["Codex CLI", "codex-cli"],
      ["Totally Unknown Client", "Totally Unknown Client"], // default arm
    ];
    for (const [name] of names) {
      mcpResults.push({
        client: name,
        status: "wrote",
        configPath: path.join(tmp, `${name}.json`),
      });
    }
    const { wireHook } = await import("../src/hooks");
    wireHook({ kind: "mcp", slug: "srv-allnames", ...baseInput });
    const { findWiring } = await import("../src/wirings");
    const recorded = findWiring("mcp", "srv-allnames")!.wirings.map((w) => w.client);
    for (const [, id] of names) {
      expect(recorded).toContain(id);
    }
  });

  it("resolves scripts.start when bin + main are absent", async () => {
    writeMcpServer("srv-start", {
      "package.json": JSON.stringify({ scripts: { start: "node out.js" } }),
    });
    const { wireHook } = await import("../src/hooks");
    const res = wireHook({ kind: "mcp", slug: "srv-start", ...baseInput });
    expect(res.warning).toBeUndefined();
    expect(lastWireArgs.launch).toMatchObject({ command: "npm" });
  });

  it("resolves bin given as an object map (first value)", async () => {
    writeMcpServer("srv-binobj", {
      "package.json": JSON.stringify({ bin: { mh: "dist/cli.js", other: "x.js" } }),
      "dist/cli.js": "",
    });
    const { wireHook } = await import("../src/hooks");
    const res = wireHook({ kind: "mcp", slug: "srv-binobj", ...baseInput });
    expect(res.warning).toBeUndefined();
    expect((lastWireArgs.launch as { args: string[] }).args[0]).toContain("cli.js");
  });

  it("falls back to a conventional entry file when package.json is absent", async () => {
    writeMcpServer("srv-conv", {
      "dist/server.js": "",
    });
    const { wireHook } = await import("../src/hooks");
    const res = wireHook({ kind: "mcp", slug: "srv-conv", ...baseInput });
    expect(res.warning).toBeUndefined();
    expect((lastWireArgs.launch as { args: string[] }).args[0]).toContain("server.js");
  });

  it("tolerates a malformed package.json (JSON.parse throws → falls through)", async () => {
    writeMcpServer("srv-badjson", {
      "package.json": "{ not valid json ",
      "index.js": "",
    });
    const { wireHook } = await import("../src/hooks");
    const res = wireHook({ kind: "mcp", slug: "srv-badjson", ...baseInput });
    // package.json unparseable → falls to conventional "index.js".
    expect(res.warning).toBeUndefined();
    expect((lastWireArgs.launch as { args: string[] }).args[0]).toContain("index.js");
  });

  it("emits a warning when no launch can be resolved", async () => {
    writeMcpServer("srv-none", {
      "README.md": "no entry point",
    });
    const { wireHook } = await import("../src/hooks");
    const res = wireHook({ kind: "mcp", slug: "srv-none", ...baseInput });
    expect(res.warning).toMatch(/Couldn't infer how to launch/);
    expect(res.clients).toEqual([]);
    expect(res.skillMirrors).toEqual([]);
  });
});
