/**
 * Tests for what a search hit actually discloses to the AI, plus the
 * two input/UX hardening fixes that shipped alongside it.
 *
 * The disclosure case is not hypothetical: the live catalog carries
 * `mcp/vulnerable-mcp-server-secrets-pii` (a deliberately vulnerable
 * pentesting lab from `appsecco/vulnerable-mcp-servers-lab`) which
 * ranks first for queries as generic as "server". Its tagline reads
 * "A simple MCP server with IP, weather, and news tools" — the warning
 * lives only in `description`, which the search hit used to drop. An AI
 * choosing what to install saw nothing but the benign line.
 */
import { describe, expect, it, vi } from "vitest";
import { searchItems } from "../src/tools/search";
import { installArtifactTool } from "../src/tools/install";
import type { RegistryItem } from "../src/types";

const DELIBERATELY_VULNERABLE =
  "A collection of servers which are deliberately vulnerable to learn Pentesting MCP Servers.";

describe("search hits carry the description, not just the tagline", () => {
  it("includes description on the portal path", async () => {
    const searcher = vi.fn(async () => ({
      items: [
        {
          kind: "mcp",
          slug: "vulnerable-mcp-server-secrets-pii",
          name: "vulnerable-mcp-server-secrets-pii",
          tagline: "A simple MCP server with IP, weather, and news tools",
          description: DELIBERATELY_VULNERABLE,
          repoUrl: "https://github.com/appsecco/vulnerable-mcp-servers-lab",
          installCount: 2,
          rank: 1,
        },
      ],
    }));
    const res = await searchItems(
      { query: "server", kind: "mcp" },
      { searcher: searcher as never },
    );
    expect(res.hits[0]?.description).toBe(DELIBERATELY_VULNERABLE);
    // The benign tagline is still present — the point is that it is no
    // longer the ONLY thing the model sees.
    expect(res.hits[0]?.tagline).toMatch(/simple MCP server/);
  });

  it("includes description on the degraded baked-catalog path too", async () => {
    const item: RegistryItem = {
      slug: "pdf",
      kind: "skill",
      name: "pdf",
      tagline: "benign tagline",
      description: DELIBERATELY_VULNERABLE,
      tags: [],
      author: { handle: "a", name: "A" },
      source: { type: "github", url: "https://github.com/a/pdf" },
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const res = await searchItems(
      { query: "pdf" },
      {
        searcher: (async () => {
          throw new Error("portal down");
        }) as never,
        registryLoader: async () => ({
          items: [item],
          generatedAt: "2026-01-01T00:00:00Z",
          counts: { skill: 1, mcp: 0, agent: 0, plugin: 0 },
        }),
      },
    );
    expect(res.degraded).toBe(true);
    expect(res.hits[0]?.description).toBe(DELIBERATELY_VULNERABLE);
  });

  it("clips a long description so a 50-hit search is not a context dump", async () => {
    const searcher = vi.fn(async () => ({
      items: [
        {
          kind: "skill",
          slug: "x",
          name: "x",
          tagline: "t",
          description: "y".repeat(5000),
          repoUrl: "https://github.com/a/x",
          rank: 1,
        },
      ],
    }));
    const res = await searchItems({ query: "x" }, { searcher: searcher as never });
    expect(res.hits[0]!.description.length).toBeLessThanOrEqual(280);
    expect(res.hits[0]!.description.endsWith("…")).toBe(true);
  });

  it("renders a missing description as an empty string, never undefined", async () => {
    const searcher = vi.fn(async () => ({
      items: [
        { kind: "skill", slug: "x", name: "x", tagline: "t", repoUrl: "https://g/x", rank: 1 },
      ],
    }));
    const res = await searchItems({ query: "x" }, { searcher: searcher as never });
    expect(res.hits[0]?.description).toBe("");
  });
});

describe("metahub_install names what it could not find", () => {
  it("turns the portal's bare 'not found' into an actionable message", async () => {
    await expect(
      installArtifactTool(
        { kind: "skill", slug: "no-such-thing" },
        {
          installer: (async () => {
            throw new Error("not found");
          }) as never,
        },
      ),
    ).rejects.toThrow(/kind=skill slug=no-such-thing.*metahub_search/s);
  });

  it("leaves an already-descriptive error alone", async () => {
    await expect(
      installArtifactTool(
        { kind: "skill", slug: "x" },
        {
          installer: (async () => {
            throw new Error("tarball checksum mismatch");
          }) as never,
        },
      ),
    ).rejects.toThrow(/^tarball checksum mismatch$/);
  });
});
