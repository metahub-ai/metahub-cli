/**
 * Unit coverage for installArtifact / uninstallArtifact / listInstalled
 * with the platform-sensitive boundaries mocked out:
 *   - ./portal-api.js  (getInstallInfo) — no network
 *   - ./tarball.js     (fetchAndExtractTarball) — no real tar (the
 *     real tar fixture is what makes install.test.ts fail on Windows)
 *   - ./hooks.js       (wireHook / unwireHook) — no client wiring
 *
 * This exercises the orchestration branches install.test.ts skips on
 * Windows: the replace-existing path, the repoPath subPath forwarding,
 * the publishedSha/version `?? null` fallbacks, the warning passthrough,
 * and the uninstall install-dir removal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Mocks ───────────────────────────────────────────────────────────
const getInstallInfo = vi.fn();
const fetchAndExtractTarball = vi.fn();
const wireHook = vi.fn();
const unwireHook = vi.fn();

vi.mock("../src/portal-api.js", () => ({
  getInstallInfo: (...a: unknown[]) => getInstallInfo(...a),
}));
vi.mock("../src/tarball.js", () => ({
  fetchAndExtractTarball: (...a: unknown[]) => fetchAndExtractTarball(...a),
}));
vi.mock("../src/hooks.js", () => ({
  wireHook: (...a: unknown[]) => wireHook(...a),
  unwireHook: (...a: unknown[]) => unwireHook(...a),
}));

const STATE_KEYS = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "METAHUB_E2E_HOME"] as const;
const saved: Record<string, string | undefined> = {};
let tmp: string;

function infoFixture(overrides: Record<string, unknown> = {}) {
  return {
    artifact: {
      id: "art_pdf",
      name: "PDF",
      slug: "pdf",
      kind: "skill",
      version: "1.0.0",
      publishedSha: "abc12345",
      repoPath: null,
      ...((overrides.artifact as object) ?? {}),
    },
    tarballUrl: "http://tarball.test/x.tgz",
    installToken: "tok_install",
    ingestApiKey: "mhi_pdf",
    installId: "ins_pdf",
    ...overrides,
  };
}

beforeEach(async () => {
  for (const k of STATE_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-installer-installunit-"));
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.XDG_CONFIG_HOME = path.join(tmp, ".config");
  process.env.METAHUB_E2E_HOME = tmp;
  process.env.METAHUB_PORTAL_URL = "http://portal.test";

  const { saveAuthConfig } = await import("@metahub/auth");
  saveAuthConfig({ portalUrl: "http://portal.test", sessionToken: "tok_session" });

  getInstallInfo.mockReset().mockResolvedValue(infoFixture());
  // Default tarball mock: create the dest dir with a SKILL.md so the
  // sidecar write + listing has something concrete.
  fetchAndExtractTarball.mockReset().mockImplementation(async (_url: string, dest: string) => {
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "SKILL.md"), "# pdf");
  });
  wireHook.mockReset().mockReturnValue({ clients: [], skillMirrors: [] });
  unwireHook.mockReset();
});

afterEach(() => {
  for (const k of STATE_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  delete process.env.METAHUB_PORTAL_URL;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("installArtifact", () => {
  it("resolves, downloads, wires, records and emits progress in order", async () => {
    const { installArtifact, listInstalled } = await import("../src/install");
    const stages: string[] = [];
    const result = await installArtifact({
      kind: "skill",
      slug: "pdf",
      host: "mh-cli",
      hostVersion: "9.9.9",
      onProgress: (e) => stages.push(e.stage),
    });

    expect(result.artifactId).toBe("art_pdf");
    expect(result.sha).toBe("abc12345");
    expect(result.version).toBe("1.0.0");
    expect(result.name).toBe("PDF");
    // No replace-existing on a clean install.
    expect(stages).toEqual(["resolve", "download", "wire", "record"]);

    // getInstallInfo got the host + version + platform meta and the token.
    const meta = getInstallInfo.mock.calls[0]![2] as { host: string; cliVersion: string };
    expect(meta.host).toBe("mh-cli");
    expect(meta.cliVersion).toBe("9.9.9");

    const installed = await listInstalled();
    expect(installed).toHaveLength(1);
    expect(installed[0]?.slug).toBe("pdf");
  });

  it("defaults host to metahub-installer and version to 0.0.0 when unset", async () => {
    const { installArtifact } = await import("../src/install");
    await installArtifact({ kind: "skill", slug: "pdf" });
    const meta = getInstallInfo.mock.calls[0]![2] as { host: string; cliVersion: string };
    expect(meta.host).toBe("metahub-installer");
    expect(meta.cliVersion).toBe("0.0.0");
  });

  it("removes an existing install dir first (replace-existing branch)", async () => {
    const { installPathFor } = await import("../src/paths");
    const dest = installPathFor("skill", "pdf");
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "STALE.md"), "old");

    const { installArtifact } = await import("../src/install");
    const stages: string[] = [];
    await installArtifact({ kind: "skill", slug: "pdf", onProgress: (e) => stages.push(e.stage) });

    expect(stages[0]).toBe("resolve");
    expect(stages).toContain("replace-existing");
    // Stale file gone; fresh extract present.
    expect(fs.existsSync(path.join(dest, "STALE.md"))).toBe(false);
    expect(fs.existsSync(path.join(dest, "SKILL.md"))).toBe(true);
  });

  it("extracts the full repo into staging and promotes the repoPath sub-dir", async () => {
    getInstallInfo.mockResolvedValue(infoFixture({ artifact: { repoPath: "skills/pdf" } }));
    // The tarball mock receives the STAGING dir now (skills extract the
    // whole repo first so related skills can be discovered).
    fetchAndExtractTarball.mockImplementation(async (_url: string, dest: string) => {
      fs.mkdirSync(path.join(dest, "skills", "pdf"), { recursive: true });
      fs.writeFileSync(path.join(dest, "skills", "pdf", "SKILL.md"), "# pdf");
      fs.writeFileSync(path.join(dest, "README.md"), "# repo root");
    });
    const { installArtifact } = await import("../src/install");
    const { installPathFor } = await import("../src/paths");
    const events: Array<{ stage: string; subPath?: string | null }> = [];
    const result = await installArtifact({
      kind: "skill",
      slug: "pdf",
      onProgress: (e) => events.push(e),
    });

    const download = events.find((e) => e.stage === "download");
    expect(download?.subPath).toBe("skills/pdf");
    // Skills no longer thread subPath into fetchAndExtractTarball —
    // the full repo lands in staging and install.ts promotes the
    // sub-dir itself.
    const opts = fetchAndExtractTarball.mock.calls[0]![2] as { subPath?: string } | undefined;
    expect(opts?.subPath).toBeUndefined();
    // Only the sub-dir's contents land at the install path.
    const dest = installPathFor("skill", "pdf");
    expect(result.installPath).toBe(dest);
    expect(fs.existsSync(path.join(dest, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "README.md"))).toBe(false);
  });

  it("throws when the repoPath sub-dir is missing from the archive", async () => {
    getInstallInfo.mockResolvedValue(infoFixture({ artifact: { repoPath: "skills/missing" } }));
    fetchAndExtractTarball.mockImplementation(async (_url: string, dest: string) => {
      fs.mkdirSync(dest, { recursive: true });
    });
    const { installArtifact } = await import("../src/install");
    await expect(installArtifact({ kind: "skill", slug: "pdf" })).rejects.toThrow(/not found/);
  });

  it("installs related skills declared by the repo's marketplace.json", async () => {
    getInstallInfo.mockResolvedValue(infoFixture({ artifact: { repoPath: "aurora" } }));
    fetchAndExtractTarball.mockImplementation(async (_url: string, dest: string) => {
      fs.mkdirSync(path.join(dest, ".claude-plugin"), { recursive: true });
      fs.writeFileSync(
        path.join(dest, ".claude-plugin", "marketplace.json"),
        JSON.stringify({
          plugins: [{ name: "aurora", source: "./", skills: ["./esphome", "./home-assistant"] }],
        }),
      );
      for (const name of ["aurora", "esphome", "home-assistant"]) {
        fs.mkdirSync(path.join(dest, name), { recursive: true });
        fs.writeFileSync(path.join(dest, name, "SKILL.md"), `# ${name}`);
      }
    });
    const { installArtifact, listInstalled } = await import("../src/install");
    const { installPathFor } = await import("../src/paths");
    const result = await installArtifact({ kind: "skill", slug: "aurora" });

    expect(result.relatedSkills.map((r) => r.slug).sort()).toEqual(["esphome", "home-assistant"]);
    for (const name of ["aurora", "esphome", "home-assistant"]) {
      const dir = installPathFor("skill", name);
      expect(fs.existsSync(path.join(dir, "SKILL.md"))).toBe(true);
    }
    // Every skill gets the full wiring treatment (sidecar + mirrors +
    // wiring ledger) — wireHook is called once per skill.
    const wiredSlugs = wireHook.mock.calls.map((c) => (c[0] as { slug: string }).slug);
    expect(wiredSlugs.sort()).toEqual(["aurora", "esphome", "home-assistant"]);
    // Each related skill is its own ledger row, tagged with the skill
    // that pulled it in.
    const installed = await listInstalled();
    expect(installed.map((i) => i.slug).sort()).toEqual(["aurora", "esphome", "home-assistant"]);
    for (const row of installed) {
      if (row.slug === "aurora") expect(row.installedWith).toBeUndefined();
      else expect(row.installedWith).toBe("aurora");
    }
  });

  it("installs related skills from nested plugin layouts and string container paths", async () => {
    getInstallInfo.mockResolvedValue(
      infoFixture({ artifact: { slug: "quality", repoPath: "extensions/quality/orchestrator" } }),
    );
    fetchAndExtractTarball.mockImplementation(async (_url: string, dest: string) => {
      fs.mkdirSync(path.join(dest, ".claude-plugin"), { recursive: true });
      fs.writeFileSync(
        path.join(dest, ".claude-plugin", "marketplace.json"),
        JSON.stringify({
          metadata: { pluginRoot: "./extensions" },
          plugins: [{ name: "quality", source: "./quality" }],
        }),
      );
      fs.mkdirSync(path.join(dest, "extensions/quality/.claude-plugin"), { recursive: true });
      fs.writeFileSync(
        path.join(dest, "extensions/quality/.claude-plugin/plugin.json"),
        JSON.stringify({ name: "quality", skills: "./custom/deep/skills" }),
      );
      for (const rel of [
        "extensions/quality/orchestrator",
        "extensions/quality/custom/deep/skills/security",
        "extensions/quality/custom/deep/skills/performance",
        "extensions/quality/skills/conventional",
      ]) {
        fs.mkdirSync(path.join(dest, rel), { recursive: true });
        fs.writeFileSync(path.join(dest, rel, "SKILL.md"), `# ${path.basename(rel)}`);
      }
    });

    const { installArtifact } = await import("../src/install");
    const { installPathFor } = await import("../src/paths");
    const result = await installArtifact({ kind: "skill", slug: "quality" });

    expect(result.relatedSkills.map((r) => r.slug).sort()).toEqual([
      "conventional",
      "performance",
      "security",
    ]);
    expect(fs.existsSync(path.join(installPathFor("skill", "quality"), "SKILL.md"))).toBe(true);
    for (const slug of ["conventional", "performance", "security"]) {
      expect(fs.existsSync(path.join(installPathFor("skill", slug), "SKILL.md"))).toBe(true);
    }
  });

  it("does not clobber a related skill installed standalone", async () => {
    getInstallInfo.mockResolvedValue(infoFixture({ artifact: { repoPath: "aurora" } }));
    fetchAndExtractTarball.mockImplementation(async (_url: string, dest: string) => {
      fs.mkdirSync(path.join(dest, ".claude-plugin"), { recursive: true });
      fs.writeFileSync(
        path.join(dest, ".claude-plugin", "marketplace.json"),
        JSON.stringify({ plugins: [{ name: "aurora", source: "./", skills: ["./esphome"] }] }),
      );
      for (const name of ["aurora", "esphome"]) {
        fs.mkdirSync(path.join(dest, name), { recursive: true });
        fs.writeFileSync(path.join(dest, name, "SKILL.md"), `# ${name}`);
      }
    });

    const { installArtifact } = await import("../src/install");
    const { installPathFor } = await import("../src/paths");
    const { recordInstall } = await import("../src/installs");
    // esphome was installed standalone earlier (no installedWith).
    recordInstall({
      artifactId: "art_esphome",
      installId: "ins_esphome",
      slug: "esphome",
      kind: "skill",
      version: null,
      installPath: installPathFor("skill", "esphome"),
      ingestApiKey: "mhi_esphome",
      publishedSha: "sha-esphome",
      installedAt: "2026-01-01T00:00:00Z",
    });
    fs.mkdirSync(installPathFor("skill", "esphome"), { recursive: true });
    fs.writeFileSync(path.join(installPathFor("skill", "esphome"), "MINE.md"), "keep me");

    const result = await installArtifact({ kind: "skill", slug: "aurora" });
    expect(result.relatedSkills).toEqual([]);
    // Standalone install untouched.
    expect(fs.existsSync(path.join(installPathFor("skill", "esphome"), "MINE.md"))).toBe(true);
    expect(fs.existsSync(path.join(installPathFor("skill", "aurora"), "SKILL.md"))).toBe(true);
  });

  it("refreshes related skills previously installed as satellites of the same skill", async () => {
    getInstallInfo.mockResolvedValue(infoFixture({ artifact: { repoPath: "aurora" } }));
    fetchAndExtractTarball.mockImplementation(async (_url: string, dest: string) => {
      fs.mkdirSync(path.join(dest, ".claude-plugin"), { recursive: true });
      fs.writeFileSync(
        path.join(dest, ".claude-plugin", "marketplace.json"),
        JSON.stringify({ plugins: [{ name: "aurora", source: "./", skills: ["./esphome"] }] }),
      );
      for (const name of ["aurora", "esphome"]) {
        fs.mkdirSync(path.join(dest, name), { recursive: true });
        fs.writeFileSync(path.join(dest, name, "SKILL.md"), `# ${name} v2`);
      }
    });

    const { installArtifact } = await import("../src/install");
    const { installPathFor } = await import("../src/paths");
    const { recordInstall } = await import("../src/installs");
    // esphome was installed as a satellite of aurora earlier.
    recordInstall({
      artifactId: "art_esphome",
      installId: "ins_esphome",
      slug: "esphome",
      kind: "skill",
      version: null,
      installPath: installPathFor("skill", "esphome"),
      ingestApiKey: "mhi_esphome",
      publishedSha: "sha-old",
      installedAt: "2026-01-01T00:00:00Z",
      installedWith: "aurora",
    });

    const result = await installArtifact({ kind: "skill", slug: "aurora" });
    expect(result.relatedSkills.map((r) => r.slug)).toEqual(["esphome"]);
    expect(fs.readFileSync(path.join(installPathFor("skill", "esphome"), "SKILL.md"), "utf8")).toBe(
      "# esphome v2",
    );
  });

  for (const kind of ["mcp", "agent", "plugin"] as const) {
    it(`keeps ${kind} installs on the direct subPath extraction path`, async () => {
      getInstallInfo.mockResolvedValue(
        infoFixture({
          artifact: {
            id: `art_${kind}`,
            slug: `${kind}-fixture`,
            kind,
            repoPath: `packages/${kind}/fixture`,
          },
        }),
      );
      const { installArtifact } = await import("../src/install");
      const result = await installArtifact({ kind, slug: `${kind}-fixture` });
      // Non-skill kinds still thread subPath straight into the extractor
      // and never run related-skill discovery.
      const opts = fetchAndExtractTarball.mock.calls[0]![2] as { subPath: string | null };
      expect(opts.subPath).toBe(`packages/${kind}/fixture`);
      expect(result.relatedSkills).toEqual([]);
    });
  }

  it("falls back to null sha / version when the portal omits them", async () => {
    getInstallInfo.mockResolvedValue(
      infoFixture({ artifact: { publishedSha: undefined, version: null } }),
    );
    const { installArtifact } = await import("../src/install");
    const result = await installArtifact({ kind: "skill", slug: "pdf" });
    expect(result.sha).toBeNull();
    expect(result.version).toBeNull();
  });

  it("passes the wiring warning + results through to the InstallResult", async () => {
    wireHook.mockReturnValue({
      clients: [{ client: "Claude Code", status: "wrote", configPath: "/x" }],
      skillMirrors: [{ client: "cursor", clientLabel: "Cursor", path: "/r.mdc", status: "wrote" }],
      warning: "heads up",
    });
    const { installArtifact } = await import("../src/install");
    const result = await installArtifact({ kind: "skill", slug: "pdf" });
    expect(result.warning).toBe("heads up");
    expect(result.clientsWired).toHaveLength(1);
    expect(result.skillMirrors).toHaveLength(1);
  });
});

describe("uninstallArtifact", () => {
  it("returns { removed: false } when the slug isn't installed", async () => {
    const { uninstallArtifact } = await import("../src/install");
    const r = await uninstallArtifact({ kind: "skill", slug: "never" });
    expect(r.removed).toBe(false);
    expect(r.record).toBeNull();
    expect(unwireHook).not.toHaveBeenCalled();
  });

  it("removes the install dir + record and calls unwireHook on success", async () => {
    const { installArtifact, uninstallArtifact } = await import("../src/install");
    const inst = await installArtifact({ kind: "skill", slug: "pdf" });
    expect(fs.existsSync(inst.installPath)).toBe(true);

    const r = await uninstallArtifact({ kind: "skill", slug: "pdf" });
    expect(r.removed).toBe(true);
    expect(r.record?.slug).toBe("pdf");
    expect(fs.existsSync(inst.installPath)).toBe(false);
    expect(unwireHook).toHaveBeenCalledWith("skill", "pdf");
  });

  it("still succeeds when the install dir is already gone (existsSync false branch)", async () => {
    const { installArtifact, uninstallArtifact } = await import("../src/install");
    const inst = await installArtifact({ kind: "skill", slug: "pdf" });
    // Pre-delete the dir so the rmSync branch is skipped.
    fs.rmSync(inst.installPath, { recursive: true, force: true });

    const r = await uninstallArtifact({ kind: "skill", slug: "pdf" });
    expect(r.removed).toBe(true);
    expect(unwireHook).toHaveBeenCalledWith("skill", "pdf");
  });
});

describe("listInstalled", () => {
  it("returns an empty list before any install", async () => {
    const { listInstalled } = await import("../src/install");
    expect(await listInstalled()).toEqual([]);
  });
});
