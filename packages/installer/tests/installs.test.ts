/**
 * Tests for the local install ledger. The installer reads/writes
 * ~/.metahub/installs.json on every install/uninstall/list, so a JSON
 * format change here is a wire break with previously-installed users.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findInstall,
  listInstalls,
  recordInstall,
  removeInstall,
  type InstalledRecord,
} from "../src/installs";

let tmpHome: string;
let origHome: string | undefined;
let origUserProfile: string | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
  origUserProfile = process.env.USERPROFILE;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "mh-installer-test-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  process.env.HOME = origHome;
  process.env.USERPROFILE = origUserProfile;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function rec(overrides: Partial<InstalledRecord> = {}): InstalledRecord {
  return {
    artifactId: "art_1",
    installId: "ins_1",
    slug: "pdf",
    kind: "skill",
    version: "0.1.0",
    installPath: path.join(tmpHome, ".claude", "skills", "pdf"),
    ingestApiKey: "mhi_abc",
    publishedSha: "deadbeef",
    installedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("listInstalls", () => {
  it("returns an empty array when there's no installs.json yet", () => {
    expect(listInstalls()).toEqual([]);
  });
});

describe("recordInstall", () => {
  it("persists a new record + round-trips through listInstalls", () => {
    recordInstall(rec());
    expect(listInstalls()).toHaveLength(1);
    expect(findInstall("skill", "pdf")?.artifactId).toBe("art_1");
  });

  it("re-recording the same (kind, slug) replaces the existing row", () => {
    recordInstall(rec());
    recordInstall(rec({ artifactId: "art_2", publishedSha: "newsha" }));
    const list = listInstalls();
    expect(list).toHaveLength(1);
    expect(list[0]?.artifactId).toBe("art_2");
    expect(list[0]?.publishedSha).toBe("newsha");
  });

  it("different (kind, slug) pairs coexist", () => {
    recordInstall(rec({ slug: "pdf", kind: "skill" }));
    recordInstall(rec({ slug: "pdf", kind: "mcp" }));
    expect(listInstalls()).toHaveLength(2);
  });
});

describe("removeInstall", () => {
  it("returns the removed row and disappears it from listInstalls", () => {
    recordInstall(rec());
    const removed = removeInstall("skill", "pdf");
    expect(removed?.slug).toBe("pdf");
    expect(listInstalls()).toEqual([]);
  });

  it("returns null when the install isn't present", () => {
    expect(removeInstall("skill", "nope")).toBeNull();
  });
});

describe("findInstall", () => {
  it("returns undefined for unknown installs", () => {
    expect(findInstall("skill", "nope")).toBeUndefined();
  });
});
