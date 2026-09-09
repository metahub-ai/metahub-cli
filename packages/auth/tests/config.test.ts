/**
 * Tests for the persisted auth/portal config. We redirect HOME to a tmp
 * dir so the test never touches the dev's real ~/.metahub/config.json.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_REGISTRY_URL,
  explicitRegistryUrl,
  loadAuthConfig,
  saveAuthConfig,
} from "../src/config";

let tmpHome: string;
let origHome: string | undefined;
let origUserProfile: string | undefined;
let origPortal: string | undefined;
let origRegistry: string | undefined;
let origServiceToken: string | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
  origUserProfile = process.env.USERPROFILE;
  origPortal = process.env.METAHUB_PORTAL_URL;
  origRegistry = process.env.METAHUB_REGISTRY_URL;
  origServiceToken = process.env.METAHUB_SERVICE_TOKEN;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "mh-auth-test-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  delete process.env.METAHUB_PORTAL_URL;
  delete process.env.METAHUB_REGISTRY_URL;
  delete process.env.METAHUB_SERVICE_TOKEN;
});

afterEach(() => {
  process.env.HOME = origHome;
  process.env.USERPROFILE = origUserProfile;
  if (origPortal === undefined) delete process.env.METAHUB_PORTAL_URL;
  else process.env.METAHUB_PORTAL_URL = origPortal;
  if (origRegistry === undefined) delete process.env.METAHUB_REGISTRY_URL;
  else process.env.METAHUB_REGISTRY_URL = origRegistry;
  if (origServiceToken === undefined) delete process.env.METAHUB_SERVICE_TOKEN;
  else process.env.METAHUB_SERVICE_TOKEN = origServiceToken;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("loadAuthConfig", () => {
  it("returns built-in defaults when no config file exists", () => {
    const cfg = loadAuthConfig();
    expect(cfg.portalUrl).toBe("https://developer.metahub.ai");
    expect(cfg.registryUrl).toBe("https://registry.metahub.ai");
    expect(cfg.sessionToken).toBeUndefined();
  });

  it("honours saved overrides for portal/registry URLs", () => {
    saveAuthConfig({ portalUrl: "http://localhost:4321", registryUrl: "http://localhost:3000" });
    const cfg = loadAuthConfig();
    expect(cfg.portalUrl).toBe("http://localhost:4321");
    expect(cfg.registryUrl).toBe("http://localhost:3000");
  });

  it("merges a partial saved file over defaults", () => {
    fs.mkdirSync(path.join(tmpHome, ".metahub"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, ".metahub", "config.json"),
      JSON.stringify({ sessionToken: "tok_xyz" }),
    );
    const cfg = loadAuthConfig();
    expect(cfg.sessionToken).toBe("tok_xyz");
    expect(cfg.portalUrl).toBe("https://developer.metahub.ai");
  });

  it("treats a malformed JSON file as no-config (falls back to defaults)", () => {
    fs.mkdirSync(path.join(tmpHome, ".metahub"), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, ".metahub", "config.json"), "not json {{");
    const cfg = loadAuthConfig();
    expect(cfg.portalUrl).toBe("https://developer.metahub.ai");
  });
});

describe("saveAuthConfig", () => {
  it("writes the merged config to disk and returns it", () => {
    const out = saveAuthConfig({ sessionToken: "tok_1", telemetry: "no-handoff" });
    expect(out.sessionToken).toBe("tok_1");
    expect(out.telemetry).toBe("no-handoff");
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(tmpHome, ".metahub", "config.json"), "utf8"),
    );
    expect(onDisk.sessionToken).toBe("tok_1");
  });

  it("a second save merges with the existing file (does not clobber)", () => {
    saveAuthConfig({ sessionToken: "tok_1" });
    saveAuthConfig({ telemetry: "off" });
    const cfg = loadAuthConfig();
    expect(cfg.sessionToken).toBe("tok_1");
    expect(cfg.telemetry).toBe("off");
  });
});

describe("explicitRegistryUrl", () => {
  // `loadAuthConfig().registryUrl` is never empty — it always falls back to
  // DEFAULT_REGISTRY_URL. Callers that forward it downstream therefore cannot
  // tell a real override from the default, and `mh bootstrap` shipped exactly
  // that bug: it baked the registry *website* root into every wired client's
  // MCP env as though it were a catalog endpoint.
  it("returns undefined when the user chose nothing", () => {
    expect(explicitRegistryUrl()).toBeUndefined();
  });

  it("returns undefined when the persisted value is merely the default", () => {
    saveAuthConfig({ registryUrl: DEFAULT_REGISTRY_URL });
    expect(explicitRegistryUrl()).toBeUndefined();
  });

  it("returns undefined for an empty persisted value", () => {
    saveAuthConfig({ registryUrl: "" });
    expect(explicitRegistryUrl()).toBeUndefined();
  });

  it("returns a genuinely chosen persisted override", () => {
    saveAuthConfig({ registryUrl: "https://snapshot.example/registry.json" });
    expect(explicitRegistryUrl()).toBe("https://snapshot.example/registry.json");
  });

  it("prefers a fresh env override over the persisted value", () => {
    saveAuthConfig({ registryUrl: "https://persisted.example/registry.json" });
    process.env.METAHUB_REGISTRY_URL = "https://env.example/registry.json";
    expect(explicitRegistryUrl()).toBe("https://env.example/registry.json");
  });

  it("ignores an env override that is just the default", () => {
    process.env.METAHUB_REGISTRY_URL = DEFAULT_REGISTRY_URL;
    expect(explicitRegistryUrl()).toBeUndefined();
  });
});
