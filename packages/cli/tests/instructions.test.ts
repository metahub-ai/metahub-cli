/**
 * Tests for the harness instruction blocks `mh bootstrap` writes.
 *
 * Everything runs against a tmp HOME via METAHUB_E2E_HOME so the
 * developer's real CLAUDE.md / AGENTS.md / GEMINI.md are never touched.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  INSTRUCTIONS_BEGIN,
  INSTRUCTIONS_END,
  instructionBlock,
  instructionStatus,
  removeInstructionBlocks,
  writeInstructionBlocks,
} from "../src/lib/instructions.js";

let tmp: string;
let origPlatform: NodeJS.Platform;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-instructions-"));
  process.env.METAHUB_E2E_HOME = tmp;
  origPlatform = process.platform;
  // userConfigDir() is ~/.config on darwin/linux; pin linux so the
  // opencode / goose paths are deterministic on every CI runner.
  Object.defineProperty(process, "platform", { value: "linux" });
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: origPlatform });
  delete process.env.METAHUB_E2E_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function mk(...segs: string[]): string {
  const p = path.join(tmp, ...segs);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

describe("instructionBlock", () => {
  it("is fenced, names both the MCP and the CLI path, and stays small", () => {
    const block = instructionBlock();
    expect(block.startsWith(INSTRUCTIONS_BEGIN)).toBe(true);
    expect(block.endsWith(INSTRUCTIONS_END)).toBe(true);
    expect(block).toContain("metahub_search");
    expect(block).toContain("metahub_install");
    expect(block).toContain("mh search");
    expect(block).toContain("mh install");
    expect(Buffer.byteLength(block, "utf8")).toBeLessThan(1500);
  });
});

describe("writeInstructionBlocks", () => {
  it("skips harnesses that are not on the machine", () => {
    const out = writeInstructionBlocks();
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((r) => r.status === "skipped-not-detected")).toBe(true);
    expect(fs.existsSync(path.join(tmp, ".claude", "CLAUDE.md"))).toBe(false);
  });

  it("creates ~/.claude/CLAUDE.md with just the block when Claude Code is present", () => {
    mk(".claude");
    const out = writeInstructionBlocks();
    const cc = out.find((r) => r.id === "claude-code")!;
    expect(cc.status).toBe("wrote");
    expect(cc.file).toBe(path.join(tmp, ".claude", "CLAUDE.md"));
    expect(fs.readFileSync(cc.file, "utf8")).toBe(`${instructionBlock()}\n`);
  });

  it("appends to an existing file and preserves what the user wrote", () => {
    mk(".gemini");
    const file = path.join(tmp, ".gemini", "GEMINI.md");
    fs.writeFileSync(file, "# My rules\n\nAlways use pnpm.\n");
    const out = writeInstructionBlocks();
    expect(out.find((r) => r.id === "gemini")?.status).toBe("wrote");
    const text = fs.readFileSync(file, "utf8");
    expect(text.startsWith("# My rules\n\nAlways use pnpm.\n\n")).toBe(true);
    expect(text).toContain(INSTRUCTIONS_BEGIN);
    expect(text.endsWith(`${INSTRUCTIONS_END}\n`)).toBe(true);
  });

  it("is idempotent: a second run reports current and changes nothing", () => {
    mk(".codex");
    writeInstructionBlocks();
    const file = path.join(tmp, ".codex", "AGENTS.md");
    const before = fs.readFileSync(file, "utf8");
    const out = writeInstructionBlocks();
    expect(out.find((r) => r.id === "codex-cli")?.status).toBe("current");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(before.split(INSTRUCTIONS_BEGIN)).toHaveLength(2);
  });

  it("replaces an older block in place rather than appending a second one", () => {
    mk(".codex");
    const file = path.join(tmp, ".codex", "AGENTS.md");
    fs.writeFileSync(
      file,
      `intro\n\n${INSTRUCTIONS_BEGIN}\nold text\n${INSTRUCTIONS_END}\n\nouttro\n`,
    );
    const out = writeInstructionBlocks();
    expect(out.find((r) => r.id === "codex-cli")?.status).toBe("updated");
    const text = fs.readFileSync(file, "utf8");
    expect(text).not.toContain("old text");
    expect(text.split(INSTRUCTIONS_BEGIN)).toHaveLength(2);
    expect(text.startsWith("intro\n\n")).toBe(true);
    expect(text.endsWith("\n\nouttro\n")).toBe(true);
  });

  it("owns a whole always-apply rule file for Cursor", () => {
    mk(".cursor");
    const out = writeInstructionBlocks();
    const cursor = out.find((r) => r.id === "cursor")!;
    expect(cursor.status).toBe("wrote");
    expect(cursor.file).toBe(path.join(tmp, ".cursor", "rules", "metahub.mdc"));
    const text = fs.readFileSync(cursor.file, "utf8");
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toContain("alwaysApply: true");
    expect(text).toContain(INSTRUCTIONS_BEGIN);
  });

  it("targets opencode, Goose and Windsurf at their documented files", () => {
    mk(".config", "opencode");
    mk(".config", "goose");
    mk(".codeium", "windsurf");
    const out = writeInstructionBlocks();
    expect(out.find((r) => r.id === "opencode")?.file).toBe(
      path.join(tmp, ".config", "opencode", "AGENTS.md"),
    );
    expect(out.find((r) => r.id === "goose")?.file).toBe(
      path.join(tmp, ".config", "goose", ".goosehints"),
    );
    expect(out.find((r) => r.id === "windsurf")?.file).toBe(
      path.join(tmp, ".codeium", "windsurf", "memories", "global_rules.md"),
    );
    for (const id of ["opencode", "goose", "windsurf"]) {
      expect(out.find((r) => r.id === id)?.status, id).toBe("wrote");
    }
  });

  it("refuses to push Windsurf's global rules past its size limit", () => {
    mk(".codeium", "windsurf", "memories");
    const file = path.join(tmp, ".codeium", "windsurf", "memories", "global_rules.md");
    fs.writeFileSync(file, "x".repeat(5500));
    const out = writeInstructionBlocks();
    expect(out.find((r) => r.id === "windsurf")?.status).toBe("skipped-too-large");
    expect(fs.readFileSync(file, "utf8")).toBe("x".repeat(5500));
  });
});

describe("removeInstructionBlocks", () => {
  it("strips the block and leaves the user's text exactly as it was", () => {
    mk(".gemini");
    const file = path.join(tmp, ".gemini", "GEMINI.md");
    const original = "# My rules\n\nAlways use pnpm.\n";
    fs.writeFileSync(file, original);
    writeInstructionBlocks();
    const out = removeInstructionBlocks();
    expect(out.find((r) => r.id === "gemini")?.status).toBe("removed");
    expect(fs.readFileSync(file, "utf8")).toBe(original);
  });

  it("deletes a file that held nothing but the block, and the Cursor rule file", () => {
    mk(".claude");
    mk(".cursor");
    writeInstructionBlocks();
    removeInstructionBlocks();
    expect(fs.existsSync(path.join(tmp, ".claude", "CLAUDE.md"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, ".cursor", "rules", "metahub.mdc"))).toBe(false);
  });

  it("reports absent when there is nothing to remove", () => {
    mk(".claude");
    const out = removeInstructionBlocks();
    expect(out.find((r) => r.id === "claude-code")?.status).toBe("absent");
  });
});

describe("instructionStatus", () => {
  it("distinguishes present, stale, absent and not-detected", () => {
    mk(".claude");
    mk(".codex");
    fs.writeFileSync(
      path.join(tmp, ".codex", "AGENTS.md"),
      `${INSTRUCTIONS_BEGIN}\nold\n${INSTRUCTIONS_END}\n`,
    );
    let rows = instructionStatus();
    expect(rows.find((r) => r.id === "claude-code")?.state).toBe("absent");
    expect(rows.find((r) => r.id === "codex-cli")?.state).toBe("stale");
    expect(rows.find((r) => r.id === "gemini")?.state).toBe("not-detected");
    writeInstructionBlocks();
    rows = instructionStatus();
    expect(rows.find((r) => r.id === "claude-code")?.state).toBe("present");
    expect(rows.find((r) => r.id === "codex-cli")?.state).toBe("present");
  });
});
