/**
 * Tests for the skill-mirror path in wireHook + the ledger-walk in
 * unwireHook. These exercise mirrorSkillToOtherClients():
 *   - the no-source fallback (SKILL.md missing)
 *   - the "skipped-not-detected" branch (client not on disk)
 *   - the "wrote" branch (client detected → transform + write)
 *   - the "error" branch (write throws)
 * and the unwireHook ledger branches (mcp-json sweep, folder skips,
 * single-file unlink, and the swallow-errors catch).
 *
 * detection.js is mocked so we deterministically control which
 * clients look "installed" regardless of the host filesystem — the
 * real detectClient() reads os.homedir() captured at module load,
 * which is not controllable per-test on Windows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Controlled detection: tests flip entries in `detected` before
// importing hooks. The mock reads this live map.
const detected: Record<string, boolean> = {};
vi.mock("../src/detection.js", () => ({
  detectClient: (id: string) => detected[id] ?? false,
  detectedClients: () => Object.keys(detected).filter((k) => detected[k]),
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-installer-mirror-"));
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.XDG_CONFIG_HOME = path.join(tmp, ".config");
  // Pin the canonical install root so installPathFor("skill", …)
  // lands inside our tmp dir no matter what os.homedir() returns.
  process.env.METAHUB_E2E_HOME = tmp;
  origCwd = process.cwd;
  process.cwd = () => tmp;
  for (const k of Object.keys(detected)) delete detected[k];
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

const SKILL_MD = `---
name: PDF Tools
description: Work with PDF files
triggers: pdf, document
---

# PDF Tools

Body content here.
`;

/** Write the canonical SKILL.md so mirrorSkillToOtherClients has a source. */
function writeCanonicalSkill(slug: string): void {
  const dir = path.join(tmp, ".claude", "skills", slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), SKILL_MD, "utf8");
}

describe("wireHook skill mirror — no source", () => {
  it("reports skipped-no-source for every non-claude-code client when SKILL.md is absent", async () => {
    const { wireHook } = await import("../src/hooks");
    // No canonical SKILL.md written → readFileSync throws → fallback.
    const res = wireHook({ kind: "skill", slug: "ghost", ...baseInput });
    expect(res.skillMirrors.length).toBeGreaterThan(0);
    expect(res.skillMirrors.every((m) => m.status === "skipped-no-source")).toBe(true);
    // claude-code is never in the mirror list (it owns the canonical dir).
    expect(res.skillMirrors.some((m) => m.client === "claude-code")).toBe(false);
  });
});

describe("wireHook skill mirror — detected vs not detected", () => {
  it("skips clients that aren't detected", async () => {
    writeCanonicalSkill("pdf");
    // Leave `detected` empty → all non-claude clients skipped.
    const { wireHook } = await import("../src/hooks");
    const res = wireHook({ kind: "skill", slug: "pdf", ...baseInput });
    expect(res.skillMirrors.length).toBeGreaterThan(0);
    expect(res.skillMirrors.every((m) => m.status === "skipped-not-detected")).toBe(true);
  });

  it("writes the transformed rule for a detected client (cursor)", async () => {
    writeCanonicalSkill("pdf");
    detected["cursor"] = true;
    const { wireHook } = await import("../src/hooks");
    const res = wireHook({ kind: "skill", slug: "pdf", ...baseInput });
    const cursor = res.skillMirrors.find((m) => m.client === "cursor");
    expect(cursor?.status).toBe("wrote");
    // The .mdc file the function reports should actually exist on disk.
    expect(fs.existsSync(cursor!.path)).toBe(true);
    const written = fs.readFileSync(cursor!.path, "utf8");
    expect(written).toContain("Work with PDF files"); // description carried into the .mdc

    // The continue/zed rows weren't detected → skipped.
    const others = res.skillMirrors.filter((m) => m.client !== "cursor");
    expect(others.every((m) => m.status === "skipped-not-detected")).toBe(true);
  });

  it("writes for multiple detected clients (cursor + continue + zed)", async () => {
    writeCanonicalSkill("pdf");
    detected["cursor"] = true;
    detected["continue"] = true;
    detected["zed"] = true;
    const { wireHook } = await import("../src/hooks");
    const res = wireHook({ kind: "skill", slug: "pdf", ...baseInput });
    for (const client of ["cursor", "continue", "zed"]) {
      const m = res.skillMirrors.find((x) => x.client === client);
      expect(m?.status).toBe("wrote");
      expect(fs.existsSync(m!.path)).toBe(true);
    }
  });

  it("reports an error when the transform write fails", async () => {
    writeCanonicalSkill("pdf");
    detected["cursor"] = true;
    const { wireHook } = await import("../src/hooks");
    // Force fs.writeFileSync to throw for the mirror write.
    const realWrite = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, "writeFileSync").mockImplementation(((
      file: fs.PathOrFileDescriptor,
      ...rest: unknown[]
    ) => {
      if (typeof file === "string" && file.endsWith(".mdc")) {
        throw new Error("disk full");
      }
      // @ts-expect-error pass-through for non-mirror writes (sidecar, etc.)
      return realWrite(file, ...rest);
    }) as typeof fs.writeFileSync);
    const res = wireHook({ kind: "skill", slug: "pdf", ...baseInput });
    const cursor = res.skillMirrors.find((m) => m.client === "cursor");
    expect(cursor?.status).toBe("error");
    expect(cursor?.error).toMatch(/disk full/);
  });
});

describe("wireHook plugin / agent ledger recording", () => {
  it("plugin: records a claude-code wiring entry (target present)", async () => {
    const { wireHook } = await import("../src/hooks");
    const res = wireHook({ kind: "plugin", slug: "kit", ...baseInput });
    expect(res.clients).toEqual([]);
    expect(res.skillMirrors).toEqual([]);
    // sidecar written under the plugin install dir
    expect(fs.existsSync(path.join(tmp, ".claude", "plugins", "kit", ".metahub.json"))).toBe(true);
    const { findWiring } = await import("../src/wirings");
    const set = findWiring("plugin", "kit");
    expect(set).not.toBeNull();
    expect(set!.wirings).toHaveLength(1);
    expect(set!.wirings[0]).toMatchObject({ client: "claude-code", strategy: "claude-plugin" });
  });

  it("agent: target is null so no wiring entry is recorded, but sidecar is written", async () => {
    const { wireHook } = await import("../src/hooks");
    const res = wireHook({ kind: "agent", slug: "reviewer", ...baseInput });
    expect(res.clients).toEqual([]);
    expect(res.skillMirrors).toEqual([]);
    expect(fs.existsSync(path.join(tmp, ".metahub", "agents", "reviewer", ".metahub.json"))).toBe(
      true,
    );
    const { findWiring } = await import("../src/wirings");
    // agent capability targetPath returns null → the `if (target)` guard
    // is false → recordWiring is never called for agents.
    expect(findWiring("agent", "reviewer")).toBeNull();
  });
});

describe("unwireHook ledger walk", () => {
  it("walks recorded skill wirings: unlinks single-file rules, skips folders", async () => {
    writeCanonicalSkill("pdf");
    detected["cursor"] = true;
    const hooks = await import("../src/hooks");
    const res = hooks.wireHook({ kind: "skill", slug: "pdf", ...baseInput });
    const cursorPath = res.skillMirrors.find((m) => m.client === "cursor")!.path;
    expect(fs.existsSync(cursorPath)).toBe(true);

    // unwire should remove the cursor .mdc (single file) but the
    // claude-code anthropic-skill-md row is a folder → left alone here
    // (the install-dir removal handles it).
    hooks.unwireHook("skill", "pdf");
    expect(fs.existsSync(cursorPath)).toBe(false);
  });

  it("falls back to legacy mcp sweep when no ledger entry exists", async () => {
    const { unwireHook } = await import("../src/hooks");
    // never-recorded mcp slug → set is null → legacy unwireMcpAcrossClients path.
    expect(() => unwireHook("mcp", "never-recorded")).not.toThrow();
  });

  it("walks mcp-json wirings recorded in the ledger", async () => {
    const { recordWiring } = await import("../src/wirings");
    recordWiring({
      artifactId: "art_mcp",
      kind: "mcp",
      slug: "github",
      installedMs: Date.now(),
      wirings: [
        {
          client: "claude-code",
          path: path.join(tmp, ".claude.json"),
          strategy: "mcp-json",
          key: "github",
          writtenMs: Date.now(),
          status: "wrote",
        },
      ],
    });
    const { unwireHook } = await import("../src/hooks");
    expect(() => unwireHook("mcp", "github")).not.toThrow();
  });

  it("swallows errors from a bad ledger path (statSync throws)", async () => {
    const { recordWiring } = await import("../src/wirings");
    recordWiring({
      artifactId: "art_bad",
      kind: "skill",
      slug: "broken",
      installedMs: Date.now(),
      wirings: [
        {
          client: "cursor",
          // Path under a non-existent dir → statSync throws → caught.
          path: path.join(tmp, "does", "not", "exist", "broken.mdc"),
          strategy: "cursor-rule-mdc",
          writtenMs: Date.now(),
          status: "wrote",
        },
      ],
    });
    const { unwireHook } = await import("../src/hooks");
    expect(() => unwireHook("skill", "broken")).not.toThrow();
  });

  it("skips anthropic-skill-md and claude-plugin folder strategies", async () => {
    const { recordWiring } = await import("../src/wirings");
    recordWiring({
      artifactId: "art_plug",
      kind: "plugin",
      slug: "kit",
      installedMs: Date.now(),
      wirings: [
        {
          client: "claude-code",
          path: path.join(tmp, ".claude", "plugins", "kit"),
          strategy: "claude-plugin",
          writtenMs: Date.now(),
          status: "wrote",
        },
      ],
    });
    const { unwireHook } = await import("../src/hooks");
    expect(() => unwireHook("plugin", "kit")).not.toThrow();
  });
});
