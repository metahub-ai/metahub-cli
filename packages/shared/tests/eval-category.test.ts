/**
 * Tests for the EvalCheckCategory taxonomy + categoryForCheckId mapping.
 * The portal's eval-job runner and the registry / portal UIs both
 * depend on this mapping landing checks in the right bucket — this
 * test pins the contract so neither side drifts.
 */
import { describe, expect, it } from "vitest";
import {
  EVAL_CATEGORY_LABEL,
  EVAL_CATEGORY_ORDER,
  categoryForCheckId,
  type EvalCheckCategory,
} from "../src/eval";

describe("categoryForCheckId", () => {
  const cases: Array<[string, EvalCheckCategory]> = [
    ["repo-reachable", "structural"],
    ["manifest-found", "structural"],
    ["slug-format", "structural"],
    ["slug-unique", "structural"],
    ["version-format", "structural"],
    ["description-length", "documentation"],
    ["readme-present", "documentation"],
    ["license-present", "safety"],
    ["no-sensitive-files", "safety"],
    ["skill-md-present", "kind-specific"],
    ["skill-body", "kind-specific"],
    ["skill-triggers", "kind-specific"],
    ["skill-allowed-tools", "kind-specific"],
    ["mcp-launch", "kind-specific"],
    ["mcp-sdk", "kind-specific"],
    ["mcp-esm", "kind-specific"],
    ["mcp-tools", "kind-specific"],
    ["mcp-surface", "kind-specific"],
    ["agent-entry", "kind-specific"],
    ["agent-model", "kind-specific"],
    ["agent-tools", "kind-specific"],
    ["plugin-manifest", "kind-specific"],
    ["plugin-bundle", "kind-specific"],
    ["plugin-bundle-shape", "kind-specific"],
    ["plugin-manifest-location", "kind-specific"],
    ["tags-declared", "documentation"],
    ["examples-present", "documentation"],
    ["homepage-declared", "documentation"],
    ["last-commit-recency", "maintenance"],
    ["has-tests", "maintenance"],
    ["has-ci", "maintenance"],
    ["version-matches-release", "maintenance"],
  ];
  for (const [id, expected] of cases) {
    it(`${id} → ${expected}`, () => {
      expect(categoryForCheckId(id)).toBe(expected);
    });
  }
  it("unknown id falls back to kind-specific so new checks render somewhere", () => {
    expect(categoryForCheckId("brand-new-check-2027")).toBe("kind-specific");
  });
});

describe("EVAL_CATEGORY_ORDER + LABEL", () => {
  it("orders the categories the UI renders them in", () => {
    expect(EVAL_CATEGORY_ORDER).toEqual([
      "structural",
      "documentation",
      "safety",
      "kind-specific",
      "maintenance",
      "behavioral",
    ]);
  });
  it("has a label for every category in the union", () => {
    for (const cat of EVAL_CATEGORY_ORDER) {
      expect(EVAL_CATEGORY_LABEL[cat]).toBeTruthy();
    }
  });
});
