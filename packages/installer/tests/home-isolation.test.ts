/**
 * Regression tests for `METAHUB_E2E_HOME` isolation.
 *
 * `paths.ts` honoured the override but `clients.ts`, `detection.ts` and
 * `capabilities.ts` each called `os.homedir()` directly, which split the
 * installer's view of "home" in two. An MCP-kind install then wrote the
 * artifact under the overridden home while wiring it — together with the
 * per-install `mhi_` ingest credential in the launch env — into the
 * developer's **real** `~/.claude/settings.json`. Any sandboxed caller
 * (E2E tests, CI, the eval worker) silently mutated the host's editor
 * config, and the two halves pointed at different trees.
 *
 * These tests fail loudly if any of those modules regains a direct
 * `os.homedir()` dependency.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLIENT_ADAPTERS } from "../src/clients";
import { detectClient } from "../src/detection";
import { CAPABILITY_MATRIX } from "../src/capabilities";
import { installPathFor } from "../src/paths";

const ORIGINAL = process.env.METAHUB_E2E_HOME;
let sandbox: string;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "metahub-home-"));
  process.env.METAHUB_E2E_HOME = sandbox;
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.METAHUB_E2E_HOME;
  else process.env.METAHUB_E2E_HOME = ORIGINAL;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

/**
 * Static imports on purpose. The fix resolves the home directory at
 * CALL time rather than freezing it in a module-level `const` at import
 * time, so a single import must already observe an override applied
 * afterwards. If these ever need re-importing to pass, the module-level
 * capture has come back.
 */
function claudeCodeAdapter() {
  const a = CLIENT_ADAPTERS.find((x) => x.name === "Claude Code");
  if (!a) throw new Error("Claude Code adapter missing");
  return a;
}

const DEMO_ENV = {
  METAHUB_INGEST_API_KEY: "mhi_secret_value",
  METAHUB_INSTALL_ID: "ins_1",
  METAHUB_ARTIFACT_ID: "art_1",
  METAHUB_PORTAL_URL: "https://portal.test",
};

describe("METAHUB_E2E_HOME is honoured by every path-producing module", () => {
  it("client config paths resolve under the sandbox, not the real home", async () => {
    // Two adapters are legitimately not home-derived: VS Code writes a
    // workspace-relative `.vscode/mcp.json`, and Cline has no file at all
    // (its configPath is a human instruction). Everything else must be
    // inside the sandbox.
    const homeDerived = CLIENT_ADAPTERS.map((a) => ({ name: a.name, path: a.configPath() })).filter(
      (c) => path.isAbsolute(c.path) && !c.path.startsWith(process.cwd()),
    );
    expect(homeDerived.length).toBeGreaterThan(0);
    expect(homeDerived.filter((c) => !c.path.startsWith(sandbox))).toEqual([]);
  });

  it("capability target paths resolve under the sandbox", async () => {
    // Some rows return human instructions ("Cline panel → MCP Servers → Add")
    // rather than a path, and VS Code's is workspace-relative by design.
    // Only absolute home-derived paths are in scope here.
    const targets = CAPABILITY_MATRIX.map((row) => row.targetPath("some-slug")).filter(
      (p): p is string => typeof p === "string" && path.isAbsolute(p),
    );
    const homeDerived = targets.filter((p) => !p.startsWith(process.cwd()));
    expect(homeDerived.length).toBeGreaterThan(0);
    expect(homeDerived.filter((p) => !p.startsWith(sandbox))).toEqual([]);
  });

  it("detection looks for clients inside the sandbox", async () => {
    // Nothing exists in a brand-new sandbox, so every client reads as absent
    // even though the real home very likely has ~/.claude.
    expect(detectClient("claude-code")).toBe(false);
    // Create it in the sandbox and detection must flip.
    fs.mkdirSync(path.join(sandbox, ".claude"), { recursive: true });
    expect(detectClient("claude-code")).toBe(true);
  });

  it("installPathFor stays under the sandbox for every kind", async () => {
    for (const kind of ["skill", "mcp", "agent", "plugin"] as const) {
      expect(installPathFor(kind, "some-slug").startsWith(sandbox)).toBe(true);
    }
  });
});

describe("wiring writes stay inside the sandbox and are not world-readable", () => {
  it("wire() writes the sandbox config, never the real ~/.claude/settings.json", async () => {
    const realSettings = path.join(os.homedir(), ".claude", "settings.json");
    const before = fs.existsSync(realSettings) ? fs.readFileSync(realSettings, "utf8") : null;

    const result = claudeCodeAdapter().wire(
      "demo",
      { command: "node", args: ["/x/index.js"] },
      DEMO_ENV,
    );
    expect(result.status).toBe("wrote");
    expect(result.configPath.startsWith(sandbox)).toBe(true);

    const written = fs.readFileSync(result.configPath, "utf8");
    expect(written).toContain("mhi_secret_value");

    const after = fs.existsSync(realSettings) ? fs.readFileSync(realSettings, "utf8") : null;
    expect(after).toBe(before);
  });

  it("the config holding the mhi_ credential is 0600, not world-readable", async () => {
    const result = claudeCodeAdapter().wire(
      "demo",
      { command: "node", args: ["/x/index.js"] },
      DEMO_ENV,
    );
    const mode = fs.statSync(result.configPath).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });

  it("leaves VS Code's workspace config readable — it is not a per-user dotfile", async () => {
    // 0600 is right for ~/.claude/settings.json, but .vscode/mcp.json is a
    // workspace file: in a devcontainer or CI image the editor server can run
    // under a different uid than the one that installed, and a 0600 file would
    // silently disappear from VS Code.
    const vscode = CLIENT_ADAPTERS.find((a) => a.name === "VS Code");
    expect(vscode).toBeDefined();
    const dir = path.join(sandbox, "workspace");
    fs.mkdirSync(path.join(dir, ".vscode"), { recursive: true });
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const res = vscode!.wire("demo", { command: "node", args: ["/x.js"] }, DEMO_ENV);
      expect(res.status).toBe("wrote");
      const mode = fs.statSync(res.configPath).mode & 0o777;
      expect(mode & 0o077, "workspace config must not be forced to 0600").not.toBe(0);
    } finally {
      process.chdir(cwd);
    }
  });

  it("preserves unrelated entries and removes only its own on unwire", async () => {
    const adapter = claudeCodeAdapter();
    const file = adapter.configPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { keepme: { command: "x" } } }));

    adapter.wire("demo", { command: "node", args: ["/x/index.js"] }, DEMO_ENV);
    let cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(Object.keys(cfg.mcpServers).toSorted()).toEqual(["demo", "keepme"]);

    adapter.unwire("demo");
    cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(Object.keys(cfg.mcpServers)).toEqual(["keepme"]);
    expect(fs.readFileSync(file, "utf8")).not.toContain("mhi_secret_value");
  });
});
