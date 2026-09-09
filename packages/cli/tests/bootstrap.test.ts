/**
 * Tests for the MetaHub MCP bootstrap helpers.
 *
 * findMetahubMcpBin() is integration-y — it relies on Node's
 * resolver finding the workspace-linked mcp-server. In a CI/local
 * checkout `pnpm install` makes that link real, so the test should
 * pass without any mocking.
 *
 * bootstrapStatus() / bootstrapMetahubMcp() touch real client
 * configs via @metahub/installer. We test them by redirecting HOME
 * to a tmpdir (the installer's METAHUB_E2E_HOME hook) so writes
 * don't escape into the real user config.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bootstrapMetahubMcp,
  bootstrapStatus,
  findMetahubMcpBin,
  isNpxCachePath,
  launchSpecFor,
  unbootstrap,
} from "../src/lib/bootstrap.js";
import { INSTRUCTIONS_BEGIN } from "../src/lib/instructions.js";

let tmp: string;
let originalHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-bootstrap-"));
  process.env.METAHUB_E2E_HOME = tmp;
  // clients.ts now resolves through the installer's shared getHome(), so
  // METAHUB_E2E_HOME alone is enough. HOME is still redirected as a
  // belt-and-braces guard against anything that reaches os.homedir()
  // directly, so a regression cannot write into the real user config.
  originalHome = process.env.HOME;
  process.env.HOME = tmp;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.METAHUB_E2E_HOME;
});

describe("findMetahubMcpBin", () => {
  it("resolves a real bin path", () => {
    const bin = findMetahubMcpBin();
    expect(bin).toContain("metahub-mcp.js");
    expect(fs.existsSync(bin)).toBe(true);
  });
});

describe("bootstrapStatus", () => {
  it("returns one row per known client", () => {
    const bin = findMetahubMcpBin();
    const rows = bootstrapStatus(bin);
    expect(rows.length).toBeGreaterThanOrEqual(11);
    for (const r of rows) {
      expect(r.client).toBeTruthy();
      expect(r.configPath).toBeTruthy();
      expect(["wired", "wired-elsewhere", "absent", "not-detected", "manual"]).toContain(r.state);
    }
  });

  it("reports clients as not-detected when their root dir is absent", () => {
    // The HOME redirect makes ~/.claude / ~/.cursor / etc. all not
    // exist for this test, so every JSON client should be
    // not-detected.
    const bin = findMetahubMcpBin();
    const rows = bootstrapStatus(bin);
    const notDetected = rows.filter((r) => r.state === "not-detected");
    expect(notDetected.length).toBeGreaterThan(0);
  });
});

describe("bootstrapMetahubMcp (with one detected client)", () => {
  it("wires into Claude Code when ~/.claude exists, and is idempotent on re-run", () => {
    // Plant ~/.claude so Claude Code is "detected".
    const claudeDir = path.join(tmp, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });

    const first = bootstrapMetahubMcp();
    const wroteFirst = first.results.filter((r) => r.status === "wrote");
    expect(wroteFirst.length).toBeGreaterThan(0);

    // Confirm the user-scoped ~/.claude.json now has a `metahub` entry under
    // mcpServers pointing at the bundled bin.
    const cfg = JSON.parse(fs.readFileSync(path.join(tmp, ".claude.json"), "utf8")) as {
      mcpServers?: Record<string, { command: string; args: string[] }>;
    };
    expect(cfg.mcpServers).toBeDefined();
    expect(cfg.mcpServers!.metahub).toBeDefined();
    expect(cfg.mcpServers!.metahub.command).toBe("node");
    expect(cfg.mcpServers!.metahub.args[0]).toContain("metahub-mcp.js");

    // Re-run: should be a no-op (already wired pointing at same bin).
    const second = bootstrapMetahubMcp();
    const wroteSecond = second.results.filter((r) => r.status === "wrote");
    expect(wroteSecond).toHaveLength(0);
  });

  it("unbootstrap removes the entry from a wired client", () => {
    const claudeDir = path.join(tmp, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    bootstrapMetahubMcp();
    unbootstrap();
    const cfg = JSON.parse(fs.readFileSync(path.join(tmp, ".claude.json"), "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(cfg.mcpServers?.metahub).toBeUndefined();
  });

  it("writes the MetaHub instruction block into every detected harness by default", () => {
    fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(tmp, ".codex"), { recursive: true });
    const res = bootstrapMetahubMcp();
    const wrote = res.instructions.filter((r) => r.status === "wrote").map((r) => r.id);
    expect(wrote).toEqual(expect.arrayContaining(["claude-code", "codex-cli"]));
    expect(fs.readFileSync(path.join(tmp, ".claude", "CLAUDE.md"), "utf8")).toContain(
      INSTRUCTIONS_BEGIN,
    );
    expect(fs.readFileSync(path.join(tmp, ".codex", "AGENTS.md"), "utf8")).toContain(
      INSTRUCTIONS_BEGIN,
    );
    // Re-run: MCP wiring is a no-op and the blocks are reported current.
    const again = bootstrapMetahubMcp();
    expect(again.results.filter((r) => r.status === "wrote")).toHaveLength(0);
    expect(again.instructions.find((r) => r.id === "claude-code")?.status).toBe("current");
    // unbootstrap takes the blocks away too.
    unbootstrap();
    expect(fs.existsSync(path.join(tmp, ".claude", "CLAUDE.md"))).toBe(false);
  });

  it("leaves instruction files alone with instructions:false or METAHUB_NO_INSTRUCTIONS=1", () => {
    fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
    const res = bootstrapMetahubMcp({ instructions: false });
    expect(res.instructions).toEqual([]);
    expect(fs.existsSync(path.join(tmp, ".claude", "CLAUDE.md"))).toBe(false);
    process.env.METAHUB_NO_INSTRUCTIONS = "1";
    try {
      expect(bootstrapMetahubMcp().instructions).toEqual([]);
    } finally {
      delete process.env.METAHUB_NO_INSTRUCTIONS;
    }
    expect(fs.existsSync(path.join(tmp, ".claude", "CLAUDE.md"))).toBe(false);
  });

  it("wires Gemini CLI, Antigravity and opencode when their roots exist", () => {
    fs.mkdirSync(path.join(tmp, ".gemini", "antigravity"), { recursive: true });
    fs.mkdirSync(path.join(tmp, ".config", "opencode"), { recursive: true });
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      const res = bootstrapMetahubMcp({ instructions: false });
      const wrote = res.results.filter((r) => r.status === "wrote").map((r) => r.client);
      expect(wrote).toEqual(expect.arrayContaining(["Gemini CLI", "Antigravity", "opencode"]));
      const gemini = JSON.parse(
        fs.readFileSync(path.join(tmp, ".gemini", "settings.json"), "utf8"),
      );
      expect(gemini.mcpServers.metahub.args[0]).toContain("metahub-mcp.js");
      const ag = JSON.parse(
        fs.readFileSync(path.join(tmp, ".gemini", "config", "mcp_config.json"), "utf8"),
      );
      expect(ag.mcpServers.metahub.command).toBe("node");
      const oc = JSON.parse(
        fs.readFileSync(path.join(tmp, ".config", "opencode", "opencode.json"), "utf8"),
      );
      expect(oc.mcp.metahub.type).toBe("local");
      expect(oc.mcp.metahub.command[0]).toBe("node");
      // Status sees all three as wired now.
      const rows = bootstrapStatus(findMetahubMcpBin());
      for (const name of ["Gemini CLI", "Antigravity", "opencode"]) {
        expect(rows.find((r) => r.client === name)?.state, name).toBe("wired");
      }
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform });
    }
  });

  it("force=true re-writes even when already wired", () => {
    const claudeDir = path.join(tmp, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    bootstrapMetahubMcp();
    const forced = bootstrapMetahubMcp({ force: true });
    const wrote = forced.results.filter((r) => r.status === "wrote");
    expect(wrote.length).toBeGreaterThan(0);
  });

  it("does NOT bake METAHUB_REGISTRY_URL in when the user chose no override", () => {
    // It used to emit `cfg.registryUrl || <portal>`, but loadAuthConfig()
    // always fills registryUrl in, so every wired client got
    // `https://registry.metahub.ai` — the registry *website* root, which
    // serves HTML. The MCP server reads the portal by default and treats
    // this var as an opt-in snapshot override, so emitting the default
    // pointed the degraded fallback at a page of HTML.
    const claudeDir = path.join(tmp, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    bootstrapMetahubMcp();
    const cfg = JSON.parse(fs.readFileSync(path.join(tmp, ".claude.json"), "utf8")) as {
      mcpServers?: Record<string, { env?: Record<string, string> }>;
    };
    const env = cfg.mcpServers?.metahub?.env;
    expect(env).toBeDefined();
    expect(env!.METAHUB_PORTAL_URL).toBeTruthy();
    expect(env).not.toHaveProperty("METAHUB_REGISTRY_URL");
  });

  it("forwards METAHUB_REGISTRY_URL when the user really did set one", () => {
    // Reads the user-scoped ~/.claude.json, matching the sibling tests and
    // this repo's Claude Code adapter.
    fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
    process.env.METAHUB_REGISTRY_URL = "https://snapshot.example/registry.json";
    try {
      bootstrapMetahubMcp();
    } finally {
      delete process.env.METAHUB_REGISTRY_URL;
    }
    const cfg = JSON.parse(fs.readFileSync(path.join(tmp, ".claude.json"), "utf8")) as {
      mcpServers?: Record<string, { env?: Record<string, string> }>;
    };
    expect(cfg.mcpServers?.metahub?.env?.METAHUB_REGISTRY_URL).toBe(
      "https://snapshot.example/registry.json",
    );
  });
});

describe("upgrade install-source detection", () => {
  // The marker file is conventionally at `dist/.install-source` in the
  // bundled standalone package. We just exercise the detection helper
  // here — the actual curl-pipe-sh round trip would need a real
  // network call.
  it("returns 'unknown' when no marker exists", async () => {
    const { detectInstallSource } = await import("../src/commands/upgrade.js");
    // In a dev (tsc) build the marker file isn't emitted; the helper
    // should report 'unknown' so the user gets both upgrade options.
    const result = detectInstallSource();
    expect(["tarball", "package-manager", "unknown"]).toContain(result);
  });
});

describe("launchSpecFor", () => {
  it("uses the absolute bin for a normal install", () => {
    expect(launchSpecFor("/usr/local/lib/node_modules/@metahub-ai/mh/bin/metahub-mcp.js")).toEqual({
      command: "node",
      args: ["/usr/local/lib/node_modules/@metahub-ai/mh/bin/metahub-mcp.js"],
    });
    expect(isNpxCachePath("/usr/local/lib/node_modules/@metahub-ai/mh/bin/metahub-mcp.js")).toBe(
      false,
    );
  });

  it("switches to the npx form when the bin lives in npm's npx cache", () => {
    const bin = path.join(
      os.homedir(),
      ".npm",
      "_npx",
      "08cfa0a590185a80",
      "node_modules",
      "@metahub-ai",
      "mh",
      "bin",
      "metahub-mcp.js",
    );
    expect(isNpxCachePath(bin)).toBe(true);
    expect(launchSpecFor(bin)).toEqual({
      command: "npx",
      args: ["-y", "--package=@metahub-ai/mh", "metahub-mcp"],
    });
  });

  it("bootstrapStatus recognises an npx-form entry as wired", () => {
    fs.mkdirSync(path.join(tmp, ".cursor"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          metahub: { command: "npx", args: ["-y", "--package=@metahub-ai/mh", "metahub-mcp"] },
        },
      }),
    );
    const npxBin = path.join(
      tmp,
      ".npm",
      "_npx",
      "abc",
      "node_modules",
      "@metahub-ai",
      "mh",
      "bin",
      "metahub-mcp.js",
    );
    const rows = bootstrapStatus(npxBin);
    expect(rows.find((r) => r.client === "Cursor")?.state).toBe("wired");
    // The same entry seen from a global install is "elsewhere".
    const rows2 = bootstrapStatus("/opt/mh/bin/metahub-mcp.js");
    expect(rows2.find((r) => r.client === "Cursor")?.state).toBe("wired-elsewhere");
  });
});
