/**
 * Smoke tests for `buildServer`. Boots the configured `McpServer`
 * with stub fetchers + library overrides, connects an in-process MCP
 * `Client` over `InMemoryTransport`, and round-trips `listTools` /
 * `callTool` requests through real zod validation — no stdio, no
 * network, no filesystem.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthToken, DeviceCodeStart, DeviceCodeStatus } from "@metahub/auth";
import type { InstallResult, UninstallResult } from "@metahub/installer";
import { buildServer, type BuildServerOptions } from "../src/server";
import { clearRegistryCache } from "../src/registry-client";
import type { Registry, RegistryItem } from "../src/types";

const SAMPLE_ITEM: RegistryItem = {
  slug: "pdf",
  kind: "skill",
  name: "PDF Skill",
  tagline: "Read and analyse PDFs",
  description: "A skill for working with PDF documents end to end.",
  tags: ["pdf", "documents"],
  author: { handle: "alice", name: "Alice" },
  source: { type: "github", url: "https://github.com/alice/pdf" },
  updatedAt: "2026-01-01T00:00:00Z",
  popularity: 42,
  ratingSummary: { avg: 4.5, count: 8, distribution: [0, 0, 1, 2, 5] },
};

const FIXTURE_REGISTRY: Registry = {
  items: [SAMPLE_ITEM],
  generatedAt: "2026-01-01T00:00:00Z",
  counts: { skill: 1, mcp: 0, agent: 0, plugin: 0 },
};

function fixtureFetcher(): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(FIXTURE_REGISTRY), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

async function connect(mode: "stdio" | "http" = "stdio", extra: Partial<BuildServerOptions> = {}) {
  const server = buildServer({
    fetcher: fixtureFetcher(),
    url: "https://test/registry.json",
    mode,
    // Default the portal search to a throwing stub so metahub_search degrades to
    // the baked-registry fallback (the injected fetcher) instead of hitting the
    // real portal over the network. Individual tests override via `extra`.
    searchPublicArtifacts: async () => {
      throw new Error("portal unavailable (test)");
    },
    ...extra,
  });
  const client = new Client({ name: "test-client", version: "0.0.1" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { server, client };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const VALID_TOKEN: AuthToken = {
  token: "sess_abc",
  userId: "u_1",
  userHandle: "alice",
};

const STDIO_TOOLS = [
  "metahub_get",
  "metahub_install",
  "metahub_install_command",
  "metahub_list_installed",
  "metahub_my_artifacts",
  "metahub_my_stats",
  "metahub_search",
  "metahub_signin_begin",
  "metahub_signin_complete",
  "metahub_signout",
  "metahub_submit_review",
  "metahub_uninstall",
  "metahub_whoami",
].sort();

const HTTP_TOOLS = ["metahub_get", "metahub_install_command", "metahub_search"].sort();

describe("buildServer (integration via InMemoryTransport)", () => {
  it("exposes the full local tool set in stdio mode", async () => {
    const { client } = await connect("stdio");
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).toSorted();
    expect(names).toEqual(STDIO_TOOLS);
  });

  it("omits auth-required and FS-only tools in http mode", async () => {
    const { client } = await connect("http");
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).toSorted();
    expect(names).toEqual(HTTP_TOOLS);
  });

  it("metahub_my_artifacts returns the signin hint when no token is persisted", async () => {
    const { client } = await connect("stdio", { readPersistedToken: () => null });
    const res = await client.callTool({
      name: "metahub_my_artifacts",
      arguments: {},
    });
    expect(res.isError).toBe(true);
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toMatch(/metahub_signin/);
  });

  it("metahub_my_artifacts returns the portal payload when the token resolves", async () => {
    const portalFetcher = (async () =>
      jsonResponse({
        artifacts: [
          {
            id: "art_pdf",
            kind: "skill",
            slug: "pdf",
            name: "PDF",
            version: "1.0.0",
            publishedAt: "2026-01-01T00:00:00Z",
            visibility: "public",
          },
        ],
      })) as unknown as typeof fetch;
    const { client } = await connect("stdio", {
      portalFetcher,
      portalBaseUrl: "https://portal.test",
      readPersistedToken: () => VALID_TOKEN,
    });
    const res = await client.callTool({
      name: "metahub_my_artifacts",
      arguments: {},
    });
    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0]!.text) as {
      count: number;
      artifacts: Array<{ slug: string }>;
    };
    expect(payload.count).toBe(1);
    expect(payload.artifacts[0]?.slug).toBe("pdf");
  });

  it("metahub_my_stats surfaces a 403 as a publisher-mismatch message", async () => {
    let n = 0;
    const portalFetcher = (async () => {
      n++;
      if (n === 1) return jsonResponse({ artifact: { id: "art_pdf" } });
      return jsonResponse({ error: "forbidden" }, 403);
    }) as unknown as typeof fetch;
    const { client } = await connect("stdio", {
      portalFetcher,
      portalBaseUrl: "https://portal.test",
      readPersistedToken: () => VALID_TOKEN,
    });
    const res = await client.callTool({
      name: "metahub_my_stats",
      arguments: { kind: "skill", slug: "pdf" },
    });
    expect(res.isError).toBe(true);
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toMatch(/don't appear to be the publisher/);
  });

  it("metahub_my_stats reports a portal-bearer limitation when the portal returns 401 with a token present", async () => {
    // With a persisted token, a 401 from the portal means the portal hasn't
    // shipped user-bearer auth on that endpoint yet — NOT that the user needs
    // to re-sign-in. Surfacing the signin hint here would create a sign-in
    // loop, so we send a distinct "portal limitation" message instead.
    const portalFetcher = (async () =>
      jsonResponse({ error: "not authenticated" }, 401)) as unknown as typeof fetch;
    const { client } = await connect("stdio", {
      portalFetcher,
      portalBaseUrl: "https://portal.test",
      readPersistedToken: () => VALID_TOKEN,
    });
    const res = await client.callTool({
      name: "metahub_my_stats",
      arguments: { kind: "skill", slug: "pdf" },
    });
    expect(res.isError).toBe(true);
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toMatch(/portal hasn't deployed user-bearer auth/);
    expect(content[0]?.text).not.toMatch(/metahub_signin_begin/);
  });

  it("metahub_my_artifacts reports a portal-bearer limitation on 401 with a token present", async () => {
    const portalFetcher = (async () =>
      jsonResponse({ error: "not authenticated" }, 401)) as unknown as typeof fetch;
    const { client } = await connect("stdio", {
      portalFetcher,
      portalBaseUrl: "https://portal.test",
      readPersistedToken: () => VALID_TOKEN,
    });
    const res = await client.callTool({
      name: "metahub_my_artifacts",
      arguments: {},
    });
    expect(res.isError).toBe(true);
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toMatch(/portal hasn't deployed user-bearer auth/);
  });

  it("metahub_submit_review reports a portal-bearer limitation on 401 with a token present", async () => {
    // First call (artifact lookup) succeeds; second call (POST /api/public/reviews) 401s.
    let n = 0;
    const portalFetcher = (async () => {
      n++;
      if (n === 1) return jsonResponse({ artifact: { id: "art_pdf" } });
      return jsonResponse({ error: "not authenticated" }, 401);
    }) as unknown as typeof fetch;
    const { client } = await connect("stdio", {
      portalFetcher,
      portalBaseUrl: "https://portal.test",
      readPersistedToken: () => VALID_TOKEN,
    });
    const res = await client.callTool({
      name: "metahub_submit_review",
      arguments: { kind: "skill", slug: "pdf", rating: 5, body: "great" },
    });
    expect(res.isError).toBe(true);
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toMatch(/portal hasn't deployed user-bearer auth/);
  });

  it("metahub_submit_review rejects an invalid slug client-side via zod", async () => {
    const { client } = await connect("stdio", { readPersistedToken: () => VALID_TOKEN });
    const res = await client.callTool({
      name: "metahub_submit_review",
      arguments: { kind: "skill", slug: "Bad_Slug", rating: 5, body: "great" },
    });
    expect(res.isError).toBe(true);
  });

  it("metahub_install_command rejects an injection-y slug before building the install string", async () => {
    const { client } = await connect("stdio");
    const res = await client.callTool({
      name: "metahub_install_command",
      arguments: { kind: "skill", slug: "pdf; rm -rf ~" },
    });
    expect(res.isError).toBe(true);
  });

  it("metahub_install routes through the installer library", async () => {
    const fixtureResult: InstallResult = {
      artifactId: "art_pdf",
      installId: "ins_1",
      sha: "abc1234",
      name: "PDF Skill",
      version: "1.0.0",
      installPath: "/home/me/.claude/skills/pdf",
      clientsWired: [],
      skillMirrors: [],
      relatedSkills: [],
    };
    const installArtifact = (async () =>
      fixtureResult) as unknown as BuildServerOptions["installArtifact"];
    const { client } = await connect("stdio", { installArtifact });
    const res = await client.callTool({
      name: "metahub_install",
      arguments: { kind: "skill", slug: "pdf" },
    });
    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toMatch(/Installed PDF Skill v1\.0\.0/);
  });

  it("metahub_uninstall routes through the installer library", async () => {
    const fixtureResult: UninstallResult = {
      removed: true,
      record: {
        artifactId: "art_pdf",
        installId: "ins_1",
        slug: "pdf",
        kind: "skill",
        version: "1.0.0",
        installPath: "/x",
        ingestApiKey: "mhi_x",
        publishedSha: null,
        installedAt: "2026-01-01T00:00:00Z",
      },
    };
    const uninstallArtifact = (async () =>
      fixtureResult) as unknown as BuildServerOptions["uninstallArtifact"];
    const { client } = await connect("stdio", { uninstallArtifact });
    const res = await client.callTool({
      name: "metahub_uninstall",
      arguments: { kind: "skill", slug: "pdf" },
    });
    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toMatch(/Removed skill\/pdf/);
  });

  it("metahub_list_installed uses the installer library", async () => {
    // Pull the real library and stub its listInstalled via vi.mock? Easier:
    // just call it through and verify the response shape — `@metahub/installer`'s
    // default reads from `~/.metahub/installs.json`, which is absent in the test
    // env, so it returns []. We use a temp home to make that deterministic.
    const ORIGINAL_HOME = process.env.METAHUB_E2E_HOME;
    process.env.METAHUB_E2E_HOME = process.cwd() + "/.no-such-home-for-tests";
    try {
      const { client } = await connect("stdio");
      const res = await client.callTool({
        name: "metahub_list_installed",
        arguments: {},
      });
      expect(res.isError).toBeFalsy();
      const content = res.content as Array<{ type: string; text: string }>;
      const payload = JSON.parse(content[0]!.text) as { count: number };
      expect(payload.count).toBe(0);
    } finally {
      if (ORIGINAL_HOME === undefined) delete process.env.METAHUB_E2E_HOME;
      else process.env.METAHUB_E2E_HOME = ORIGINAL_HOME;
    }
  });

  it("metahub_signin_begin returns the verification URL + handle immediately without polling", async () => {
    const start = (async (): Promise<DeviceCodeStart> => ({
      verificationUrl: "https://github.com/login/device",
      userCode: "ABCD-1234",
      deviceCode: "dc_1",
      expiresIn: 600,
      interval: 5,
    })) as unknown as BuildServerOptions["startDeviceCodeFlow"];
    const poll = vi.fn(async (): Promise<DeviceCodeStatus> => {
      throw new Error("poll should not be called from begin");
    }) as unknown as BuildServerOptions["pollDeviceCode"];
    const { client } = await connect("stdio", {
      startDeviceCodeFlow: start,
      pollDeviceCode: poll,
    });
    const res = await client.callTool({
      name: "metahub_signin_begin",
      arguments: {},
    });
    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; text: string }>;
    const text = content[0]!.text;
    expect(text).toMatch(/https:\/\/github\.com\/login\/device/);
    expect(text).toMatch(/ABCD-1234/);
    // Handle must be present and copy-pasteable.
    expect(text).toMatch(/handle="dc_1"/);
    expect(text).toMatch(/metahub_signin_complete/);
  });

  it("metahub_signin_complete polls the supplied handle and reports 'Signed in' on success", async () => {
    const start = vi.fn(async (): Promise<DeviceCodeStart> => {
      throw new Error("start should not be called from complete");
    }) as unknown as BuildServerOptions["startDeviceCodeFlow"];
    const poll = vi.fn(async (handle: string): Promise<DeviceCodeStatus> => {
      expect(handle).toBe("dc_xyz");
      return {
        state: "complete",
        token: { token: "sess_xyz", userId: "u_1", userHandle: "alice" },
      };
    }) as unknown as BuildServerOptions["pollDeviceCode"];
    const { client } = await connect("stdio", {
      startDeviceCodeFlow: start,
      pollDeviceCode: poll,
      signinSleep: async () => {
        /* no-op */
      },
      signinNow: () => 0,
      signinMaxWaitMs: 5000,
    });
    const res = await client.callTool({
      name: "metahub_signin_complete",
      arguments: { handle: "dc_xyz", interval: 1 },
    });
    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toMatch(/Signed in to @alice/);
  });

  it("metahub_signin_complete surfaces a denied flow as isError=true", async () => {
    const poll = (async (): Promise<DeviceCodeStatus> => ({
      state: "denied",
    })) as unknown as BuildServerOptions["pollDeviceCode"];
    const { client } = await connect("stdio", {
      pollDeviceCode: poll,
      signinSleep: async () => {
        /* no-op */
      },
      signinNow: () => 0,
    });
    const res = await client.callTool({
      name: "metahub_signin_complete",
      arguments: { handle: "dc_abc", interval: 1 },
    });
    expect(res.isError).toBe(true);
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toMatch(/denied/);
    expect(content[0]?.text).toMatch(/metahub_signin_begin/);
  });

  it("metahub_signin_complete reports an expired code as isError=true with a retry hint", async () => {
    const poll = (async (): Promise<DeviceCodeStatus> => ({
      state: "expired",
    })) as unknown as BuildServerOptions["pollDeviceCode"];
    const { client } = await connect("stdio", {
      pollDeviceCode: poll,
      signinSleep: async () => {
        /* no-op */
      },
      signinNow: () => 0,
    });
    const res = await client.callTool({
      name: "metahub_signin_complete",
      arguments: { handle: "dc_old", interval: 1 },
    });
    expect(res.isError).toBe(true);
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toMatch(/expired/);
    expect(content[0]?.text).toMatch(/metahub_signin_begin/);
  });

  it("metahub_signin_complete rejects an empty handle via zod", async () => {
    const { client } = await connect("stdio");
    const res = await client.callTool({
      name: "metahub_signin_complete",
      arguments: { handle: "" },
    });
    expect(res.isError).toBe(true);
  });

  it("metahub_signout clears the persisted token", async () => {
    const clear = (() => {
      /* no-op */
    }) as unknown as BuildServerOptions["clearPersistedToken"];
    const { client } = await connect("stdio", { clearPersistedToken: clear });
    const res = await client.callTool({
      name: "metahub_signout",
      arguments: {},
    });
    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toMatch(/Signed out/);
  });

  it("metahub_whoami returns the cached identity", async () => {
    const { client } = await connect("stdio", { readPersistedToken: () => VALID_TOKEN });
    const res = await client.callTool({
      name: "metahub_whoami",
      arguments: {},
    });
    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0]!.text) as {
      signedIn: boolean;
      userHandle: string | null;
    };
    expect(payload.signedIn).toBe(true);
    expect(payload.userHandle).toBe("alice");
  });

  it("metahub_whoami returns signedIn=false when no token is persisted", async () => {
    const { client } = await connect("stdio", { readPersistedToken: () => null });
    const res = await client.callTool({
      name: "metahub_whoami",
      arguments: {},
    });
    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0]!.text) as { signedIn: boolean };
    expect(payload.signedIn).toBe(false);
  });

  it("round-trips metahub_search with zod validation end to end", async () => {
    const { client } = await connect();
    const res = await client.callTool({
      name: "metahub_search",
      arguments: { query: "pdf", kind: "skill" },
    });
    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content?.[0]?.type).toBe("text");
    const payload = JSON.parse(content[0]!.text) as {
      count: number;
      hits: Array<{ slug: string }>;
    };
    expect(payload.count).toBe(1);
    expect(payload.hits[0]?.slug).toBe("pdf");
  });

  it("returns isError=true from metahub_get when the slug is missing", async () => {
    const { client } = await connect();
    const res = await client.callTool({
      name: "metahub_get",
      arguments: { kind: "skill", slug: "does-not-exist" },
    });
    expect(res.isError).toBe(true);
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content?.[0]?.text).toMatch(/No artifact found/);
  });

  it("returns the artifact record from metahub_get when the slug exists", async () => {
    const { client } = await connect();
    const res = await client.callTool({
      name: "metahub_get",
      arguments: { kind: "skill", slug: "pdf" },
    });
    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; text: string }>;
    const item = JSON.parse(content[0]!.text) as { slug: string; name: string };
    expect(item.slug).toBe("pdf");
    expect(item.name).toBe("PDF Skill");
  });

  it("returns the mh install command from metahub_install_command", async () => {
    const { client } = await connect();
    const res = await client.callTool({
      name: "metahub_install_command",
      arguments: { kind: "skill", slug: "pdf" },
    });
    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0]!.text) as { command: string; tip: string };
    expect(payload.command).toBe("mh install skills/pdf");
    expect(payload.tip).toMatch(/MetaHub CLI/);
  });
});

describe("buildServer — uncovered branches", () => {
  // These tests poke the error paths and optional-field handling that the
  // happy-path smoke tests above don't reach. The registry fetch is
  // memoised module-side, so clear it before and after each test that
  // swaps in a failing fetcher.
  beforeEach(() => {
    clearRegistryCache();
  });
  afterEach(() => {
    clearRegistryCache();
  });

  it("defaults to stdio mode when no mode is supplied", async () => {
    // buildServer({}) with no `mode` → the `?? "stdio"` default fires, so
    // the local-only tools are registered. We connect without the test
    // fetcher and just assert the local tool set is present.
    const server = buildServer({ fetcher: fixtureFetcher(), url: "https://test/registry.json" });
    const client = new Client({ name: "test-client", version: "0.0.1" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).toSorted();
    expect(names).toEqual(STDIO_TOOLS);
  });

  it("metahub_install surfaces a non-Error thrown value via toolError", async () => {
    // The installer throws a bare string (not an Error). toolError must
    // coerce it via String(err) rather than reading `.message`.
    const installArtifact = (async () => {
      throw "disk full";
    }) as unknown as BuildServerOptions["installArtifact"];
    const { client } = await connect("stdio", { installArtifact });
    const res = await client.callTool({
      name: "metahub_install",
      arguments: { kind: "skill", slug: "pdf" },
    });
    expect(res.isError).toBe(true);
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toBe("metahub_install failed: disk full");
  });

  it("metahub_search reports a registry fetch failure via toolError", async () => {
    const failingFetcher = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const { client } = await connect("stdio", { fetcher: failingFetcher });
    const res = await client.callTool({
      name: "metahub_search",
      arguments: { query: "pdf" },
    });
    expect(res.isError).toBe(true);
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toMatch(/metahub_search failed:.*network down/);
  });

  it("metahub_my_artifacts surfaces a 404 PortalError message verbatim", async () => {
    const portalFetcher = (async () =>
      jsonResponse({ error: "no such artifact" }, 404)) as unknown as typeof fetch;
    const { client } = await connect("stdio", {
      portalFetcher,
      portalBaseUrl: "https://portal.test",
      readPersistedToken: () => VALID_TOKEN,
    });
    const res = await client.callTool({ name: "metahub_my_artifacts", arguments: {} });
    expect(res.isError).toBe(true);
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toBe("no such artifact");
  });

  it("metahub_my_artifacts surfaces a generic 500 PortalError with the HTTP status", async () => {
    const portalFetcher = (async () =>
      jsonResponse({ error: "boom" }, 500)) as unknown as typeof fetch;
    const { client } = await connect("stdio", {
      portalFetcher,
      portalBaseUrl: "https://portal.test",
      readPersistedToken: () => VALID_TOKEN,
    });
    const res = await client.callTool({ name: "metahub_my_artifacts", arguments: {} });
    expect(res.isError).toBe(true);
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toMatch(/metahub_my_artifacts failed \(HTTP 500\): boom/);
  });

  it("metahub_my_artifacts surfaces a non-PortalError via toolError", async () => {
    // The fetcher throws synchronously (not a PortalError), so
    // publisherToolError must fall through to the generic toolError.
    const portalFetcher = (() => {
      throw new TypeError("not a portal error");
    }) as unknown as typeof fetch;
    const { client } = await connect("stdio", {
      portalFetcher,
      portalBaseUrl: "https://portal.test",
      readPersistedToken: () => VALID_TOKEN,
    });
    const res = await client.callTool({ name: "metahub_my_artifacts", arguments: {} });
    expect(res.isError).toBe(true);
    const content = res.content as Array<{ type: string; text: string }>;
    // PortalError wraps thrown fetcher errors as status 0, so this still
    // routes through the generic "(HTTP 0)" branch with the message.
    expect(content[0]?.text).toMatch(/metahub_my_artifacts failed/);
  });

  it("metahub_my_stats returns the signin hint when no token is persisted", async () => {
    const { client } = await connect("stdio", { readPersistedToken: () => null });
    const res = await client.callTool({
      name: "metahub_my_stats",
      arguments: { kind: "skill", slug: "pdf" },
    });
    expect(res.isError).toBe(true);
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toMatch(/metahub_signin/);
  });

  it("metahub_submit_review returns the signin hint when no token is persisted", async () => {
    const { client } = await connect("stdio", { readPersistedToken: () => null });
    const res = await client.callTool({
      name: "metahub_submit_review",
      arguments: { kind: "skill", slug: "pdf", rating: 5, body: "great" },
    });
    expect(res.isError).toBe(true);
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toMatch(/metahub_signin/);
  });

  it("metahub_my_stats returns the observability payload on success", async () => {
    let n = 0;
    const portalFetcher = (async () => {
      n++;
      if (n === 1) return jsonResponse({ artifact: { id: "art_pdf" } });
      return jsonResponse({ windowDays: 30, totals: { invocations: 12 } });
    }) as unknown as typeof fetch;
    const { client } = await connect("stdio", {
      portalFetcher,
      portalBaseUrl: "https://portal.test",
      readPersistedToken: () => VALID_TOKEN,
    });
    const res = await client.callTool({
      name: "metahub_my_stats",
      arguments: { kind: "skill", slug: "pdf", windowDays: 30 },
    });
    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0]!.text) as { windowDays: number };
    expect(payload.windowDays).toBe(30);
  });

  it("metahub_submit_review returns the persisted review on success", async () => {
    let n = 0;
    const portalFetcher = (async () => {
      n++;
      if (n === 1) return jsonResponse({ artifact: { id: "art_pdf" } });
      return jsonResponse({
        ok: true,
        review: {
          id: "rev_1",
          artifactId: "art_pdf",
          rating: 5,
          title: "Great",
          body: "great skill",
          authorName: "Alice",
          authorHandle: "alice",
          verifiedUser: true,
          createdMs: 1,
        },
      });
    }) as unknown as typeof fetch;
    const { client } = await connect("stdio", {
      portalFetcher,
      portalBaseUrl: "https://portal.test",
      readPersistedToken: () => VALID_TOKEN,
    });
    const res = await client.callTool({
      name: "metahub_submit_review",
      arguments: { kind: "skill", slug: "pdf", rating: 5, body: "great skill", title: "Great" },
    });
    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0]!.text) as { review: { id: string } };
    expect(payload.review.id).toBe("rev_1");
  });

  it("metahub_signin_complete defaults interval to 5 and handles a missing user handle", async () => {
    // No `interval` arg → the `?? 5` default fires. The poll returns
    // complete with no userHandle → the "your MetaHub account" branch.
    const poll = (async (): Promise<DeviceCodeStatus> => ({
      state: "complete",
      token: { token: "sess_z", userId: "u_9", userHandle: "" },
    })) as unknown as BuildServerOptions["pollDeviceCode"];
    const { client } = await connect("stdio", {
      pollDeviceCode: poll,
      signinSleep: async () => {
        /* no-op */
      },
      signinNow: () => 0,
      signinMaxWaitMs: 5000,
    });
    const res = await client.callTool({
      name: "metahub_signin_complete",
      arguments: { handle: "dc_nohandle" },
    });
    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toMatch(/Signed in to your MetaHub account/);
  });

  it("metahub_signin_complete reports a timeout as isError=true", async () => {
    const poll = (async (): Promise<DeviceCodeStatus> => ({
      state: "pending",
      interval: 1,
    })) as unknown as BuildServerOptions["pollDeviceCode"];
    let t = 0;
    const { client } = await connect("stdio", {
      pollDeviceCode: poll,
      signinSleep: async () => {
        /* no-op */
      },
      // Each now() jumps 200ms so the loop exhausts maxWaitMs quickly.
      signinNow: () => {
        const out = t;
        t += 200;
        return out;
      },
      signinMaxWaitMs: 400,
    });
    const res = await client.callTool({
      name: "metahub_signin_complete",
      arguments: { handle: "dc_timeout", interval: 1 },
    });
    expect(res.isError).toBe(true);
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toMatch(/timed out/);
  });

  it("reads metahub://catalog as JSON on success", async () => {
    const { client } = await connect("stdio");
    const res = await client.readResource({ uri: "metahub://catalog" });
    const contents = res.contents as Array<{ uri: string; mimeType: string; text: string }>;
    expect(contents[0]?.mimeType).toBe("application/json");
    const registry = JSON.parse(contents[0]!.text) as Registry;
    expect(registry.items[0]?.slug).toBe("pdf");
  });

  it("propagates a metahub://catalog read failure as an error", async () => {
    const failingFetcher = (async () => {
      throw new Error("registry offline");
    }) as unknown as typeof fetch;
    const { client } = await connect("stdio", { fetcher: failingFetcher });
    await expect(client.readResource({ uri: "metahub://catalog" })).rejects.toThrow(
      /catalog read failed/,
    );
  });
});
