/**
 * Tests for the high-level orchestration in installArtifact /
 * uninstallArtifact / listInstalled. Fetches are mocked; we exercise
 * the wiring + ledger writes against a tmp HOME.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  installArtifact,
  listInstalled,
  uninstallArtifact,
  type InstallProgressEvent,
} from "../src/install";
import { saveAuthConfig } from "@metahub/auth";

const STATE_KEYS = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME"] as const;
const saved: Record<string, string | undefined> = {};
let tmp: string;
let origCwd: () => string;

beforeEach(() => {
  for (const k of STATE_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-installer-install-"));
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.XDG_CONFIG_HOME = path.join(tmp, ".config");
  process.env.METAHUB_PORTAL_URL = "http://portal.test";
  origCwd = process.cwd;
  process.cwd = () => tmp;
  saveAuthConfig({ portalUrl: "http://portal.test", sessionToken: "tok_session" });
});

afterEach(() => {
  process.cwd = origCwd;
  for (const k of STATE_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  delete process.env.METAHUB_PORTAL_URL;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeSkillTarball(): Buffer {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-tar-skill-"));
  try {
    const root = "owner-repo-abc1234";
    fs.mkdirSync(path.join(workDir, root), { recursive: true });
    fs.writeFileSync(path.join(workDir, root, "SKILL.md"), "# pdf");
    const tgz = path.join(workDir, "fixture.tar.gz");
    const r = spawnSync("tar", ["-czf", tgz, "-C", workDir, root], { stdio: "pipe" });
    if (r.status !== 0) throw new Error(r.stderr.toString());
    return fs.readFileSync(tgz);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * A repo shaped like tonylofgren/aurora-smart-home (the repo from
 * https://github.com/metahub-ai/metahub-cli/issues/1): a
 * marketplace.json whose single plugin sources the repo root and
 * declares the specialist skills that ship with the orchestrator.
 */
function makeAuroraShapedTarball(): Buffer {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-tar-aurora-"));
  try {
    const root = "tonylofgren-aurora-smart-home-abc1234";
    const skills = [
      "aurora",
      "home-assistant",
      "esphome",
      "ha-integration-dev",
      "node-red",
      "api-catalog",
      "ha-dashboard-design",
    ];
    for (const name of skills) {
      fs.mkdirSync(path.join(workDir, root, name), { recursive: true });
      fs.writeFileSync(path.join(workDir, root, name, "SKILL.md"), `# ${name}`);
    }
    fs.mkdirSync(path.join(workDir, root, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, root, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: "aurora-smart-home",
        plugins: [
          {
            name: "aurora",
            source: "./",
            skills: [
              "./home-assistant",
              "./esphome",
              "./ha-integration-dev",
              "./node-red",
              "./api-catalog",
              "./ha-dashboard-design",
            ],
          },
        ],
      }),
    );
    fs.mkdirSync(path.join(workDir, root, "commands"), { recursive: true });
    fs.writeFileSync(path.join(workDir, root, "commands", "aurora.md"), "# command");
    fs.writeFileSync(path.join(workDir, root, "README.md"), "# repo");
    const tgz = path.join(workDir, "fixture.tar.gz");
    const r = spawnSync("tar", ["-czf", tgz, "-C", workDir, root], { stdio: "pipe" });
    if (r.status !== 0) throw new Error(r.stderr.toString());
    return fs.readFileSync(tgz);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

describe("installArtifact", () => {
  it("downloads the tarball, writes the sidecar, and records the install", async () => {
    const tarballBytes = makeSkillTarball();
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/api/cli/install/")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              artifact: {
                id: "art_pdf",
                name: "PDF",
                slug: "pdf",
                kind: "skill",
                version: "1.0.0",
                publishedSha: "abc12345",
                repoPath: null,
              },
              tarballUrl: "http://tarball.test/x.tgz",
              installToken: "tok_install",
              ingestApiKey: "mhi_pdf",
              installId: "ins_pdf",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(new Response(tarballBytes, { status: 200 }));
    });

    const events: InstallProgressEvent[] = [];
    const result = await installArtifact({
      kind: "skill",
      slug: "pdf",
      hostVersion: "9.9.9",
      onProgress: (e) => events.push(e),
    });

    expect(result.artifactId).toBe("art_pdf");
    expect(result.installPath).toContain("pdf");
    expect(fs.existsSync(path.join(result.installPath, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(result.installPath, ".metahub.json"))).toBe(true);
    expect(events.map((e) => e.stage)).toEqual(["resolve", "download", "wire", "record"]);

    const installed = await listInstalled();
    expect(installed).toHaveLength(1);
    expect(installed[0]?.slug).toBe("pdf");
  });

  it("installs the related skill directories a marketplace.json groups with the skill", async () => {
    const tarballBytes = makeAuroraShapedTarball();
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/api/cli/install/")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              artifact: {
                id: "art_aurora",
                name: "aurora",
                slug: "aurora",
                kind: "skill",
                version: null,
                publishedSha: "abc12345",
                repoPath: "aurora",
              },
              tarballUrl: "http://tarball.test/aurora.tgz",
              installToken: "tok_install",
              ingestApiKey: "mhi_aurora",
              installId: "ins_aurora",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(new Response(tarballBytes, { status: 200 }));
    });

    const events: InstallProgressEvent[] = [];
    const result = await installArtifact({
      kind: "skill",
      slug: "aurora",
      onProgress: (e) => events.push(e),
    });

    // The requested skill lands at its canonical path…
    expect(fs.existsSync(path.join(result.installPath, "SKILL.md"))).toBe(true);
    // …and so does every sibling the marketplace.json declares.
    expect(result.relatedSkills.map((r) => r.slug).sort()).toEqual([
      "api-catalog",
      "esphome",
      "ha-dashboard-design",
      "ha-integration-dev",
      "home-assistant",
      "node-red",
    ]);
    for (const rel of result.relatedSkills) {
      expect(fs.existsSync(path.join(rel.installPath, "SKILL.md"))).toBe(true);
      expect(fs.existsSync(path.join(rel.installPath, ".metahub.json"))).toBe(true);
    }
    // Repo files that are not skills don't leak in as installs.
    expect(result.relatedSkills.map((r) => r.slug)).not.toContain("commands");

    // Per-skill progress events fire for the siblings.
    const relatedStages = events.filter((e) => e.stage === "related");
    expect(relatedStages.map((e) => (e as { slug: string }).slug).sort()).toEqual([
      "api-catalog",
      "esphome",
      "ha-dashboard-design",
      "ha-integration-dev",
      "home-assistant",
      "node-red",
    ]);

    // Every skill is its own ledger row; siblings are tagged with the
    // skill that pulled them in.
    const installed = await listInstalled();
    expect(installed.map((i) => i.slug).sort()).toEqual([
      "api-catalog",
      "aurora",
      "esphome",
      "ha-dashboard-design",
      "ha-integration-dev",
      "home-assistant",
      "node-red",
    ]);
    expect(installed.find((i) => i.slug === "esphome")?.installedWith).toBe("aurora");
    expect(installed.find((i) => i.slug === "aurora")?.installedWith).toBeUndefined();
  });

  it("leaves single-skill repos untouched (no related skills)", async () => {
    const tarballBytes = makeSkillTarball();
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/api/cli/install/")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              artifact: {
                id: "art_pdf",
                name: "PDF",
                slug: "pdf",
                kind: "skill",
                version: "1.0.0",
                publishedSha: "abc12345",
                repoPath: null,
              },
              tarballUrl: "http://tarball.test/x.tgz",
              installToken: "tok_install",
              ingestApiKey: "mhi_pdf",
              installId: "ins_pdf",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(new Response(tarballBytes, { status: 200 }));
    });

    const result = await installArtifact({ kind: "skill", slug: "pdf" });
    expect(result.relatedSkills).toEqual([]);
    const installed = await listInstalled();
    expect(installed).toHaveLength(1);
    expect(installed[0]?.slug).toBe("pdf");
  });
});

describe("uninstallArtifact", () => {
  it("returns { removed: false } when the slug isn't installed", async () => {
    const r = await uninstallArtifact({ kind: "skill", slug: "never" });
    expect(r.removed).toBe(false);
  });
});
