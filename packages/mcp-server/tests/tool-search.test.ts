/**
 * Discoverability under Claude Code's tool search.
 *
 * Tool search is ON BY DEFAULT in Claude Code, and it changes how these
 * tools get reached. Rather than every definition sitting in context,
 * definitions are deferred and Claude searches a catalog; the search
 * matches against **tool name, description, argument names, and argument
 * descriptions** (case-insensitive), and returns only **5 tools per
 * search** by default. See:
 *   https://code.claude.com/docs/en/agent-sdk/tool-search
 *   https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
 *
 * Two consequences this file pins:
 *
 *   1. If the vocabulary a user actually types ("marketplace", "registry",
 *      "discover", "capability", "extension") appears nowhere in the tool
 *      surface, MetaHub is simply not found — the server can be perfectly
 *      healthy and still never get called.
 *   2. With only 5 slots, tools that repeat each other's boilerplate crowd
 *      each other out. Discovery-shaped queries must resolve to the entry
 *      point (`metahub_search`), not to six near-identical descriptions.
 *
 * These are assertions about description content, so they are brittle by
 * design: rewording a description should force a conscious re-check that
 * the tool is still reachable.
 */
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/** Default `limit` the tool search returns per query. */
const SEARCH_RESULT_LIMIT = 5;

async function toolSurface(): Promise<Array<{ name: string; text: string }>> {
  const server = buildServer({ mode: "stdio" });
  const client = new Client({ name: "t", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const { tools } = await client.listTools();
  // Reconstruct exactly what the API indexes for a tool.
  return tools.map((t) => {
    const parts: string[] = [t.name, t.description ?? ""];
    const props = (t.inputSchema?.properties ?? {}) as Record<
      string,
      { description?: string; enum?: unknown[] }
    >;
    for (const [argName, spec] of Object.entries(props)) {
      parts.push(argName);
      if (spec?.description) parts.push(spec.description);
      if (Array.isArray(spec?.enum)) parts.push(spec.enum.join(" "));
    }
    return { name: t.name, text: parts.join(" ").toLowerCase() };
  });
}

function matching(surface: Array<{ name: string; text: string }>, pattern: string): string[] {
  const re = new RegExp(pattern, "i");
  return surface.filter((t) => re.test(t.text)).map((t) => t.name);
}

describe("tool search discoverability", () => {
  it("covers the vocabulary users actually type for discovery", async () => {
    const surface = await toolSurface();
    const corpus = surface.map((t) => t.text).join(" ");
    // Each of these is a phrasing a user reaches for when they want a new
    // capability. Absent from the surface = MetaHub is never searched up.
    for (const word of [
      "registry",
      "marketplace",
      "app store",
      "catalog",
      "discover",
      "browse",
      "capability",
      "extension",
      "editor",
      "claude code",
      "cursor",
      "skill",
      "mcp server",
      "agent",
      "plugin",
      "install",
      "uninstall",
    ]) {
      expect(corpus, `"${word}" missing from the tool surface`).toContain(word);
    }
  });

  it("routes discovery-shaped queries to the entry point, not the whole server", async () => {
    const surface = await toolSurface();
    // A pattern Claude plausibly writes for "find/browse/discover something".
    // These must land on metahub_search and must not burn all 5 slots.
    for (const pattern of ["discover", "marketplace|app.?store", "registry", "catalog"]) {
      const hits = matching(surface, pattern);
      expect(hits, `/${pattern}/ should match metahub_search`).toContain("metahub_search");
      expect(
        hits.length,
        `/${pattern}/ matched ${hits.length} tools (${hits.join(", ")}) — with only ` +
          `${SEARCH_RESULT_LIMIT} result slots, a broad discovery pattern must stay focused`,
      ).toBeLessThanOrEqual(SEARCH_RESULT_LIMIT);
    }
  });

  it("gives the install path its own vocabulary", async () => {
    const surface = await toolSurface();
    expect(matching(surface, "install|add|set up")).toContain("metahub_install");
    expect(matching(surface, "uninstall|remove|delete")).toContain("metahub_uninstall");
    expect(matching(surface, "already have installed|list what")).toContain(
      "metahub_list_installed",
    );
  });

  it("tells the model to read the publisher description before recommending", async () => {
    // Pairs with the disclosure fix: search hits now carry `description`,
    // and the tool description points the model at it. A benign tagline on
    // a deliberately vulnerable listing should not be the whole story.
    const surface = await toolSurface();
    const search = surface.find((t) => t.name === "metahub_search");
    expect(search?.text).toMatch(/description/);
  });

  it("keeps every tool description substantial enough to be matched", async () => {
    const surface = await toolSurface();
    for (const t of surface) {
      expect(t.text.length, `${t.name} has a thin search surface`).toBeGreaterThan(120);
    }
  });
});
