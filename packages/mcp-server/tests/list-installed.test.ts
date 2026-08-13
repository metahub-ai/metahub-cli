/**
 * Tests for the `metahub_list_installed` tool wrapper. The library
 * (`@metahub/installer`) owns the on-disk ledger; this test mocks the
 * library and asserts the wrapper hands records through cleanly.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstalledRecord } from "@metahub/installer";

vi.mock("@metahub/installer", () => ({
  listInstalled: vi.fn(),
}));

import { listInstalled } from "@metahub/installer";
import { listInstalledArtifacts } from "../src/tools/list-installed";

const sample: InstalledRecord = {
  artifactId: "art_1",
  installId: "ins_1",
  slug: "pdf",
  kind: "skill",
  version: "1.0.0",
  installPath: "/home/me/.claude/skills/pdf",
  ingestApiKey: "mhi_xxx",
  publishedSha: "abc",
  installedAt: "2026-01-01T00:00:00Z",
};

afterEach(() => {
  vi.resetAllMocks();
});

describe("listInstalledArtifacts", () => {
  it("strips the ingest write-credential and returns the remaining fields", async () => {
    vi.mocked(listInstalled).mockResolvedValue([sample]);
    const records = await listInstalledArtifacts();
    expect(records).toHaveLength(1);
    // ingestApiKey (an mhi_ write credential) must NOT cross the MCP boundary.
    expect(records[0]).not.toHaveProperty("ingestApiKey");
    expect(records[0]).toEqual({
      artifactId: sample.artifactId,
      installId: sample.installId,
      slug: sample.slug,
      kind: sample.kind,
      version: sample.version,
      installPath: sample.installPath,
      publishedSha: sample.publishedSha,
      installedAt: sample.installedAt,
    });
  });

  it("never emits an mhi_ ingest token in its serialized output (regression: A2 leak)", async () => {
    vi.mocked(listInstalled).mockResolvedValue([
      sample,
      { ...sample, slug: "spreadsheet", ingestApiKey: "mhi_anotherSecretValue123" },
    ]);
    const records = await listInstalledArtifacts();
    // The tool serializes `{ count, installs }` into its text response — assert
    // no record carries an ingest credential and the JSON has no `mhi_` token.
    expect(JSON.stringify({ count: records.length, installs: records })).not.toContain("mhi_");
    for (const r of records) expect(r).not.toHaveProperty("ingestApiKey");
  });

  it("returns an empty array when no installs are recorded", async () => {
    vi.mocked(listInstalled).mockResolvedValue([]);
    const records = await listInstalledArtifacts();
    expect(records).toEqual([]);
  });

  it("preserves install order from the library", async () => {
    const second: InstalledRecord = { ...sample, slug: "spreadsheet" };
    vi.mocked(listInstalled).mockResolvedValue([sample, second]);
    const records = await listInstalledArtifacts();
    expect(records.map((r) => r.slug)).toEqual(["pdf", "spreadsheet"]);
  });

  it("propagates library errors verbatim", async () => {
    vi.mocked(listInstalled).mockRejectedValue(new Error("disk full"));
    await expect(listInstalledArtifacts()).rejects.toThrow(/disk full/);
  });

  // Note: the non-ENOENT read-error path is now owned by `@metahub/installer`
  // (which uses real fs). After the Phase 7 library rewire, the mcp-server
  // tool just delegates; the library's own test suite covers fs error paths.
});
