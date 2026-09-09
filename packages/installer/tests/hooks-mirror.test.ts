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
  it("skips clients that aren't detected, but always links the Agent Skills dir", async () => {
    writeCanonicalSkill("pdf");
    // Leave `detected` empty → every real client is skipped.
    const { wireHook } = await import("../src/hooks");
    const res = wireHook({ kind: "skill", slug: "pdf", ...baseInput });
    const agents = res.skillMirrors.find((m) => m.client === "agents-dir");
    expect(agents?.status).toBe("wrote");
    const others = res.skillMirrors.filter((m) => m.client !== "agents-dir");
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((m) => m.status === "skipped-not-detected")).toBe(true);
  });

  it("links ~/.agents/skills/<slug> at the canonical folder", async () => {
    writeCanonicalSkill("pdf");
    const { wireHook } = await import("../src/hooks");
    const res = wireHook({ kind: "skill", slug: "pdf", ...baseInput });
    const agents = res.skillMirrors.find((m) => m.client === "agents-dir")!;
    expect(agents.path).toBe(path.join(tmp, ".agents", "skills", "pdf"));
    expect(fs.lstatSync(agents.path).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(agents.path, "SKILL.md"), "utf8")).toBe(SKILL_MD);
    // Recorded in the ledger so uninstall can remove it.
    const { findWiring } = await import("../src/wirings");
    const set = findWiring("skill", "pdf")!;
    expect(
      set.wirings.some((w) => w.client === "agents-dir" && w.strategy === "skill-dir-link"),
    ).toBe(true);
  });

  it("re-linking replaces a stale link but never a foreign directory", async () => {
    writeCanonicalSkill("pdf");
    const target = path.join(tmp, ".agents", "skills", "pdf");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(path.join(tmp, "elsewhere"), target, "dir");
    const { wireHook } = await import("../src/hooks");
    let res = wireHook({ kind: "skill", slug: "pdf", ...baseInput });
    expect(res.skillMirrors.find((m) => m.client === "agents-dir")?.status).toBe("wrote");
    expect(fs.readlinkSync(target)).toBe(path.join(tmp, ".claude", "skills", "pdf"));

    // A real directory the user made themselves stays put.
    fs.unlinkSync(target);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "SKILL.md"), "# theirs");
    res = wireHook({ kind: "skill", slug: "pdf", ...baseInput });
    expect(res.skillMirrors.find((m) => m.client === "agents-dir")?.status).toBe("skipped-exists");
    expect(fs.readFileSync(path.join(target, "SKILL.md"), "utf8")).toBe("# theirs");
  });

  it("links into Antigravity's global skills dir only when Antigravity is detected", async () => {
    writeCanonicalSkill("pdf");
    const { wireHook } = await import("../src/hooks");
    let res = wireHook({ kind: "skill", slug: "pdf", ...baseInput });
    expect(res.skillMirrors.find((m) => m.client === "antigravity")?.status).toBe(
      "skipped-not-detected",
    );
    detected["antigravity"] = true;
    res = wireHook({ kind: "skill", slug: "pdf", ...baseInput });
    const ag = res.skillMirrors.find((m) => m.client === "antigravity")!;
    expect(ag.status).toBe("wrote");
    expect(ag.path).toBe(path.join(tmp, ".gemini", "config", "skills", "pdf"));
    expect(fs.lstatSync(ag.path).isSymbolicLink()).toBe(true);
  });

  it("reports native readers (Cursor, Codex, Gemini CLI, opencode, Goose) without writing", async () => {
    writeCanonicalSkill("pdf");
    detected["cursor"] = true;
    detected["codex-cli"] = true;
    detected["gemini-cli"] = true;
    detected["opencode"] = true;
    detected["goose"] = true;
    const { wireHook } = await import("../src/hooks");
    const res = wireHook({ kind: "skill", slug: "pdf", ...baseInput });
    for (const client of ["cursor", "codex-cli", "gemini-cli", "opencode", "goose"]) {
      const m = res.skillMirrors.find((x) => x.client === client);
      expect(m?.status, client).toBe("native");
      expect(m?.path, client).toBe(path.join(tmp, ".agents", "skills", "pdf"));
    }
    // No Cursor .mdc rule is written any more.
    expect(fs.existsSync(path.join(tmp, ".cursor", "rules", "pdf.mdc"))).toBe(false);
    const { findWiring } = await import("../src/wirings");
    expect(findWiring("skill", "pdf")!.wirings.some((w) => w.client === "cursor")).toBe(false);
  });

  it("writes transformed rules for detected file-based clients (continue + zed)", async () => {
    writeCanonicalSkill("pdf");
    detected["continue"] = true;
    detected["zed"] = true;
    const { wireHook } = await import("../src/hooks");
    const res = wireHook({ kind: "skill", slug: "pdf", ...baseInput });
    for (const client of ["continue", "zed"]) {
      const m = res.skillMirrors.find((x) => x.client === client);
      expect(m?.status).toBe("wrote");
      expect(fs.existsSync(m!.path)).toBe(true);
    }
    const cont = res.skillMirrors.find((x) => x.client === "continue")!;
    expect(fs.readFileSync(cont.path, "utf8")).toContain("Work with PDF files");
  });

  it("reports an error when the transform write fails", async () => {
    writeCanonicalSkill("pdf");
    detected["continue"] = true;
    const { wireHook } = await import("../src/hooks");
    // Force fs.writeFileSync to throw for the mirror write.
    const realWrite = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, "writeFileSync").mockImplementation(((
      file: fs.PathOrFileDescriptor,
      ...rest: unknown[]
    ) => {
      if (typeof file === "string" && file.includes(path.join(".continue", "rules"))) {
        throw new Error("disk full");
      }
      // @ts-expect-error pass-through for non-mirror writes (sidecar, etc.)
      return realWrite(file, ...rest);
    }) as typeof fs.writeFileSync);
    const res = wireHook({ kind: "skill", slug: "pdf", ...baseInput });
    const cont = res.skillMirrors.find((m) => m.client === "continue");
    expect(cont?.status).toBe("error");
    expect(cont?.error).toMatch(/disk full/);
  });
});

describe("refreshSkillWiring", () => {
  it("adds wirings for a client that appeared after install, and persists them", async () => {
    writeCanonicalSkill("pdf");
    const hooks = await import("../src/hooks");
    hooks.wireHook({ kind: "skill", slug: "pdf", ...baseInput });
    const { findWiring } = await import("../src/wirings");
    expect(findWiring("skill", "pdf")!.wirings.some((w) => w.client === "continue")).toBe(false);

    detected["continue"] = true;
    const first = hooks.refreshSkillWiring("pdf");
    expect(first.added.map((w) => w.client)).toEqual(["continue"]);
    expect(fs.existsSync(path.join(tmp, ".continue", "rules", "pdf.md"))).toBe(true);
    // The ledger now carries the new entry (issue #9).
    const set = findWiring("skill", "pdf")!;
    expect(set.wirings.some((w) => w.client === "continue")).toBe(true);
    expect(set.artifactId).toBe("art_x");

    // A second pass is a no-op for the ledger.
    const second = hooks.refreshSkillWiring("pdf");
    expect(second.added).toEqual([]);
  });

  it("keeps ledger entries it did not touch this pass (legacy Cursor .mdc)", async () => {
    writeCanonicalSkill("pdf");
    const { recordWiring, findWiring } = await import("../src/wirings");
    const legacy = path.join(tmp, ".cursor", "rules", "pdf.mdc");
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, "old rule");
    recordWiring({
      artifactId: "art_x",
      kind: "skill",
      slug: "pdf",
      installedMs: 1,
      wirings: [
        {
          client: "cursor",
          path: legacy,
          strategy: "cursor-rule-mdc",
          writtenMs: 1,
          status: "wrote",
        },
      ],
    });
    const hooks = await import("../src/hooks");
    hooks.refreshSkillWiring("pdf");
    const set = findWiring("skill", "pdf")!;
    expect(set.wirings.some((w) => w.strategy === "cursor-rule-mdc")).toBe(true);
    // ...so uninstall still removes the old file.
    hooks.unwireHook("skill", "pdf");
    expect(fs.existsSync(legacy)).toBe(false);
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
  it("removes the Agent Skills link but leaves a foreign directory alone", async () => {
    writeCanonicalSkill("pdf");
    const hooks = await import("../src/hooks");
    hooks.wireHook({ kind: "skill", slug: "pdf", ...baseInput });
    const link = path.join(tmp, ".agents", "skills", "pdf");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    hooks.unwireHook("skill", "pdf");
    expect(fs.existsSync(link)).toBe(false);
    // Canonical folder is untouched here (uninstallArtifact removes it).
    expect(fs.existsSync(path.join(tmp, ".claude", "skills", "pdf", "SKILL.md"))).toBe(true);

    // A directory that is not ours under the same path survives an unwire.
    hooks.wireHook({ kind: "skill", slug: "pdf", ...baseInput });
    fs.unlinkSync(link);
    fs.mkdirSync(link, { recursive: true });
    fs.writeFileSync(path.join(link, "SKILL.md"), "# theirs");
    hooks.unwireHook("skill", "pdf");
    expect(fs.readFileSync(path.join(link, "SKILL.md"), "utf8")).toBe("# theirs");
  });

  it("walks recorded skill wirings: unlinks single-file rules, skips folders", async () => {
    writeCanonicalSkill("pdf");
    detected["continue"] = true;
    const hooks = await import("../src/hooks");
    const res = hooks.wireHook({ kind: "skill", slug: "pdf", ...baseInput });
    const cursorPath = res.skillMirrors.find((m) => m.client === "continue")!.path;
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
