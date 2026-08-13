import { describe, expect, it } from "vitest";
import type { ArtifactKind } from "@metahub/shared";
import { ALL_KINDS, parseRef, resolveBareSlug } from "../src/lib/resolve-ref.js";

describe("parseRef", () => {
  it("parses singular kind segments", () => {
    expect(parseRef("skill/pdf")).toEqual({ ok: true, ref: { kind: "skill", slug: "pdf" } });
    expect(parseRef("mcp/github")).toEqual({ ok: true, ref: { kind: "mcp", slug: "github" } });
  });

  it("parses plural kind segments", () => {
    expect(parseRef("skills/pdf")).toEqual({ ok: true, ref: { kind: "skill", slug: "pdf" } });
    expect(parseRef("agents/code-reviewer")).toEqual({
      ok: true,
      ref: { kind: "agent", slug: "code-reviewer" },
    });
    expect(parseRef("plugins/frontend-dev")).toEqual({
      ok: true,
      ref: { kind: "plugin", slug: "frontend-dev" },
    });
  });

  it("is case-insensitive on the kind segment", () => {
    expect(parseRef("Skills/pdf")).toEqual({ ok: true, ref: { kind: "skill", slug: "pdf" } });
    expect(parseRef("MCPS/github")).toEqual({ ok: true, ref: { kind: "mcp", slug: "github" } });
  });

  it("returns the bare slug when there is no kind segment", () => {
    expect(parseRef("hello-metahub")).toEqual({ ok: true, bareSlug: "hello-metahub" });
  });

  it("keeps slashes after the first one inside the slug", () => {
    expect(parseRef("skills/team/pdf")).toEqual({
      ok: true,
      ref: { kind: "skill", slug: "team/pdf" },
    });
  });

  it("rejects unknown kind segments, reporting the segment", () => {
    expect(parseRef("wat/pdf")).toEqual({ ok: false, badKindSegment: "wat" });
  });
});

describe("resolveBareSlug", () => {
  const probeFor =
    (present: ArtifactKind[]) =>
    async (kind: ArtifactKind, _slug: string): Promise<boolean> =>
      present.includes(kind);

  it("probes every kind", async () => {
    const probed: ArtifactKind[] = [];
    await resolveBareSlug("x", async (kind) => {
      probed.push(kind);
      return false;
    });
    expect(probed.sort()).toEqual([...ALL_KINDS].sort());
  });

  it("returns the single matching kind", async () => {
    expect(await resolveBareSlug("x", probeFor(["skill"]))).toEqual(["skill"]);
  });

  it("returns every matching kind on ambiguity", async () => {
    expect(await resolveBareSlug("x", probeFor(["skill", "mcp"]))).toEqual(["skill", "mcp"]);
  });

  it("returns empty when nothing matches", async () => {
    expect(await resolveBareSlug("x", probeFor([]))).toEqual([]);
  });

  it("treats a rejecting probe as not-found instead of failing", async () => {
    const kinds = await resolveBareSlug("x", async (kind) => {
      if (kind === "mcp") throw new Error("HTTP 500");
      return kind === "skill";
    });
    expect(kinds).toEqual(["skill"]);
  });
});
