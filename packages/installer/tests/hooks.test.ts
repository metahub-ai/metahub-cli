/**
 * Tests for wireHook / unwireHook — the post-install glue that drops a
 * SKILL.md folder for skills, a plugins folder for plugins, and the
 * `.metahub.json` sidecar that the SDK reads at runtime. MCP wiring is
 * exercised separately under wire-clients.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_KEYS = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME"] as const;
const saved: Record<string, string | undefined> = {};

let tmp: string;
let origCwd: () => string;

beforeEach(() => {
  for (const k of STATE_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-installer-hooks-"));
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
});

const baseInput = {
  ingestApiKey: "mhi_abc",
  installId: "ins_x",
  artifactId: "art_x",
  portalUrl: "http://portal.test",
};

describe("wireHook (skill / plugin / agent)", () => {
  it("writes a .metahub.json sidecar in the skill install dir + reports no clients", async () => {
    const { wireHook } = await import("../src/hooks");
    const res = wireHook({ kind: "skill", slug: "pdf", ...baseInput });
    expect(res.clients).toEqual([]);
    const sidecar = JSON.parse(
      fs.readFileSync(path.join(tmp, ".claude", "skills", "pdf", ".metahub.json"), "utf8"),
    );
    expect(sidecar).toMatchObject({
      artifactId: "art_x",
      installId: "ins_x",
      ingestApiKey: "mhi_abc",
      kind: "skill",
      slug: "pdf",
    });
  });

  it("plugins land under .claude/plugins with a sidecar", async () => {
    const { wireHook } = await import("../src/hooks");
    wireHook({ kind: "plugin", slug: "kit", ...baseInput });
    expect(fs.existsSync(path.join(tmp, ".claude", "plugins", "kit", ".metahub.json"))).toBe(true);
  });

  it("agents land under ~/.metahub/agents with a sidecar", async () => {
    const { wireHook } = await import("../src/hooks");
    wireHook({ kind: "agent", slug: "reviewer", ...baseInput });
    expect(fs.existsSync(path.join(tmp, ".metahub", "agents", "reviewer", ".metahub.json"))).toBe(
      true,
    );
  });
});

describe("wireHook (mcp)", () => {
  function writeServerEntry(slug: string, files: Record<string, string>) {
    const dir = path.join(tmp, ".metahub", "mcp", slug);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      const filePath = path.join(dir, name);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
    }
    return dir;
  }

  it("uses package.json `bin` when given as an object map", async () => {
    writeServerEntry("server-obj", {
      "package.json": JSON.stringify({ bin: { mh: "dist/cli.js" } }),
      "dist/cli.js": "#!/usr/bin/env node",
    });
    const { wireHook } = await import("../src/hooks");
    const res = wireHook({ kind: "mcp", slug: "server-obj", ...baseInput });
    expect(res.warning).toBeUndefined();
  });

  it("uses package.json `bin` when present", async () => {
    writeServerEntry("server-a", {
      "package.json": JSON.stringify({ bin: "dist/cli.js" }),
      "dist/cli.js": "#!/usr/bin/env node",
    });
    const { wireHook } = await import("../src/hooks");
    const res = wireHook({ kind: "mcp", slug: "server-a", ...baseInput });
    const claudeCode = res.clients.find((c) => c.client === "Claude Code");
    expect(claudeCode?.status).toBe("wrote");
  });

  it("uses package.json `main` when bin is missing", async () => {
    writeServerEntry("server-b", {
      "package.json": JSON.stringify({ main: "lib/index.js" }),
      "lib/index.js": "",
    });
    const { wireHook } = await import("../src/hooks");
    const res = wireHook({ kind: "mcp", slug: "server-b", ...baseInput });
    expect(res.warning).toBeUndefined();
  });

  it("uses npm scripts.start when bin + main are missing", async () => {
    writeServerEntry("server-c", {
      "package.json": JSON.stringify({ scripts: { start: "node ./out.js" } }),
    });
    const { wireHook } = await import("../src/hooks");
    const res = wireHook({ kind: "mcp", slug: "server-c", ...baseInput });
    expect(res.warning).toBeUndefined();
  });

  it("falls back to conventional entry files when package.json is missing", async () => {
    writeServerEntry("server-d", {
      "dist/index.js": "",
    });
    const { wireHook } = await import("../src/hooks");
    const res = wireHook({ kind: "mcp", slug: "server-d", ...baseInput });
    expect(res.warning).toBeUndefined();
  });

  it("emits a warning when launch cannot be resolved", async () => {
    writeServerEntry("server-e", {
      "README.md": "no entry point here",
    });
    const { wireHook } = await import("../src/hooks");
    const res = wireHook({ kind: "mcp", slug: "server-e", ...baseInput });
    expect(res.warning).toMatch(/Couldn't infer how to launch/);
    expect(res.clients).toEqual([]);
  });
});

describe("unwireHook", () => {
  it("no-ops for non-mcp kinds (does not touch client configs)", async () => {
    const { unwireHook } = await import("../src/hooks");
    expect(() => unwireHook("skill", "pdf")).not.toThrow();
  });

  it("for mcp, calls unwireMcpAcrossClients (idempotent)", async () => {
    const { unwireHook } = await import("../src/hooks");
    expect(() => unwireHook("mcp", "never-installed")).not.toThrow();
  });
});
