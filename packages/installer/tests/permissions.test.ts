/**
 * The installer's two credential-bearing ledgers.
 *
 * `installs.json` holds one `ingestApiKey` per installed artifact — the
 * key the SDK authenticates to `/api/ingest` with — and shipped at 0644.
 * `wirings.json` records paths written into other tools' config
 * directories, which is not secret but is a precise map of what this
 * machine has installed, and lives in the same credential directory.
 *
 * Modes are read back off the real file rather than inferred from the
 * write call, because `writeFileSync`'s `mode` silently does nothing on
 * a file that already exists.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mh-inst-perm-"));
  process.env.METAHUB_E2E_HOME = home;
});
afterEach(() => {
  delete process.env.METAHUB_E2E_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

const modeOf = (f: string) => fs.statSync(f).mode & 0o777;
const record = {
  artifactId: "art_1",
  installId: "ins_1",
  slug: "pdf",
  kind: "skill" as const,
  version: "1.0.0",
  installPath: "/tmp/pdf",
  ingestApiKey: "mhk_live_secret_value",
  publishedSha: null,
  installedAt: "2026-01-01T00:00:00.000Z",
};

describe("installs.json", () => {
  it("is written owner-only", async () => {
    const { recordInstall } = await import("../src/installs.js");
    const { installsFile } = await import("../src/paths.js");
    recordInstall(record);
    expect(modeOf(installsFile())).toBe(0o600);
  });

  // The regression: a ledger created by an earlier version stays 0644
  // through every subsequent write unless the mode is set explicitly.
  it("repairs an existing world-readable ledger", async () => {
    const { recordInstall } = await import("../src/installs.js");
    const { installsFile } = await import("../src/paths.js");
    fs.mkdirSync(path.dirname(installsFile()), { recursive: true });
    fs.writeFileSync(installsFile(), '{"installs":[]}');
    fs.chmodSync(installsFile(), 0o644);

    recordInstall(record);
    expect(modeOf(installsFile())).toBe(0o600);
  });

  it("still round-trips the record it stored", async () => {
    const { recordInstall, listInstalls } = await import("../src/installs.js");
    recordInstall(record);
    expect(listInstalls()[0]).toMatchObject({ slug: "pdf", ingestApiKey: "mhk_live_secret_value" });
  });
});

describe("wirings.json", () => {
  const set = {
    artifactId: "art_1",
    kind: "skill" as const,
    slug: "pdf",
    installedMs: 0,
    wirings: [
      {
        client: "claude-code" as const,
        path: "/home/u/.claude/skills/pdf",
        strategy: "copy-dir" as const,
        writtenMs: 0,
        status: "wrote" as const,
      },
    ],
  };

  it("is written owner-only", async () => {
    const { recordWiring } = await import("../src/wirings.js");
    recordWiring(set);
    expect(modeOf(path.join(home, ".metahub", "wirings.json"))).toBe(0o600);
  });

  it("repairs an existing world-readable ledger", async () => {
    const { recordWiring } = await import("../src/wirings.js");
    const file = path.join(home, ".metahub", "wirings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"version":1,"byRef":{}}');
    fs.chmodSync(file, 0o644);

    recordWiring(set);
    expect(modeOf(file)).toBe(0o600);
  });

  // The write goes via a temp file plus rename so the ledger is never
  // briefly readable mid-write; the temp file must be private too, or
  // the window just moves rather than closing.
  it("leaves no temp file behind", async () => {
    const { recordWiring } = await import("../src/wirings.js");
    recordWiring(set);
    const leftovers = fs
      .readdirSync(path.join(home, ".metahub"))
      .filter((f) => f.includes(".tmp."));
    expect(leftovers).toEqual([]);
  });
});

describe("the config root itself", () => {
  it("is created owner-only", async () => {
    const { configRoot } = await import("../src/paths.js");
    expect(fs.statSync(configRoot()).mode & 0o077).toBe(0);
  });

  it("tightens a root left loose by an older version", async () => {
    const root = path.join(home, ".metahub");
    fs.mkdirSync(root, { recursive: true });
    fs.chmodSync(root, 0o755);

    const { configRoot } = await import("../src/paths.js");
    configRoot();
    expect(fs.statSync(root).mode & 0o077).toBe(0);
  });
});
