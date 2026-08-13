/**
 * Tests for `uninstallArtifactTool` — the MCP tool's wrapper over
 * `uninstallArtifact` from `@metahub/installer`. Mocks the library;
 * does no real filesystem work.
 */
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { uninstallArtifactTool } from "../src/tools/uninstall";

describe("uninstallArtifactTool", () => {
  it("falls back to @metahub/installer's uninstallArtifact when no override is given", async () => {
    // Exercise the `?? uninstallArtifact` default. A throwaway HOME with no
    // install ledger means the real library finds nothing to remove and
    // reports removed=false (no network, no real filesystem mutation).
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "mh-uninstall-test-"));
    const ORIGINAL_HOME = process.env.METAHUB_E2E_HOME;
    process.env.METAHUB_E2E_HOME = tmpHome;
    try {
      const { summary, result } = await uninstallArtifactTool({ kind: "skill", slug: "nope" });
      expect(result.removed).toBe(false);
      expect(summary).toMatch(/skill\/nope is not installed/);
    } finally {
      if (ORIGINAL_HOME === undefined) delete process.env.METAHUB_E2E_HOME;
      else process.env.METAHUB_E2E_HOME = ORIGINAL_HOME;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("returns a removed=true summary when the library reports a removal", async () => {
    const uninstaller = vi.fn(async () => ({
      removed: true,
      record: {
        artifactId: "art_pdf",
        installId: "ins_1",
        slug: "pdf",
        kind: "skill" as const,
        version: "1.0.0",
        installPath: "/x",
        ingestApiKey: "mhi_xxx",
        publishedSha: null,
        installedAt: "2026-01-01T00:00:00Z",
      },
    }));
    const { summary, result } = await uninstallArtifactTool(
      { kind: "skill", slug: "pdf" },
      { uninstaller },
    );
    expect(result.removed).toBe(true);
    expect(summary).toMatch(/Removed skill\/pdf/);
    expect(uninstaller).toHaveBeenCalledWith({ kind: "skill", slug: "pdf" });
  });

  it("returns a not-installed summary when nothing was removed", async () => {
    const uninstaller = vi.fn(async () => ({ removed: false, record: null }));
    const { summary } = await uninstallArtifactTool(
      { kind: "skill", slug: "nope" },
      { uninstaller },
    );
    expect(summary).toMatch(/skill\/nope is not installed/);
  });

  it("propagates library errors verbatim", async () => {
    const uninstaller = vi.fn(async () => {
      throw new Error("permission denied");
    });
    await expect(
      uninstallArtifactTool({ kind: "skill", slug: "pdf" }, { uninstaller }),
    ).rejects.toThrow(/permission denied/);
  });
});
