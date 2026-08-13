/**
 * Tests for the path helpers — they decide where the auth state lives.
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import { configFile, configRoot } from "../src/paths";

const HOME = os.homedir();

describe("configRoot", () => {
  it("lives under the user's home directory in `.metahub`", () => {
    expect(configRoot()).toBe(path.join(HOME, ".metahub"));
  });
});

describe("configFile", () => {
  it("config.json sits under configRoot()", () => {
    expect(configFile()).toBe(path.join(HOME, ".metahub", "config.json"));
  });
});
