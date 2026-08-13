/**
 * End-to-end smoke for the HTTP transport. Boots `startHttp` on a
 * random port, exercises `/healthz`, the MCP `initialize` handshake,
 * and a `tools/list` round-trip, then asserts clean shutdown.
 *
 * Note: we do NOT mock the SDK transport here — we send real
 * JSON-RPC over real HTTP through `fetch`. The registry fetcher is
 * stubbed via env so we never hit the network.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttp, type RunningHttpServer } from "../../src/transports/http";

const FIXTURE_REGISTRY = {
  items: [
    {
      slug: "pdf",
      kind: "skill" as const,
      name: "PDF Skill",
      tagline: "Read and analyse PDFs",
      description: "A skill for working with PDF documents end to end.",
      tags: ["pdf", "documents"],
      author: { handle: "alice", name: "Alice" },
      source: { type: "github" as const, url: "https://github.com/alice/pdf" },
      updatedAt: "2026-01-01T00:00:00Z",
    },
  ],
  generatedAt: "2026-01-01T00:00:00Z",
  counts: { skill: 1, mcp: 0, agent: 0, plugin: 0 },
};

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_REGISTRY_URL = process.env.METAHUB_REGISTRY_URL;
const ORIGINAL_PORTAL_URL = process.env.METAHUB_PORTAL_URL;
const FIXTURE_URL = "https://registry-fixture.test/registry.json";
const PORTAL_FIXTURE_URL = "https://portal-fixture.test";

function patchRegistryFetch(): void {
  process.env.METAHUB_REGISTRY_URL = FIXTURE_URL;
  // metahub_search is portal-primary; point it at a fixture host (never the real
  // portal) so the test can never reach out over the network for live data.
  process.env.METAHUB_PORTAL_URL = PORTAL_FIXTURE_URL;
  // Wrap global fetch: serve the fixture registry, fail the portal search so the
  // tool deterministically degrades to ranking the baked fixture (1 item), and
  // defer the client transport's HTTP traffic against our local server to the
  // real fetch.
  const wrapped: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    if (url === FIXTURE_URL) {
      return new Response(JSON.stringify(FIXTURE_REGISTRY), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/public/artifacts/search")) {
      // Stub the portal as unavailable → metahub_search falls back to the baked
      // fixture registry, giving a deterministic count (no live-portal dependency).
      return new Response("portal unavailable (test stub)", { status: 503 });
    }
    return ORIGINAL_FETCH(input as Parameters<typeof fetch>[0], init);
  };
  globalThis.fetch = wrapped;
}

function restoreFetch(): void {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_REGISTRY_URL === undefined) delete process.env.METAHUB_REGISTRY_URL;
  else process.env.METAHUB_REGISTRY_URL = ORIGINAL_REGISTRY_URL;
  if (ORIGINAL_PORTAL_URL === undefined) delete process.env.METAHUB_PORTAL_URL;
  else process.env.METAHUB_PORTAL_URL = ORIGINAL_PORTAL_URL;
}

describe("http transport", () => {
  let running: RunningHttpServer | undefined;

  beforeEach(() => {
    patchRegistryFetch();
  });

  afterEach(async () => {
    if (running) {
      await running.close();
      running = undefined;
    }
    restoreFetch();
  });

  it("listens on the requested port and serves /healthz", async () => {
    running = await startHttp({ port: 0, host: "127.0.0.1" });
    expect(running.port).toBeGreaterThan(0);

    const res = await ORIGINAL_FETCH(`http://127.0.0.1:${running.port}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; name: string; version: string };
    expect(body.status).toBe("ok");
    expect(body.name).toBe("metahub");
    expect(typeof body.version).toBe("string");
  });

  it("emits permissive CORS headers", async () => {
    running = await startHttp({ port: 0, host: "127.0.0.1" });
    const res = await ORIGINAL_FETCH(`http://127.0.0.1:${running.port}/healthz`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("answers OPTIONS preflight with 204 and CORS headers", async () => {
    running = await startHttp({ port: 0, host: "127.0.0.1" });
    const res = await ORIGINAL_FETCH(`http://127.0.0.1:${running.port}/mcp`, {
      method: "OPTIONS",
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("speaks MCP over streamable HTTP and omits metahub_list_installed", async () => {
    running = await startHttp({ port: 0, host: "127.0.0.1" });
    const url = new URL(`http://127.0.0.1:${running.port}/mcp`);
    const client = new Client({ name: "http-test-client", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(url);
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      // metahub_list_installed must NOT appear over HTTP — see
      // server.ts for rationale.
      expect(names).toEqual(["metahub_get", "metahub_install_command", "metahub_search"].sort());

      const res = await client.callTool({
        name: "metahub_search",
        arguments: { query: "pdf" },
      });
      expect(res.isError).toBeFalsy();
      const content = res.content as Array<{ type: string; text: string }>;
      const payload = JSON.parse(content[0]!.text) as {
        count: number;
        hits: Array<{ slug: string }>;
      };
      expect(payload.count).toBe(1);
      expect(payload.hits[0]?.slug).toBe("pdf");
    } finally {
      await client.close();
    }
  });
});
