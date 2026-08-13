import { describe, expect, it } from "vitest";
import {
  CATEGORIES,
  OTHER_CATEGORY,
  categoryBySlug,
  categoryName,
  isOfficialOwner,
} from "../src/categories.js";

describe("category taxonomy", () => {
  it("has unique, url-safe slugs and lowercase keywords", () => {
    const slugs = CATEGORIES.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const c of CATEGORIES) {
      expect(c.slug).toMatch(/^[a-z0-9-]+$/);
      expect(c.slug).not.toBe(OTHER_CATEGORY);
      expect(c.name.length).toBeGreaterThan(3);
      expect(c.blurb.length).toBeGreaterThan(10);
      expect(c.keywords.length).toBeGreaterThan(3);
      for (const k of c.keywords) expect(k).toBe(k.toLowerCase());
    }
  });

  it("resolves slugs to defs and names", () => {
    expect(categoryBySlug("coding")?.name).toBe("Coding & Refactoring");
    expect(categoryBySlug("nope")).toBeNull();
    expect(categoryName("devops")).toBe("DevOps & Cloud");
    expect(categoryName(OTHER_CATEGORY)).toBe("Other");
    expect(categoryName(null)).toBe("Other");
    // Legacy free-form values prettify instead of 404ing visually.
    expect(categoryName("some_legacy-value")).toBe("Some Legacy Value");
  });

  it("matches official owners case-insensitively", () => {
    expect(isOfficialOwner("anthropics")).toBe(true);
    expect(isOfficialOwner("Anthropics")).toBe(true);
    expect(isOfficialOwner("modelcontextprotocol")).toBe(true);
    expect(isOfficialOwner("random-dev")).toBe(false);
    expect(isOfficialOwner(null)).toBe(false);
    expect(isOfficialOwner("")).toBe(false);
  });
});
