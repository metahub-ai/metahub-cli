/**
 * Sanity tests on the badge catalog itself. The catalog is data, so
 * the tests pin shape — no orphan IDs, every entry has the required
 * fields, kind-specific badges only show up for the right kind, and
 * the priority order is deterministic.
 */
import { describe, expect, it } from "vitest";
import {
  BADGES_BY_ID,
  BADGE_CATALOG,
  badgesForKind,
  sortBadgesByPriority,
  type BadgeId,
} from "../src/badges";

describe("BADGE_CATALOG", () => {
  it("every entry has the required fields", () => {
    for (const def of BADGE_CATALOG) {
      expect(def.id).toMatch(/^[a-z0-9-]+$/);
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.criterion.length).toBeGreaterThan(0);
      expect(def.remediation.length).toBeGreaterThan(0);
      expect(["trust", "maintenance", "documentation", "structure", "adoption"]).toContain(
        def.category,
      );
      expect(Array.isArray(def.appliesTo)).toBe(true);
    }
  });

  it("has no duplicate IDs", () => {
    const ids = BADGE_CATALOG.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("BADGES_BY_ID covers every catalog entry", () => {
    for (const def of BADGE_CATALOG) {
      expect(BADGES_BY_ID[def.id]).toBe(def);
    }
  });
});

describe("badgesForKind", () => {
  it("returns universal + kind-specific badges only", () => {
    const skill = badgesForKind("skill");
    // Universal ones (appliesTo: []) come back…
    expect(skill.map((b) => b.id)).toContain("verified-publisher");
    expect(skill.map((b) => b.id)).toContain("licensed");
    // …and skill-specific…
    expect(skill.map((b) => b.id)).toContain("trigger-explicit");
    // …but not MCP-specific.
    expect(skill.map((b) => b.id)).not.toContain("mcp-sdk");
    expect(skill.map((b) => b.id)).not.toContain("multi-skill");
  });

  it("MCP returns mcp-specific, not skill-specific", () => {
    const mcp = badgesForKind("mcp");
    expect(mcp.map((b) => b.id)).toContain("mcp-sdk");
    expect(mcp.map((b) => b.id)).toContain("tool-catalog");
    expect(mcp.map((b) => b.id)).not.toContain("trigger-explicit");
  });

  it("agent gets agent-specific badges only", () => {
    const agent = badgesForKind("agent");
    expect(agent.map((b) => b.id)).toContain("entry-declared");
    expect(agent.map((b) => b.id)).toContain("model-pinned");
    expect(agent.map((b) => b.id)).not.toContain("multi-skill");
    expect(agent.map((b) => b.id)).not.toContain("mcp-sdk");
  });

  it("plugin gets plugin-specific badges only", () => {
    const plugin = badgesForKind("plugin");
    expect(plugin.map((b) => b.id)).toContain("multi-skill");
    expect(plugin.map((b) => b.id)).toContain("hooks-declared");
    expect(plugin.map((b) => b.id)).not.toContain("trigger-explicit");
  });
});

describe("sortBadgesByPriority", () => {
  it("places high-impact badges before low-impact ones", () => {
    const sorted = sortBadgesByPriority([
      "clean-repo",
      "battle-tested",
      "licensed",
      "verified-publisher",
    ]);
    // battle-tested has the highest priority in the table; clean-repo
    // sits near the bottom. Whatever the exact ranking, battle-tested
    // must come before clean-repo.
    expect(sorted.indexOf("battle-tested" as BadgeId)).toBeLessThan(
      sorted.indexOf("clean-repo" as BadgeId),
    );
    expect(sorted.indexOf("verified-publisher" as BadgeId)).toBeLessThan(
      sorted.indexOf("clean-repo" as BadgeId),
    );
  });

  it("is stable + non-mutating on the input", () => {
    const input: BadgeId[] = ["licensed", "battle-tested"];
    const copy = [...input];
    sortBadgesByPriority(input);
    expect(input).toEqual(copy);
  });

  it("returns an empty array unchanged", () => {
    expect(sortBadgesByPriority([])).toEqual([]);
  });

  it("treats badges missing from the priority table as lowest (priority=0)", () => {
    // Cast to BadgeId so TS lets the unknown ID through. The fallback
    // path is what protects us from a future BadgeId being added to the
    // enum without a priority entry. Run both orderings so both
    // `?? 0` branches in the comparator are exercised.
    const a = sortBadgesByPriority([
      "battle-tested" as BadgeId,
      "fake-not-real" as unknown as BadgeId,
    ]);
    expect(a[0]).toBe("battle-tested");
    const b = sortBadgesByPriority([
      "fake-not-real" as unknown as BadgeId,
      "battle-tested" as BadgeId,
    ]);
    expect(b[0]).toBe("battle-tested");
    const both = sortBadgesByPriority([
      "fake-one" as unknown as BadgeId,
      "fake-two" as unknown as BadgeId,
    ]);
    expect(both).toHaveLength(2);
  });
});
