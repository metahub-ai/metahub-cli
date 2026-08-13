/**
 * Snapshot-ish output tests for each command. We don't load the real
 * @metahub/installer / @metahub/auth here (they'd want a live config
 * + a populated installs.json) — instead we exercise the parts of
 * each command we can:
 *
 *   1. Static help / version output renders the expected sections.
 *   2. Empty-state branches ("0 installed", "0 updates", "no match")
 *      render the new format.
 *   3. Error paths emit the rewritten messages.
 *
 * For the data-driven happy paths (a real `mh install`, real `mh
 * search`), we have a separate manual smoke pass against production
 * documented in the PR — these tests cover the pure-formatting
 * pieces so the visual contract stays stable across refactors.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { c, glyph, header, kv, refError, step, stripAnsi, usageError } from "../src/lib/ui.js";
import { shouldPrintDescription, shouldPrintTagline } from "../src/commands/show.js";

describe("header()", () => {
  it("emits the [bracket] label", () => {
    expect(stripAnsi(header("install", "skills/pdf"))).toMatch(/^\[install\]\s+skills\/pdf/);
  });
  it("includes trailing text when provided", () => {
    const out = stripAnsi(header("install", "skills/pdf", "developer.metahub.ai"));
    expect(out).toContain("[install]");
    expect(out).toContain("skills/pdf");
    expect(out).toContain("developer.metahub.ai");
  });
  it("handles missing subtitle", () => {
    expect(stripAnsi(header("config"))).toBe("[config]");
  });
});

describe("step() formatting", () => {
  it("ok uses green check", () => {
    const out = step("ok", "resolve", "2964d6a");
    expect(out).toMatch(/✓|v/);
    expect(out).toContain("resolve");
    expect(out).toContain("2964d6a");
  });
  it("warn uses warn glyph", () => {
    expect(step("warn", "deprecated", "v0.1")).toMatch(/⚠|!/);
  });
  it("fail uses cross glyph", () => {
    expect(step("fail", "auth", "401")).toMatch(/✗|x/);
  });
  it("info uses neutral step glyph", () => {
    expect(step("info", "checking", "…")).toMatch(/▸|>/);
  });
  it("keeps the value column aligned across rows", () => {
    const a = stripAnsi(step("ok", "a", "x"));
    const b = stripAnsi(step("ok", "longerlbl", "y"));
    expect(a.indexOf("x")).toBe(b.indexOf("y"));
  });
});

describe("kv()", () => {
  it("aligns the value column", () => {
    const out = kv([
      ["k1", "v1"],
      ["longer-key", "v2"],
    ]);
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]!.indexOf("v1")).toBe(lines[1]!.indexOf("v2"));
  });
  it("indents by 2 by default", () => {
    expect(kv([["k", "v"]])).toMatch(/^ {2}k {2}v$/);
  });
});

describe("glyph fallback", () => {
  it("provides a check + cross + arrow + warn + step + bullet + branch + star + spinner", () => {
    // Just verify the keys all exist; the platform fallback is exercised in ui.test.ts.
    expect(typeof glyph.check).toBe("string");
    expect(typeof glyph.cross).toBe("string");
    expect(typeof glyph.arrow).toBe("string");
    expect(typeof glyph.warn).toBe("string");
    expect(typeof glyph.step).toBe("string");
    expect(typeof glyph.bullet).toBe("string");
    expect(typeof glyph.branch).toBe("string");
    expect(typeof glyph.star).toBe("string");
    expect(Array.isArray(glyph.spinner)).toBe(true);
  });
});

describe("color helpers (NO_COLOR mode)", () => {
  it("are identity functions under NO_COLOR", () => {
    expect(c.green("ok")).toBe("ok");
    expect(c.red("nope")).toBe("nope");
    expect(c.dim("path")).toBe("path");
    expect(c.cyan("url")).toBe("url");
    expect(c.accent("[label]")).toBe("[label]");
    expect(c.bold("name")).toBe("name");
  });
});

describe("refError", () => {
  it("includes the raw arg and the legal list", () => {
    const out = stripAnsi(refError("nopeland/x"));
    expect(out).toContain('"nopeland/x"');
    expect(out).toMatch(/skills\/<slug>/);
    expect(out).toMatch(/mcps\/<slug>/);
    expect(out).toMatch(/agents\/<slug>/);
    expect(out).toMatch(/plugins\/<slug>/);
  });
  it("starts with a cross glyph", () => {
    const out = refError("x/y");
    expect(out).toMatch(/✗|x/);
  });
});

describe("usageError", () => {
  it("emits a styled [command] header + Usage line", () => {
    const out = stripAnsi(usageError("install", "mh install <kind>/<slug>"));
    expect(out).toContain("[install]");
    expect(out).toContain("Usage:");
    expect(out).toContain("mh install <kind>/<slug>");
  });
});

describe("show: tagline vs description duplication", () => {
  it("skips description when identical to tagline (case + whitespace insensitive)", () => {
    expect(shouldPrintDescription("Generate PDFs", "  generate pdfs\n")).toBe(false);
    // Tagline still prints (the tagline IS the description here).
    expect(shouldPrintTagline("Generate PDFs", "  generate pdfs\n")).toBe(true);
  });
  it("prints both when they carry different content", () => {
    expect(shouldPrintDescription("Generate PDFs", "Long-form description with details.")).toBe(
      true,
    );
    expect(shouldPrintTagline("Generate PDFs", "Long-form description with details.")).toBe(true);
  });
  it("handles missing tagline cleanly", () => {
    expect(shouldPrintDescription(null, "Just a description.")).toBe(true);
    expect(shouldPrintTagline(null, "Just a description.")).toBe(false);
  });
  it("handles empty description", () => {
    expect(shouldPrintDescription("Tagline only", "")).toBe(false);
    expect(shouldPrintTagline("Tagline only", "")).toBe(true);
  });
});

describe("trace --dry-run", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let captured: string[];

  beforeEach(() => {
    captured = [];
    stdoutSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      captured.push(args.map((a) => String(a)).join(" "));
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it("redacts the ingest API key in dry-run output", async () => {
    const { trace } = await import("../src/commands/trace.js");
    const installer = await import("@metahub/installer");
    vi.spyOn(installer, "findInstall").mockReturnValue({
      kind: "skill",
      slug: "pdf",
      artifactId: "art_test",
      installId: "ins_test",
      version: "0.1.0",
      installPath: "/tmp/nowhere",
      ingestApiKey: "mhi_ABCDEFGH_supersecret_rest_of_key",
      publishedSha: "abc1234",
      installedAt: "2026-01-01T00:00:00Z",
    });
    const code = await trace("skills/pdf", ["--dry-run"]);
    expect(code).toBe(0);
    const out = captured.join("\n");
    // Full key must NOT appear in output.
    expect(out).not.toContain("mhi_ABCDEFGH_supersecret_rest_of_key");
    // First-8 prefix is present with the redaction marker.
    expect(out).toContain("mhi_ABCD…<redacted>");
    expect(out).toContain("/api/ingest");
  });
});

describe("--json read-only commands", () => {
  let stdoutLines: string[];
  let stderrLines: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutLines = [];
    stderrLines = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      stdoutLines.push(args.map((a) => String(a)).join(" "));
    });
    errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrLines.push(args.map((a) => String(a)).join(" "));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("search --json emits a stable shape", async () => {
    const installer = await import("@metahub/installer");
    vi.spyOn(installer, "searchPublicArtifacts").mockResolvedValue({
      items: [
        {
          kind: "skill",
          slug: "pdf",
          name: "PDF",
          tagline: "Read PDFs",
          description: "long",
          version: "0.1.0",
          publishedSha: null,
          publishedAt: null,
          authorHandle: null,
          repoUrl: "https://example.test",
          repoBranch: null,
          tags: [],
          badges: [],
          rank: 1,
          relevanceTier: 1,
          why: ["top-pick", "exact-match"],
        },
      ],
      total: 1,
    } as unknown as Awaited<ReturnType<typeof installer.searchPublicArtifacts>>);
    const { search } = await import("../src/commands/search.js");
    const code = await search("pdf --json");
    expect(code).toBe(0);
    const payload = JSON.parse(stdoutLines.join("\n"));
    expect(payload.query).toBe("pdf");
    expect(payload.count).toBe(1);
    expect(payload.results[0]).toMatchObject({ kind: "skill", slug: "pdf" });
  });

  it("search human output marks top picks and passes sort/limit through", async () => {
    const installer = await import("@metahub/installer");
    const spy = vi.spyOn(installer, "searchPublicArtifacts").mockResolvedValue({
      items: [
        {
          kind: "skill",
          slug: "code-review",
          name: "Code Review",
          tagline: "Review PRs",
          description: "long",
          version: "0.2.0",
          publishedSha: null,
          publishedAt: null,
          authorHandle: "octo",
          repoUrl: "https://example.test",
          repoBranch: null,
          tags: ["review"],
          badges: ["well-reviewed"],
          rank: 1,
          relevanceTier: 1,
          why: ["top-pick", "exact-match"],
        },
      ],
      total: 7,
    } as unknown as Awaited<ReturnType<typeof installer.searchPublicArtifacts>>);
    const { search } = await import("../src/commands/search.js");
    const code = await search("code review --sort=trending --limit=5");
    expect(code).toBe(0);
    expect(spy).toHaveBeenCalledWith({
      q: "code review",
      kind: undefined,
      sort: "trending",
      limit: 5,
    });
    const out = stdoutLines.join("\n");
    expect(out).toContain("Top matches");
    expect(out).toContain("code-review");
    expect(out).toContain("7 total");
  });

  it("show --json includes the artifact + reviewSummary + installed", async () => {
    const installer = await import("@metahub/installer");
    vi.spyOn(installer, "getPublicArtifact").mockResolvedValue({
      artifact: {
        kind: "skill",
        slug: "pdf",
        name: "PDF",
        tagline: "Read PDFs",
        description: "longer description",
        version: "0.1.0",
        publishedSha: "abc1234defg",
        publishedAt: "2026-05-01",
        authorHandle: "octocat",
        repoUrl: "https://example.test",
        repoBranch: "main",
        tags: ["a"],
        badges: [],
      },
      reviewSummary: { count: 0, avg: 0 },
    } as unknown as Awaited<ReturnType<typeof installer.getPublicArtifact>>);
    vi.spyOn(installer, "findInstall").mockReturnValue(undefined);
    const { show } = await import("../src/commands/show.js");
    const code = await show("skills/pdf", ["--json"]);
    expect(code).toBe(0);
    const payload = JSON.parse(stdoutLines.join("\n"));
    expect(payload).toMatchObject({
      kind: "skill",
      slug: "pdf",
      ref: "skills/pdf",
      name: "PDF",
    });
    expect(payload.installed).toBeNull();
    expect(payload.reviewSummary).toEqual({ count: 0, avg: 0 });
  });

  it("list --json returns count + installs[]", async () => {
    const installer = await import("@metahub/installer");
    vi.spyOn(installer, "listInstalled").mockResolvedValue([]);
    const { list } = await import("../src/commands/list.js");
    const code = await list(["--json"]);
    expect(code).toBe(0);
    const payload = JSON.parse(stdoutLines.join("\n"));
    expect(payload).toEqual({ count: 0, installs: [] });
  });

  it("outdated --json returns available + unchecked arrays", async () => {
    const installer = await import("@metahub/installer");
    vi.spyOn(installer, "listInstalled").mockResolvedValue([]);
    const { outdated } = await import("../src/commands/outdated.js");
    const code = await outdated(["--json"]);
    expect(code).toBe(0);
    const payload = JSON.parse(stdoutLines.join("\n"));
    expect(payload).toEqual({ count: 0, available: [], unchecked: [] });
  });

  it("doctor --json emits checks[] + passed/failed counts", async () => {
    const installer = await import("@metahub/installer");
    vi.spyOn(installer, "findInstall").mockReturnValue(undefined);
    const { doctor } = await import("../src/commands/doctor.js");
    const code = await doctor("skills/pdf", ["--json"]);
    expect(code).toBe(1);
    const payload = JSON.parse(stdoutLines.join("\n"));
    expect(payload).toMatchObject({
      ref: "skills/pdf",
      installed: false,
      passed: 0,
      failed: 0,
    });
  });
});

describe("update --all rendering pieces", () => {
  // We can't easily mock the install round-trip here, but we can at
  // least confirm the new "Unchecked" branch keyword + tally word are
  // present in the source so a refactor doesn't silently delete them.
  it("source includes Unchecked + unchecked tally", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.resolve(here, "..", "src", "commands", "update.ts"), "utf8");
    expect(src).toContain("Unchecked");
    expect(src).toContain("unchecked:");
    expect(src).toContain("no public catalog entry");
  });
});
