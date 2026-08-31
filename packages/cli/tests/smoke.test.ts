import { describe, it, expect } from "vitest";

describe("@metahub-ai/mh", () => {
  it("package metadata is parseable", async () => {
    const pkg = await import("../package.json", { with: { type: "json" } });
    expect(pkg.default.name).toBe("@metahub-ai/mh");
    expect(pkg.default.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
