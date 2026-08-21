/**
 * Tests for related-skill discovery — reading a repo's
 * `.claude-plugin/marketplace.json` / `plugin.json` to find the
 * sibling skills that ship with the requested one (the
 * aurora-smart-home shape from
 * https://github.com/metahub-ai/metahub-cli/issues/1).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findRelatedSkills } from "../src/related-skills";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-related-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeSkill(rel: string, body = "# skill"): string {
  const dir = path.join(tmp, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), body);
  return dir;
}

function writeMarketplace(plugins: unknown[]): void {
  fs.mkdirSync(path.join(tmp, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, ".claude-plugin", "marketplace.json"),
    JSON.stringify({ name: "test-marketplace", plugins }),
  );
}

describe("findRelatedSkills", () => {
  it("returns the declared siblings for an aurora-shaped repo (source at repo root)", () => {
    writeSkill("aurora");
    writeSkill("esphome");
    writeSkill("home-assistant");
    writeSkill("node-red");
    fs.mkdirSync(path.join(tmp, "commands"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "commands", "aurora.md"), "# command");
    fs.writeFileSync(path.join(tmp, "README.md"), "# repo");
    writeMarketplace([
      {
        name: "aurora",
        source: "./",
        skills: ["./home-assistant", "./esphome", "./node-red", "./commands"],
      },
    ]);

    const related = findRelatedSkills(tmp, "aurora");
    expect(related.map((r) => r.slug).sort()).toEqual(["esphome", "home-assistant", "node-red"]);
    // The installed skill itself and non-skill directories are excluded.
    expect(related.map((r) => r.relPath)).not.toContain("aurora");
    expect(related.map((r) => r.relPath)).not.toContain("commands");
    // sourceDir points inside the extracted repo.
    expect(related[0]?.sourceDir.startsWith(tmp)).toBe(true);
  });

  it("returns [] when there is no .claude-plugin/marketplace.json", () => {
    writeSkill("aurora");
    writeSkill("esphome");
    expect(findRelatedSkills(tmp, "aurora")).toEqual([]);
  });

  it("adds the conventional skills/ directory to custom paths for repo-root sources", () => {
    writeSkill("aurora");
    writeSkill("esphome");
    writeSkill("skills/conventional");
    writeMarketplace([{ name: "aurora", source: "./", skills: ["./esphome"] }]);

    const related = findRelatedSkills(tmp, "aurora");
    expect(related.map((r) => r.slug).sort()).toEqual(["conventional", "esphome"]);
  });

  it("adds the default skills/ scan to the array for non-root sources", () => {
    writeSkill("plugin/orchestrator");
    writeSkill("plugin/declared");
    writeSkill("plugin/skills/scanned");
    writeMarketplace([{ name: "plugin", source: "./plugin", skills: ["./plugin/declared"] }]);

    const related = findRelatedSkills(tmp, "plugin/orchestrator");
    expect(related.map((r) => r.slug).sort()).toEqual(["declared", "scanned"]);
  });

  it("returns [] for a sibling with no SKILL.md", () => {
    writeSkill("aurora");
    fs.mkdirSync(path.join(tmp, "esphome"), { recursive: true });
    writeMarketplace([{ name: "aurora", source: "./", skills: ["./esphome"] }]);
    expect(findRelatedSkills(tmp, "aurora")).toEqual([]);
  });

  it("ignores plugins whose source does not contain the installed skill", () => {
    writeSkill("plugin-a/orchestrator");
    writeSkill("plugin-a/alpha");
    writeSkill("standalone/other");
    writeMarketplace([
      { name: "a", source: "./plugin-a", skills: ["./plugin-a/alpha"] },
      { name: "b", source: "./standalone", skills: ["./standalone/other"] },
    ]);

    // plugin-b's source (./standalone) does not contain the installed
    // skill, so only plugin-a's sibling comes back.
    const related = findRelatedSkills(tmp, "plugin-a/orchestrator");
    expect(related.map((r) => r.slug)).toEqual(["alpha"]);
  });

  it("uses the most specific plugin source for nested marketplace layouts", () => {
    writeSkill("plugins/parent/orchestrator");
    writeSkill("plugins/parent/parent-helper");
    writeSkill("plugins/parent/child/orchestrator");
    writeSkill("plugins/parent/child/child-helper");
    writeMarketplace([
      {
        name: "parent",
        source: "./plugins/parent",
        skills: "./parent-helper",
      },
      {
        name: "child",
        source: "./plugins/parent/child",
        skills: "./child-helper",
      },
    ]);

    const related = findRelatedSkills(tmp, "plugins/parent/child/orchestrator");
    expect(related.map((r) => r.slug)).toEqual(["child-helper"]);
  });

  it("resolves skills[] entries written relative to the plugin source", () => {
    writeSkill("bundle/orchestrator");
    writeSkill("bundle/skills/alpha");
    writeSkill("bundle/skills/beta");
    writeMarketplace([
      { name: "bundle", source: "./bundle", skills: ["./skills/alpha", "./skills/beta"] },
    ]);

    const related = findRelatedSkills(tmp, "bundle/orchestrator");
    expect(related.map((r) => r.relPath).sort()).toEqual([
      "bundle/skills/alpha",
      "bundle/skills/beta",
    ]);
  });

  it("falls back to scanning <source>/skills/ when no skills array is declared", () => {
    writeSkill("plugin/orchestrator");
    writeSkill("plugin/skills/alpha");
    writeSkill("plugin/skills/beta");
    fs.mkdirSync(path.join(tmp, "plugin", "skills", "not-a-skill"), { recursive: true });
    writeMarketplace([{ name: "plugin", source: "./plugin" }]);

    const related = findRelatedSkills(tmp, "plugin/orchestrator");
    expect(related.map((r) => r.slug).sort()).toEqual(["alpha", "beta"]);
  });

  it("supports .claude-plugin/plugin.json skills arrays (added to the default scan)", () => {
    writeSkill("orchestrator");
    writeSkill("alpha");
    writeSkill("skills/scanned");
    fs.mkdirSync(path.join(tmp, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "bundle", skills: ["./alpha"] }),
    );

    const related = findRelatedSkills(tmp, "orchestrator");
    expect(related.map((r) => r.slug).sort()).toEqual(["alpha", "scanned"]);
  });

  it("supports a string skills field that names one deeply nested skill", () => {
    writeSkill("packages/reviewer/orchestrator");
    writeSkill("packages/reviewer/components/deep/linter");
    writeMarketplace([
      {
        name: "reviewer",
        source: "./packages/reviewer",
        skills: "./components/deep/linter",
      },
    ]);

    const related = findRelatedSkills(tmp, "packages/reviewer/orchestrator");
    expect(related.map((r) => r.relPath)).toEqual(["packages/reviewer/components/deep/linter"]);
  });

  it("supports a custom skills container at any depth", () => {
    writeSkill("plugins/quality/orchestrator");
    writeSkill("plugins/quality/custom/deep/skills/security");
    writeSkill("plugins/quality/custom/deep/skills/performance");
    writeMarketplace([
      {
        name: "quality",
        source: "./plugins/quality",
        skills: "./custom/deep/skills",
      },
    ]);

    const related = findRelatedSkills(tmp, "plugins/quality/orchestrator");
    expect(related.map((r) => r.slug).sort()).toEqual(["performance", "security"]);
  });

  it("scans conventional skills for plugin.json even when skills is omitted", () => {
    writeSkill("orchestrator");
    writeSkill("skills/alpha");
    writeSkill("skills/beta");
    fs.mkdirSync(path.join(tmp, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "bundle" }),
    );

    const related = findRelatedSkills(tmp, "orchestrator");
    expect(related.map((r) => r.slug).sort()).toEqual(["alpha", "beta"]);
  });

  it("merges a nested plugin.json with its marketplace source", () => {
    writeSkill("plugins/quality/orchestrator");
    writeSkill("plugins/quality/extra/advisor");
    writeSkill("plugins/quality/skills/conventional");
    fs.mkdirSync(path.join(tmp, "plugins/quality/.claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "plugins/quality/.claude-plugin/plugin.json"),
      JSON.stringify({ name: "quality", skills: "./extra/advisor" }),
    );
    writeMarketplace([{ name: "quality", source: "./plugins/quality" }]);

    const related = findRelatedSkills(tmp, "plugins/quality/orchestrator");
    expect(related.map((r) => r.slug).sort()).toEqual(["advisor", "conventional"]);
  });

  it("honors marketplace metadata.pluginRoot", () => {
    writeSkill("extensions/reviewer/orchestrator");
    writeSkill("extensions/reviewer/skills/linter");
    fs.mkdirSync(path.join(tmp, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        metadata: { pluginRoot: "./extensions" },
        plugins: [{ name: "reviewer", source: "./reviewer" }],
      }),
    );

    const related = findRelatedSkills(tmp, "extensions/reviewer/orchestrator");
    expect(related.map((r) => r.relPath)).toEqual(["extensions/reviewer/skills/linter"]);
  });

  it("keeps multiple root-sourced marketplace plugins isolated", () => {
    writeSkill("reviewer");
    writeSkill("deployer");
    writeSkill("review-helper");
    writeSkill("deploy-helper");
    writeMarketplace([
      { name: "reviewer", source: "./", skills: "./review-helper" },
      { name: "deployer", source: "./", skills: "./deploy-helper" },
    ]);

    expect(findRelatedSkills(tmp, "reviewer").map((r) => r.slug)).toEqual(["review-helper"]);
    expect(findRelatedSkills(tmp, "deployer").map((r) => r.slug)).toEqual(["deploy-helper"]);
  });

  it("ignores marketplace plugins whose source is external", () => {
    writeSkill("orchestrator");
    writeSkill("should-not-install");
    writeMarketplace([
      {
        name: "external",
        source: { source: "github", repo: "example/external" },
        skills: "./should-not-install",
      },
    ]);

    expect(findRelatedSkills(tmp, "orchestrator")).toEqual([]);
  });

  it("works when the installed skill is the repo root (empty repoPath)", () => {
    fs.writeFileSync(path.join(tmp, "SKILL.md"), "# root skill");
    writeSkill("helper");
    writeMarketplace([{ name: "bundle", source: "./", skills: ["./helper"] }]);

    const related = findRelatedSkills(tmp, "");
    expect(related.map((r) => r.slug)).toEqual(["helper"]);
  });

  it("ignores traversal and dot entries in the skills array", () => {
    writeSkill("aurora");
    writeSkill("outside");
    writeMarketplace([{ name: "aurora", source: "./", skills: ["..", ".", "./.."] }]);

    expect(findRelatedSkills(tmp, "aurora")).toEqual([]);
  });

  it("ignores traversal in marketplace source and pluginRoot paths", () => {
    writeSkill("aurora");
    writeSkill("helper");
    fs.mkdirSync(path.join(tmp, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        metadata: { pluginRoot: "../outside" },
        plugins: [{ name: "aurora", source: "./", skills: "./helper" }],
      }),
    );
    expect(findRelatedSkills(tmp, "aurora")).toEqual([]);

    writeMarketplace([{ name: "aurora", source: "../outside", skills: "./helper" }]);
    expect(findRelatedSkills(tmp, "aurora")).toEqual([]);
  });

  it("deduplicates skills declared by multiple plugins", () => {
    writeSkill("aurora");
    writeSkill("esphome");
    writeMarketplace([
      { name: "a", source: "./", skills: ["./aurora", "./esphome"] },
      { name: "b", source: "./", skills: ["./aurora", "./esphome"] },
    ]);

    const related = findRelatedSkills(tmp, "aurora");
    expect(related.map((r) => r.slug)).toEqual(["esphome"]);
  });

  it("deduplicates different paths that would share an install slug", () => {
    writeSkill("orchestrator");
    writeSkill("custom/alpha/helper");
    writeSkill("custom/beta/helper");
    writeMarketplace([
      {
        name: "orchestrator",
        source: "./",
        skills: ["./custom/alpha/helper", "./custom/beta/helper"],
      },
    ]);

    const related = findRelatedSkills(tmp, "orchestrator");
    expect(related).toHaveLength(1);
    expect(related[0]?.slug).toBe("helper");
  });

  it("returns [] when the marketplace.json is malformed JSON", () => {
    writeSkill("aurora");
    fs.mkdirSync(path.join(tmp, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".claude-plugin", "marketplace.json"), "{not json");
    expect(findRelatedSkills(tmp, "aurora")).toEqual([]);
  });
});
