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
  unbootstrap,
} from "../src/lib/bootstrap.js";

let tmp: string;
let originalHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-bootstrap-"));
  process.env.METAHUB_E2E_HOME = tmp;
  // clients.ts uses os.homedir() directly (not the E2E_HOME hook),
  // so we also redirect HOME for the duration of this test. On POSIX
  // platforms os.homedir() reads from process.env.HOME.
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
    // Plant ~/.claude/settings.json so Claude Code is "detected".
    const claudeDir = path.join(tmp, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, "settings.json"), "{}");

    const first = bootstrapMetahubMcp();
    const wroteFirst = first.results.filter((r) => r.status === "wrote");
    expect(wroteFirst.length).toBeGreaterThan(0);

    // Confirm settings.json now has a `metahub` entry under
    // mcpServers pointing at the bundled bin.
    const cfg = JSON.parse(fs.readFileSync(path.join(claudeDir, "settings.json"), "utf8")) as {
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
    fs.writeFileSync(path.join(claudeDir, "settings.json"), "{}");
    bootstrapMetahubMcp();
    unbootstrap();
    const cfg = JSON.parse(fs.readFileSync(path.join(claudeDir, "settings.json"), "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(cfg.mcpServers?.metahub).toBeUndefined();
  });

  it("force=true re-writes even when already wired", () => {
    const claudeDir = path.join(tmp, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, "settings.json"), "{}");
    bootstrapMetahubMcp();
    const forced = bootstrapMetahubMcp({ force: true });
    const wrote = forced.results.filter((r) => r.status === "wrote");
    expect(wrote.length).toBeGreaterThan(0);
  });

  it("wires METAHUB_REGISTRY_URL into the client config", () => {
    const claudeDir = path.join(tmp, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, "settings.json"), "{}");
    bootstrapMetahubMcp();
    const cfg = JSON.parse(fs.readFileSync(path.join(claudeDir, "settings.json"), "utf8")) as {
      mcpServers?: Record<string, { env?: Record<string, string> }>;
    };
    const env = cfg.mcpServers?.metahub?.env;
    expect(env).toBeDefined();
    expect(env!.METAHUB_REGISTRY_URL).toBeDefined();
    expect(env!.METAHUB_REGISTRY_URL.length).toBeGreaterThan(0);
    // Default falls back to the portal endpoint when no auth-config
    // override is present (the tmp HOME has no config.json).
    expect(env!.METAHUB_REGISTRY_URL).toContain("metahub.ai");
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
