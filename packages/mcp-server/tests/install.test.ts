/**
 * Tests for `installArtifactTool` — the MCP tool's wrapper over
 * `installArtifact` from `@metahub/installer`. We mock the library
 * directly (no `spawn`, no real filesystem) and assert the wrapper
 * forwards the right args and renders a useful summary string.
 */
import { describe, expect, it, vi } from "vitest";
import type { InstallResult, installArtifact } from "@metahub/installer";
import { installArtifactTool } from "../src/tools/install";

function makeResult(overrides: Partial<InstallResult> = {}): InstallResult {
  return {
    artifactId: "art_pdf",
    installId: "ins_1",
    sha: "abc1234567",
    name: "PDF Skill",
    version: "1.0.0",
    installPath: "/home/me/.claude/skills/pdf",
    clientsWired: [],
    skillMirrors: [],
    relatedSkills: [],
    ...overrides,
  };
}

describe("installArtifactTool", () => {
  it("calls the library with kind, slug, host, hostVersion, and an onProgress sink", async () => {
    const installer = vi.fn(async () => makeResult());
    await installArtifactTool({ kind: "skill", slug: "pdf" }, { installer });
    expect(installer).toHaveBeenCalledTimes(1);
    const arg = installer.mock.calls[0]![0]!;
    expect(arg.kind).toBe("skill");
    expect(arg.slug).toBe("pdf");
    expect(arg.host).toBe("metahub-mcp-server");
    expect(typeof arg.hostVersion).toBe("string");
    expect(typeof arg.onProgress).toBe("function");
  });

  it("returns a summary that mentions the install path and version", async () => {
    const installer = vi.fn(async () => makeResult());
    const { summary } = await installArtifactTool({ kind: "skill", slug: "pdf" }, { installer });
    expect(summary).toMatch(/Installed PDF Skill v1\.0\.0/);
    expect(summary).toMatch(/\/home\/me\/\.claude\/skills\/pdf/);
    expect(summary).toMatch(/Restart your AI client/);
  });

  it("reports wired MCP clients in the summary", async () => {
    const installer = vi.fn(async () =>
      makeResult({
        name: "GitHub MCP",
        clientsWired: [
          { client: "claude-code", status: "wrote", configPath: "/home/me/.claude/settings.json" },
          { client: "cursor", status: "wrote", configPath: "/home/me/.cursor/mcp.json" },
        ],
      }),
    );
    const { summary } = await installArtifactTool({ kind: "mcp", slug: "github" }, { installer });
    expect(summary).toMatch(/Wired into 2 client\(s\): claude-code, cursor/);
  });

  it("reports manual-config clients in the summary", async () => {
    const installer = vi.fn(async () =>
      makeResult({
        clientsWired: [
          {
            client: "zed",
            status: "manual",
            configPath: "/home/me/.config/zed/settings.json",
            manualSnippet: "{ ... }",
          },
        ],
      }),
    );
    const { summary } = await installArtifactTool({ kind: "mcp", slug: "github" }, { installer });
    expect(summary).toMatch(/Manual config required for: zed/);
  });

  it("reports 'No AI clients detected' for MCP installs when nothing wired", async () => {
    const installer = vi.fn(async () => makeResult({ clientsWired: [] }));
    const { summary } = await installArtifactTool({ kind: "mcp", slug: "github" }, { installer });
    expect(summary).toMatch(/No AI clients detected/);
  });

  it("appends a warning when the library returns one", async () => {
    const installer = vi.fn(async () =>
      makeResult({ warning: "ingestApiKey was empty; telemetry disabled" }),
    );
    const { summary } = await installArtifactTool({ kind: "skill", slug: "pdf" }, { installer });
    expect(summary).toMatch(/Warning: ingestApiKey was empty; telemetry disabled/);
  });

  it("reports every related skill in the summary and progress steps", async () => {
    const installer = vi.fn(async (opts: Parameters<typeof installArtifact>[0]) => {
      opts.onProgress?.({
        stage: "related",
        slug: "security",
        path: "/home/me/.claude/skills/security",
      });
      return makeResult({
        name: "Quality",
        relatedSkills: [
          { slug: "security", installPath: "/home/me/.claude/skills/security" },
          { slug: "performance", installPath: "/home/me/.claude/skills/performance" },
        ],
      });
    });

    const { summary } = await installArtifactTool(
      { kind: "skill", slug: "quality" },
      { installer },
    );
    expect(summary).toMatch(/Installed related skill security from the same repo/);
    expect(summary).toMatch(/Also installed 2 related skill\(s\).*security, performance/);
  });

  it("propagates library errors verbatim", async () => {
    const installer = vi.fn(async () => {
      throw new Error("portal returned HTTP 404");
    });
    await expect(
      installArtifactTool({ kind: "skill", slug: "nope" }, { installer }),
    ).rejects.toThrow(/HTTP 404/);
  });

  it("renders a Steps section listing each progress event the library emits", async () => {
    const installer = vi.fn(async (opts: Parameters<typeof installArtifact>[0]) => {
      opts.onProgress?.({ stage: "resolve", kind: "skill", slug: "pdf" });
      opts.onProgress?.({
        stage: "download",
        sha: "abc123def456",
        subPath: null,
      });
      opts.onProgress?.({ stage: "wire", kind: "skill", slug: "pdf" });
      opts.onProgress?.({ stage: "record", installPath: "/home/me/.claude/skills/pdf" });
      return makeResult();
    });
    const { summary } = await installArtifactTool({ kind: "skill", slug: "pdf" }, { installer });
    expect(summary).toMatch(/Steps:/);
    expect(summary).toMatch(/Resolved skill\/pdf/);
    expect(summary).toMatch(/Fetched tarball at SHA abc123d/);
    expect(summary).toMatch(/Wiring skill\/pdf/);
    expect(summary).toMatch(/Recorded install at \/home\/me\/\.claude\/skills\/pdf/);
  });

  it("omits the Steps section when the library emits no progress events", async () => {
    const installer = vi.fn(async () => makeResult());
    const { summary } = await installArtifactTool({ kind: "skill", slug: "pdf" }, { installer });
    expect(summary).not.toMatch(/Steps:/);
  });

  it("describes a replace-existing event in the Steps section", async () => {
    const installer = vi.fn(async (opts: Parameters<typeof installArtifact>[0]) => {
      opts.onProgress?.({ stage: "replace-existing", path: "/home/me/.claude/skills/pdf" });
      return makeResult();
    });
    const { summary } = await installArtifactTool({ kind: "skill", slug: "pdf" }, { installer });
    expect(summary).toMatch(/Removed existing install at \/home\/me\/\.claude\/skills\/pdf/);
  });

  it("renders a download event without a SHA or sub-path", async () => {
    const installer = vi.fn(async (opts: Parameters<typeof installArtifact>[0]) => {
      opts.onProgress?.({ stage: "download", sha: null, subPath: null });
      return makeResult();
    });
    const { summary } = await installArtifactTool({ kind: "skill", slug: "pdf" }, { installer });
    // No SHA / sub-path → the bare "Fetched tarball" line, no trailing detail.
    expect(summary).toMatch(/- Fetched tarball$/m);
  });

  it("ignores unknown progress stages (defensive default)", async () => {
    const installer = vi.fn(async (opts: Parameters<typeof installArtifact>[0]) => {
      // Forward a stage the union doesn't model; describeProgressEvent
      // returns null and the step is filtered out of the summary.
      (opts.onProgress as (e: unknown) => void)?.({ stage: "totally-unknown" });
      return makeResult();
    });
    const { summary } = await installArtifactTool({ kind: "skill", slug: "pdf" }, { installer });
    expect(summary).not.toMatch(/Steps:/);
  });
});
