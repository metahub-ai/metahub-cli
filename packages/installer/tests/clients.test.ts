/**
 * Tests for the multi-client MCP wiring adapter list. Pins the
 * interface contract and the "every promised client has an adapter"
 * invariant.
 */
import { describe, expect, it } from "vitest";
import { CLIENT_ADAPTERS } from "../src/clients";

const EXPECTED_NAMES = [
  "Claude Code",
  "Claude Desktop",
  "Cursor",
  "Antigravity",
  "Windsurf",
  "Cline",
  "Continue",
  "Zed",
  "Goose",
  "Codex CLI",
  "VS Code",
  "opencode",
];

describe("CLIENT_ADAPTERS", () => {
  it("includes every client the registry catalog promises", () => {
    const names = CLIENT_ADAPTERS.map((a) => a.name);
    for (const expected of EXPECTED_NAMES) {
      expect(names).toContain(expected);
    }
  });

  it("every entry implements the ClientAdapter interface", () => {
    for (const a of CLIENT_ADAPTERS) {
      expect(typeof a.name).toBe("string");
      expect(typeof a.detect).toBe("function");
      expect(typeof a.configPath).toBe("function");
      expect(typeof a.wire).toBe("function");
      expect(typeof a.unwire).toBe("function");
    }
  });

  it("configPath() returns a non-empty string for each adapter", () => {
    for (const a of CLIENT_ADAPTERS) {
      const p = a.configPath();
      expect(typeof p).toBe("string");
      expect(p.length).toBeGreaterThan(0);
    }
  });

  it("adapter names are unique", () => {
    const names = CLIENT_ADAPTERS.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
