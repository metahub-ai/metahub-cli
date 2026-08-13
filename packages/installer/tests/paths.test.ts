/**
 * Tests for the installer's path helpers — they decide where the
 * installer puts every file on the user's machine.
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import {
  claudeSettingsFile,
  configFile,
  configRoot,
  installPathFor,
  installsFile,
} from "../src/paths";

const HOME = os.homedir();

describe("configRoot", () => {
  it("lives under the user's home directory in `.metahub`", () => {
    expect(configRoot()).toBe(path.join(HOME, ".metahub"));
  });
});

describe("configFile / installsFile", () => {
  it("config.json sits under configRoot()", () => {
    expect(configFile()).toBe(path.join(HOME, ".metahub", "config.json"));
  });

  it("installs.json sits under configRoot()", () => {
    expect(installsFile()).toBe(path.join(HOME, ".metahub", "installs.json"));
  });
});

describe("installPathFor", () => {
  it("skills land under ~/.claude/skills/<slug>", () => {
    expect(installPathFor("skill", "pdf")).toBe(path.join(HOME, ".claude", "skills", "pdf"));
  });

  it("plugins land under ~/.claude/plugins/<slug>", () => {
    expect(installPathFor("plugin", "frontend-kit")).toBe(
      path.join(HOME, ".claude", "plugins", "frontend-kit"),
    );
  });

  it("agents land under ~/.metahub/agents/<slug> (Node consumers, not Claude Code)", () => {
    expect(installPathFor("agent", "reviewer")).toBe(
      path.join(HOME, ".metahub", "agents", "reviewer"),
    );
  });

  it("mcp creates a metadata folder under ~/.metahub/mcp/<slug> so `mh list` works", () => {
    expect(installPathFor("mcp", "filesystem")).toBe(
      path.join(HOME, ".metahub", "mcp", "filesystem"),
    );
  });
});

describe("claudeSettingsFile", () => {
  it("points at ~/.claude/settings.json", () => {
    expect(claudeSettingsFile()).toBe(path.join(HOME, ".claude", "settings.json"));
  });
});
