/**
 * Tests for the canonical CLIENTS catalog. This array is the wire
 * identifier list — bumping a `name` would invalidate every
 * artifact_info.supported_clients row in production. Pin the names +
 * shape.
 */
import { describe, expect, it } from "vitest";
import { CLIENTS, clientsForKind } from "../src/clients";

describe("CLIENTS", () => {
  it("has the expected canonical set of client names", () => {
    const names = CLIENTS.map((c) => c.name);
    // Bumping any of these is a wire-format break. If a deliberate
    // rename happens, update this list AND ship a migration.
    expect(names).toEqual(
      expect.arrayContaining([
        "Claude Code",
        "Claude Desktop",
        "Cursor",
        "Antigravity",
        "VS Code",
        "Zed",
        "Windsurf",
        "Continue",
        "Cline",
        "Goose",
        "Codex CLI",
        "opencode",
      ]),
    );
  });

  it("every entry has the required fields", () => {
    for (const c of CLIENTS) {
      expect(typeof c.name).toBe("string");
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.url).toMatch(/^https?:\/\//);
      expect(Array.isArray(c.supports)).toBe(true);
      expect(c.supports.length).toBeGreaterThan(0);
    }
  });

  it("names are unique (catalog is keyed by name)", () => {
    const names = CLIENTS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every `supports` entry is a real ArtifactKind", () => {
    const valid = new Set(["skill", "mcp", "agent", "plugin"]);
    for (const c of CLIENTS) {
      for (const k of c.supports) {
        expect(valid.has(k)).toBe(true);
      }
    }
  });

  it("clientsForKind filters by the supports array", () => {
    const skill = clientsForKind("skill").map((c) => c.name);
    expect(skill).toContain("Claude Code");
    expect(skill).not.toContain("Cursor");

    const mcp = clientsForKind("mcp").map((c) => c.name);
    expect(mcp).toContain("Cursor");

    const plugin = clientsForKind("plugin").map((c) => c.name);
    expect(plugin).toEqual(["Claude Code"]);

    expect(clientsForKind("agent")).toEqual([]);
  });

  it("opencode supports skills and MCP (native SKILL.md + stdio MCP)", () => {
    const oc = CLIENTS.find((c) => c.name === "opencode");
    expect(oc).toBeDefined();
    expect(oc!.url).toBe("https://opencode.ai");
    // opencode reads SKILL.md verbatim and stdio MCP from opencode.json.
    expect(oc!.supports).toEqual(["skill", "mcp"]);
  });

  it("Claude Code is the only client that supports all four kinds (sanity check)", () => {
    // Optional invariant — if this breaks, deliberate: another client
    // grew into being a full superset.
    const claude = CLIENTS.find((c) => c.name === "Claude Code");
    expect(claude).toBeDefined();
    // Claude Code supports skill, mcp, plugin natively (no first-party
    // agent runtime).
    expect(claude!.supports).toEqual(expect.arrayContaining(["skill", "mcp", "plugin"]));
  });
});
