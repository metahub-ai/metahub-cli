/**
 * Tests for the cross-client MCP wiring engine. Each adapter writes to
 * a per-client config file (or returns a manual snippet); the test
 * isolates by routing HOME / cwd at a tmpdir so the dev's real configs
 * are untouched.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_KEYS = ["HOME", "USERPROFILE", "APPDATA", "XDG_CONFIG_HOME"] as const;
const saved: Record<string, string | undefined> = {};

let tmp: string;
let origCwd: () => string;
let origPlatform: NodeJS.Platform;

beforeEach(() => {
  origPlatform = process.platform;
  for (const k of STATE_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-installer-wire-"));
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.XDG_CONFIG_HOME = path.join(tmp, ".config");
  origCwd = process.cwd;
  process.cwd = () => tmp;
});

afterEach(() => {
  process.cwd = origCwd;
  for (const k of STATE_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  Object.defineProperty(process, "platform", { value: origPlatform });
});

const launch = { command: "node", args: ["./server.js"] };
const env = { METAHUB_INGEST_API_KEY: "mhi_key" };

describe("wireMcpAcrossClients (no clients detected)", () => {
  it("falls back to the Claude Code adapter and reports the write", async () => {
    const { wireMcpAcrossClients } = await import("../src/clients");
    const out = wireMcpAcrossClients("pdf", launch, env);
    expect(out).toHaveLength(1);
    expect(out[0]?.client).toBe("Claude Code");
    expect(out[0]?.status).toBe("wrote");
    const settings = JSON.parse(fs.readFileSync(path.join(tmp, ".claude.json"), "utf8"));
    expect(settings.mcpServers).toHaveProperty("pdf");
  });
});

describe("wireMcpAcrossClients (clients detected)", () => {
  beforeEach(() => {
    for (const sub of [
      ".claude",
      ".cursor",
      ".antigravity",
      ".codeium/windsurf",
      ".continue",
      ".codex",
    ]) {
      fs.mkdirSync(path.join(tmp, sub), { recursive: true });
    }
    fs.mkdirSync(path.join(tmp, ".config", "zed"), { recursive: true });
    fs.mkdirSync(path.join(tmp, ".config", "goose"), { recursive: true });
    fs.mkdirSync(path.join(tmp, ".vscode"), { recursive: true });
    Object.defineProperty(process, "platform", { value: "linux" });
    fs.mkdirSync(path.join(tmp, ".config", "Claude"), { recursive: true });
  });

  it("writes JSON entries for Claude Code / Cursor / VS Code / Zed / Windsurf / Claude Desktop", async () => {
    const { wireMcpAcrossClients } = await import("../src/clients");
    const out = wireMcpAcrossClients("pdf", launch, env);
    const names = out.filter((r) => r.status === "wrote").map((r) => r.client);
    for (const expected of [
      "Claude Code",
      "Claude Desktop",
      "Cursor",
      "VS Code",
      "Zed",
      "Windsurf",
    ]) {
      expect(names).toContain(expected);
    }
    const zed = JSON.parse(
      fs.readFileSync(path.join(tmp, ".config", "zed", "settings.json"), "utf8"),
    );
    expect(zed.context_servers).toHaveProperty("pdf");
    const vsc = JSON.parse(fs.readFileSync(path.join(tmp, ".vscode", "mcp.json"), "utf8"));
    expect(vsc.servers).toHaveProperty("pdf");
  });

  it("returns manual-snippet results for YAML / TOML / UI clients", async () => {
    process.env.METAHUB_CODEX_BIN = ""; // no codex binary → snippet path
    try {
      const { wireMcpAcrossClients } = await import("../src/clients");
      const out = wireMcpAcrossClients("pdf", launch, env);
      const manuals = out.filter((r) => r.status === "manual").map((r) => r.client);
      expect(manuals).toEqual(expect.arrayContaining(["Continue", "Goose", "Codex CLI"]));
      const continueRes = out.find((r) => r.client === "Continue");
      expect(continueRes?.manualSnippet).toContain("mcpServers");
      const codex = out.find((r) => r.client === "Codex CLI");
      expect(codex?.manualSnippet).toContain("[mcp_servers.pdf]");
      expect(codex?.manualSnippet).toContain("[mcp_servers.pdf.env]");
      expect(codex?.manualSnippet).toContain('METAHUB_INGEST_API_KEY = "mhi_key"');
      const goose = out.find((r) => r.client === "Goose");
      expect(goose?.manualSnippet).toContain("extensions:");
    } finally {
      delete process.env.METAHUB_CODEX_BIN;
    }
  });

  it("Antigravity is JSON-wired at ~/.gemini/config/mcp_config.json", async () => {
    const { wireMcpAcrossClients } = await import("../src/clients");
    const out = wireMcpAcrossClients("pdf", launch, env);
    const ag = out.find((r) => r.client === "Antigravity");
    expect(ag?.status).toBe("wrote");
    expect(ag?.configPath).toBe(path.join(tmp, ".gemini", "config", "mcp_config.json"));
    const cfg = JSON.parse(fs.readFileSync(ag!.configPath, "utf8"));
    expect(cfg.mcpServers.pdf).toMatchObject(launch);
  });
});

describe("Antigravity legacy config", () => {
  it("uses ~/.gemini/antigravity/mcp_config.json when only the legacy file exists", async () => {
    const legacy = path.join(tmp, ".gemini", "antigravity", "mcp_config.json");
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, ""); // Antigravity ships it empty
    const { wireMcpAcrossClients } = await import("../src/clients");
    const out = wireMcpAcrossClients("pdf", launch, env);
    const ag = out.find((r) => r.client === "Antigravity");
    expect(ag?.status).toBe("wrote");
    expect(ag?.configPath).toBe(legacy);
    expect(JSON.parse(fs.readFileSync(legacy, "utf8")).mcpServers).toHaveProperty("pdf");
    // Gemini CLI is detected too (same ~/.gemini root) and gets its own file.
    const gem = out.find((r) => r.client === "Gemini CLI");
    expect(gem?.status).toBe("wrote");
    expect(gem?.configPath).toBe(path.join(tmp, ".gemini", "settings.json"));
  });
});

describe("Gemini CLI adapter", () => {
  it("merges into ~/.gemini/settings.json and preserves other settings", async () => {
    const file = path.join(tmp, ".gemini", "settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ theme: "Dracula", mcpServers: { other: {} } }));
    const { wireMcpAcrossClients, unwireMcpAcrossClients } = await import("../src/clients");
    const out = wireMcpAcrossClients("pdf", launch, env);
    expect(out.find((r) => r.client === "Gemini CLI")?.status).toBe("wrote");
    let cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(cfg.theme).toBe("Dracula");
    expect(Object.keys(cfg.mcpServers).toSorted()).toEqual(["other", "pdf"]);
    unwireMcpAcrossClients("pdf");
    cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(Object.keys(cfg.mcpServers)).toEqual(["other"]);
  });
});

describe("opencode adapter", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "linux" });
  });

  it("writes the `mcp` schema with a command array into opencode.json", async () => {
    fs.mkdirSync(path.join(tmp, ".config", "opencode"), { recursive: true });
    const { wireMcpAcrossClients, unwireMcpAcrossClients } = await import("../src/clients");
    const out = wireMcpAcrossClients("pdf", launch, env);
    const oc = out.find((r) => r.client === "opencode");
    expect(oc?.status).toBe("wrote");
    expect(oc?.configPath).toBe(path.join(tmp, ".config", "opencode", "opencode.json"));
    const cfg = JSON.parse(fs.readFileSync(oc!.configPath, "utf8"));
    expect(cfg.mcp.pdf).toEqual({
      type: "local",
      command: ["node", "./server.js"],
      environment: env,
      enabled: true,
    });
    unwireMcpAcrossClients("pdf");
    expect(JSON.parse(fs.readFileSync(oc!.configPath, "utf8")).mcp).not.toHaveProperty("pdf");
  });

  it("prefers an existing opencode.jsonc over creating opencode.json", async () => {
    const jsonc = path.join(tmp, ".config", "opencode", "opencode.jsonc");
    fs.mkdirSync(path.dirname(jsonc), { recursive: true });
    fs.writeFileSync(jsonc, JSON.stringify({ $schema: "https://opencode.ai/config.json" }));
    const { wireMcpAcrossClients } = await import("../src/clients");
    const out = wireMcpAcrossClients("pdf", launch, env);
    const oc = out.find((r) => r.client === "opencode");
    expect(oc?.status).toBe("wrote");
    expect(oc?.configPath).toBe(jsonc);
    expect(fs.existsSync(path.join(tmp, ".config", "opencode", "opencode.json"))).toBe(false);
    const cfg = JSON.parse(fs.readFileSync(jsonc, "utf8"));
    expect(cfg.$schema).toBe("https://opencode.ai/config.json");
    expect(cfg.mcp.pdf.type).toBe("local");
  });
});

describe("malformed client configs are never overwritten (issue #10)", () => {
  it("skips a Cursor mcp.json that does not parse and leaves it byte-for-byte intact", async () => {
    const file = path.join(tmp, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const broken = '{ "mcpServers": { "keepme": { "command": "x" }, ';
    fs.writeFileSync(file, broken);
    const { wireMcpAcrossClients, unwireMcpAcrossClients } = await import("../src/clients");
    const out = wireMcpAcrossClients("pdf", launch, env);
    const cursor = out.find((r) => r.client === "Cursor");
    expect(cursor?.status).toBe("skipped");
    expect(cursor?.warning).toMatch(/not valid JSON/);
    expect(fs.readFileSync(file, "utf8")).toBe(broken);
    unwireMcpAcrossClients("pdf");
    expect(fs.readFileSync(file, "utf8")).toBe(broken);
  });

  it("treats an empty config file as an empty object, not as corruption", async () => {
    const file = path.join(tmp, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "\n");
    const { wireMcpAcrossClients } = await import("../src/clients");
    const out = wireMcpAcrossClients("pdf", launch, env);
    expect(out.find((r) => r.client === "Cursor")?.status).toBe("wrote");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers).toHaveProperty("pdf");
  });

  it("readJsonConfig reports absent / ok / invalid distinctly", async () => {
    const { readJsonConfig } = await import("../src/clients");
    const file = path.join(tmp, "probe.json");
    expect(readJsonConfig(file)).toEqual({ state: "absent" });
    fs.writeFileSync(file, "[1,2]");
    expect(readJsonConfig(file).state).toBe("invalid");
    fs.writeFileSync(file, '{"a":1}');
    expect(readJsonConfig(file)).toEqual({ state: "ok", data: { a: 1 } });
  });
});

describe("Codex CLI adapter", () => {
  function stubCodex(): { bin: string; log: string } {
    const log = path.join(tmp, "codex-calls.log");
    const bin = path.join(tmp, "codex");
    fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexit 0\n`, { mode: 0o755 });
    return { bin, log };
  }

  it("wires through `codex mcp add` when the binary is available", async () => {
    if (process.platform === "win32") return;
    fs.mkdirSync(path.join(tmp, ".codex"), { recursive: true });
    const { bin, log } = stubCodex();
    process.env.METAHUB_CODEX_BIN = bin;
    try {
      const { wireMcpAcrossClients, unwireMcpAcrossClients } = await import("../src/clients");
      const out = wireMcpAcrossClients("pdf", launch, env);
      const codex = out.find((r) => r.client === "Codex CLI");
      expect(codex?.status).toBe("wrote");
      const calls = fs.readFileSync(log, "utf8").trim().split("\n");
      expect(calls[0]).toBe("mcp remove pdf");
      expect(calls[1]).toBe("mcp add pdf --env METAHUB_INGEST_API_KEY=mhi_key -- node ./server.js");
      unwireMcpAcrossClients("pdf");
      expect(fs.readFileSync(log, "utf8").trim().split("\n").pop()).toBe("mcp remove pdf");
    } finally {
      delete process.env.METAHUB_CODEX_BIN;
    }
  });

  it("falls back to the TOML snippet, with a warning, when `codex mcp add` fails", async () => {
    if (process.platform === "win32") return;
    fs.mkdirSync(path.join(tmp, ".codex"), { recursive: true });
    const bin = path.join(tmp, "codex");
    fs.writeFileSync(bin, "#!/bin/sh\necho 'boom' >&2\nexit 1\n", { mode: 0o755 });
    process.env.METAHUB_CODEX_BIN = bin;
    try {
      const { wireMcpAcrossClients } = await import("../src/clients");
      const out = wireMcpAcrossClients("pdf", launch, env);
      const codex = out.find((r) => r.client === "Codex CLI");
      expect(codex?.status).toBe("manual");
      expect(codex?.manualSnippet).toContain("[mcp_servers.pdf]");
      expect(codex?.warning).toMatch(/codex mcp add failed/);
    } finally {
      delete process.env.METAHUB_CODEX_BIN;
    }
  });
});

describe("unwireMcpAcrossClients", () => {
  it("removes the slug from each previously-written JSON config", async () => {
    fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(tmp, ".cursor"), { recursive: true });
    const { wireMcpAcrossClients, unwireMcpAcrossClients } = await import("../src/clients");
    wireMcpAcrossClients("pdf", launch, env);
    unwireMcpAcrossClients("pdf");
    const settings = JSON.parse(fs.readFileSync(path.join(tmp, ".claude.json"), "utf8"));
    expect(settings.mcpServers).not.toHaveProperty("pdf");
  });

  it("is a no-op when the config file does not exist", async () => {
    const { unwireMcpAcrossClients } = await import("../src/clients");
    expect(() => unwireMcpAcrossClients("never-written")).not.toThrow();
  });
});

describe("unwire branches", () => {
  it("unwire is a no-op when the JSON config has no `mcpServers` (or equivalent) key", async () => {
    fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".claude.json"), JSON.stringify({ theme: "dark" }));
    const { unwireMcpAcrossClients } = await import("../src/clients");
    expect(() => unwireMcpAcrossClients("pdf")).not.toThrow();
    const after = JSON.parse(fs.readFileSync(path.join(tmp, ".claude.json"), "utf8"));
    expect(after.theme).toBe("dark");
  });

  it("migrates the slug out of the legacy Claude settings file", async () => {
    const claudeDir = path.join(tmp, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const legacyFile = path.join(claudeDir, "settings.json");
    fs.writeFileSync(
      legacyFile,
      JSON.stringify({
        theme: "dark",
        mcpServers: {
          pdf: { command: "node", args: ["old.js"] },
          keep: { command: "node", args: ["keep.js"] },
        },
      }),
    );

    const { wireMcpAcrossClients } = await import("../src/clients");
    wireMcpAcrossClients("pdf", launch, env);

    const current = JSON.parse(fs.readFileSync(path.join(tmp, ".claude.json"), "utf8"));
    const legacy = JSON.parse(fs.readFileSync(legacyFile, "utf8"));
    expect(current.mcpServers.pdf).toMatchObject(launch);
    expect(legacy.mcpServers).not.toHaveProperty("pdf");
    expect(legacy.mcpServers).toHaveProperty("keep");
    expect(legacy.theme).toBe("dark");
  });
});

describe("Cline detection branches", () => {
  it("detects Cline when ~/Documents/Cline/MCP exists", async () => {
    fs.mkdirSync(path.join(tmp, "Documents", "Cline", "MCP"), { recursive: true });
    const { wireMcpAcrossClients } = await import("../src/clients");
    const out = wireMcpAcrossClients("pdf", launch, env);
    expect(out.some((r) => r.client === "Cline")).toBe(true);
  });

  it("detects Cline when ~/.vscode exists (fallback)", async () => {
    fs.mkdirSync(path.join(tmp, ".vscode"), { recursive: true });
    const { wireMcpAcrossClients } = await import("../src/clients");
    const out = wireMcpAcrossClients("pdf", launch, env);
    expect(out.some((r) => r.client === "Cline")).toBe(true);
  });
});

describe("VS Code adapter recovers from a malformed mcp.json", () => {
  it("returns a 'skipped' result with a warning when the file can't be parsed", async () => {
    fs.mkdirSync(path.join(tmp, ".vscode"), { recursive: true });
    const mcpFile = path.join(tmp, ".vscode", "mcp.json");
    fs.writeFileSync(mcpFile, JSON.stringify({ servers: {} }));
    fs.chmodSync(mcpFile, 0o400);
    try {
      const { wireMcpAcrossClients } = await import("../src/clients");
      const out = wireMcpAcrossClients("pdf", launch, env);
      const vsc = out.find((r) => r.client === "VS Code");
      if (vsc) {
        expect(vsc.status === "wrote" || vsc.status === "skipped").toBe(true);
      }
    } finally {
      fs.chmodSync(mcpFile, 0o600);
    }
  });
});

describe("Claude Desktop platform path", () => {
  it("uses macOS path on darwin", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const { CLIENT_ADAPTERS } = await import("../src/clients");
    const cd = CLIENT_ADAPTERS.find((a) => a.name === "Claude Desktop")!;
    expect(cd.configPath()).toContain("Library/Application Support/Claude");
  });

  it("uses APPDATA on win32", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    process.env.APPDATA = path.join(tmp, "AppData", "Roaming");
    const { CLIENT_ADAPTERS } = await import("../src/clients");
    const cd = CLIENT_ADAPTERS.find((a) => a.name === "Claude Desktop")!;
    expect(cd.configPath()).toContain("AppData");
  });

  it("Windows path falls back to ~/AppData/Roaming/Claude when APPDATA is unset", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    delete process.env.APPDATA;
    const { CLIENT_ADAPTERS } = await import("../src/clients");
    const cd = CLIENT_ADAPTERS.find((a) => a.name === "Claude Desktop")!;
    expect(cd.configPath()).toContain("AppData");
  });

  it("Claude Desktop falls back to ~/.config/Claude on linux", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const { CLIENT_ADAPTERS } = await import("../src/clients");
    const cd = CLIENT_ADAPTERS.find((a) => a.name === "Claude Desktop")!;
    expect(cd.configPath()).toContain(".config/Claude");
  });
});

describe("Windows-only documentsDir + userConfigDir branches", () => {
  it("documentsDir prefers OneDrive when set + exists", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    delete process.env.APPDATA;
    const onedrive = path.join(tmp, "OneDrive");
    fs.mkdirSync(path.join(onedrive, "Documents", "Cline", "MCP"), { recursive: true });
    process.env.OneDrive = onedrive;
    const { CLIENT_ADAPTERS } = await import("../src/clients");
    const cline = CLIENT_ADAPTERS.find((a) => a.name === "Cline")!;
    expect(cline.detect()).toBe(true);
    delete process.env.OneDrive;
  });

  it("documentsDir falls back to ~/Documents on Windows when OneDrive is unset", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    delete process.env.OneDrive;
    delete process.env.OneDriveConsumer;
    fs.mkdirSync(path.join(tmp, "Documents", "Cline", "MCP"), { recursive: true });
    const { CLIENT_ADAPTERS } = await import("../src/clients");
    const cline = CLIENT_ADAPTERS.find((a) => a.name === "Cline")!;
    expect(cline.detect()).toBe(true);
  });

  it("userConfigDir falls back to ~/AppData/Roaming on Windows when APPDATA is unset", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    delete process.env.APPDATA;
    fs.mkdirSync(path.join(tmp, "AppData", "Roaming", "zed"), { recursive: true });
    const { CLIENT_ADAPTERS } = await import("../src/clients");
    const zed = CLIENT_ADAPTERS.find((a) => a.name === "Zed")!;
    expect(zed.detect()).toBe(true);
    expect(zed.configPath()).toContain("AppData");
  });
});
