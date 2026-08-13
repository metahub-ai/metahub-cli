/**
 * Tests for `metahub_get` — pure lookup, null on miss.
 */
import { describe, expect, it } from "vitest";
import { getItem } from "../src/tools/get";
import { installCommand, kindSegment } from "../src/tools/install-command";
import type { RegistryItem } from "../src/types";

const CATALOG: RegistryItem[] = [
  {
    slug: "pdf",
    kind: "skill",
    name: "PDF Skill",
    tagline: "Read PDFs",
    description: "x",
    tags: [],
    author: { handle: "alice", name: "Alice" },
    source: { type: "github", url: "https://github.com/alice/pdf" },
    updatedAt: "2026-01-01T00:00:00Z",
  },
  {
    slug: "pdf",
    kind: "mcp",
    name: "PDF MCP",
    tagline: "Serve PDFs",
    description: "y",
    tags: [],
    author: { handle: "bob", name: "Bob" },
    source: { type: "github", url: "https://github.com/bob/pdf" },
    updatedAt: "2026-01-01T00:00:00Z",
  },
];

describe("getItem", () => {
  it("returns the matching artifact", () => {
    const found = getItem(CATALOG, { kind: "skill", slug: "pdf" });
    expect(found?.name).toBe("PDF Skill");
  });

  it("disambiguates by kind when slugs collide", () => {
    const found = getItem(CATALOG, { kind: "mcp", slug: "pdf" });
    expect(found?.name).toBe("PDF MCP");
  });

  it("returns null when nothing matches", () => {
    expect(getItem(CATALOG, { kind: "skill", slug: "nope" })).toBeNull();
  });
});

describe("installCommand", () => {
  it("uses the plural kind segment", () => {
    expect(kindSegment("skill")).toBe("skills");
    expect(kindSegment("mcp")).toBe("mcps");
    expect(kindSegment("agent")).toBe("agents");
    expect(kindSegment("plugin")).toBe("plugins");
  });

  it("formats the mh install command", () => {
    const { command } = installCommand({ kind: "skill", slug: "pdf" });
    expect(command).toBe("mh install skills/pdf");
  });

  it("includes a one-line user-facing tip", () => {
    const { tip } = installCommand({ kind: "plugin", slug: "babysit-prs" });
    expect(tip).toContain("mh install plugins/babysit-prs");
    expect(tip.toLowerCase()).toContain("plugin");
  });
});
