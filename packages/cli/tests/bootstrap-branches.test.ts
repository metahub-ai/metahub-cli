/**
 * Branch-coverage tests for lib/bootstrap.ts that the real-config
 * integration tests in bootstrap.test.ts can't reach deterministically.
 *
 * Those tests exercise the happy path against a real tmp HOME, which
 * leaves the resolver-fallback paths in findMetahubMcpBin() and the
 * non-JSON / malformed-config branches in bootstrapStatus() uncovered
 * (and behave differently on Windows, where os.homedir() ignores
 * process.env.HOME). Here we mock @metahub/installer's CLIENT_ADAPTERS,
 * @metahub/auth's loadAuthConfig, node:module's createRequire, and
 * node:fs so every branch executes the same way on any OS.
 *
 * Each test re-imports lib/bootstrap.js fresh after wiring its mocks so
 * the module-level `import { CLIENT_ADAPTERS } from "@metahub/installer"`
 * binding picks up the mocked value.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import type * as NodeModule from "node:module";

// A controllable CLIENT_ADAPTERS the bootstrap module will import.
type Adapter = { name: string; detect: () => boolean; configPath: () => string };
let adapters: Adapter[] = [];
const wireSpy = vi.fn(() => [] as Array<{ client: string; status: string; configPath: string }>);
const unwireSpy = vi.fn();
let authConfig = {
  portalUrl: "https://portal.test",
  registryUrl: "https://registry.test",
};

const MOCK_HOME = "/nonexistent/mh-branch-tests";

vi.mock("@metahub/installer", () => ({
  get CLIENT_ADAPTERS() {
    return adapters;
  },
  wireMcpAcrossClients: (...args: unknown[]) => wireSpy(...(args as [])),
  unwireMcpAcrossClients: (...args: unknown[]) => unwireSpy(...(args as [])),
  // The instruction-file module resolves its targets through these; a
  // home that cannot exist keeps every target "not detected".
  getHome: () => MOCK_HOME,
  userConfigDir: () => `${MOCK_HOME}/.config`,
  geminiDir: () => `${MOCK_HOME}/.gemini`,
  codexBinary: () => null,
  readJsonConfig: (file: string) => {
    try {
      const raw = fs.readFileSync(file, "utf8") as string;
      return { state: "ok", data: JSON.parse(raw) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
      return { state: "invalid", error: (err as Error).message };
    }
  },
}));

const MOCK_DEFAULT_REGISTRY_URL = "https://registry.metahub.ai";

vi.mock("@metahub/auth", () => ({
  loadAuthConfig: () => authConfig,
  DEFAULT_REGISTRY_URL: MOCK_DEFAULT_REGISTRY_URL,
  // Mirrors the real helper: a registryUrl that is empty, or merely the
  // default the config layer always fills in, is not a user choice.
  explicitRegistryUrl: () => {
    const chosen = authConfig.registryUrl;
    return chosen && chosen.length > 0 && chosen !== MOCK_DEFAULT_REGISTRY_URL ? chosen : undefined;
  },
}));

async function freshBootstrap() {
  vi.resetModules();
  return import("../src/lib/bootstrap.js");
}

beforeEach(() => {
  // These tests drive the MCP wiring branches; the instruction-file
  // writes are covered in instructions.test.ts against a real tmp HOME.
  process.env.METAHUB_NO_INSTRUCTIONS = "1";
});

afterEach(() => {
  delete process.env.METAHUB_NO_INSTRUCTIONS;
  vi.restoreAllMocks();
  adapters = [];
  wireSpy.mockClear();
  unwireSpy.mockClear();
  authConfig = { portalUrl: "https://portal.test", registryUrl: "https://registry.test" };
});

describe("findMetahubMcpBin — resolver fallback paths", () => {
  beforeEach(() => {
    // The real resolver would find Path 1 (@metahub-ai/mh/bin) in a
    // built workspace; force every require.resolve to throw so the
    // function falls through to the sibling-folder traversal.
    vi.doMock("node:module", async (importOriginal) => {
      const orig = (await importOriginal()) as typeof NodeModule;
      return {
        ...orig,
        createRequire: () =>
          ({
            resolve: () => {
              throw new Error("MODULE_NOT_FOUND");
            },
          }) as unknown as NodeRequire,
      };
    });
  });

  afterEach(() => {
    vi.doUnmock("node:module");
  });

  it("falls through Path 1 + Path 2 to the sibling-folder traversal (Path 3)", async () => {
    // existsSync returns true the first time the traversal probes a
    // candidate, so we exercise the success branch of the loop.
    const spy = vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const { findMetahubMcpBin } = await freshBootstrap();
    const bin = findMetahubMcpBin();
    expect(bin).toContain("metahub-mcp.js");
    expect(bin).toContain(`mcp-server`);
    expect(spy).toHaveBeenCalled();
  });

  it("throws a reinstall hint when no candidate resolves anywhere", async () => {
    // Nothing exists on disk → Path 1/2 throw, Path 3 loop never
    // returns, the function hits the final throw.
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const { findMetahubMcpBin } = await freshBootstrap();
    expect(() => findMetahubMcpBin()).toThrow(/Could not locate the MetaHub MCP server/);
    expect(() => findMetahubMcpBin()).toThrow(/install\.sh/);
  });
});

describe("bootstrapStatus — per-client branch matrix", () => {
  const BIN = "/abs/path/to/metahub-mcp.js";

  it("reports not-detected when the client root is absent", async () => {
    adapters = [{ name: "Ghost", detect: () => false, configPath: () => "/x/config.json" }];
    const { bootstrapStatus } = await freshBootstrap();
    const rows = bootstrapStatus(BIN);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("not-detected");
    expect(rows[0]!.configPath).toBe("/x/config.json");
  });

  it("reports manual for a detected non-JSON client (YAML/TOML/UI)", async () => {
    adapters = [
      { name: "Continue", detect: () => true, configPath: () => "/home/.continue/config.yaml" },
    ];
    const { bootstrapStatus } = await freshBootstrap();
    const rows = bootstrapStatus(BIN);
    expect(rows[0]!.state).toBe("manual");
  });

  it("reports absent for a detected JSON client whose config file does not exist", async () => {
    adapters = [{ name: "Cursor", detect: () => true, configPath: () => "/home/.cursor/mcp.json" }];
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const { bootstrapStatus } = await freshBootstrap();
    const rows = bootstrapStatus(BIN);
    expect(rows[0]!.state).toBe("absent");
  });

  it("reports absent when the JSON parses but has no metahub entry", async () => {
    adapters = [{ name: "Claude", detect: () => true, configPath: () => "/home/.claude/s.json" }];
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ mcpServers: { other: {} } }));
    const { bootstrapStatus } = await freshBootstrap();
    const rows = bootstrapStatus(BIN);
    expect(rows[0]!.state).toBe("absent");
  });

  it("reports wired when an entry points at this exact bin", async () => {
    adapters = [{ name: "Claude", detect: () => true, configPath: () => "/home/.claude/s.json" }];
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ mcpServers: { metahub: { command: "node", args: [BIN] } } }),
    );
    const { bootstrapStatus } = await freshBootstrap();
    const rows = bootstrapStatus(BIN);
    expect(rows[0]!.state).toBe("wired");
    expect(rows[0]!.existingArgs).toEqual([BIN]);
  });

  it("reports wired-elsewhere when an entry points at a different bin", async () => {
    adapters = [{ name: "Cursor", detect: () => true, configPath: () => "/home/.cursor/mcp.json" }];
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ servers: { metahub: { command: "node", args: ["/old/bin.js"] } } }),
    );
    const { bootstrapStatus } = await freshBootstrap();
    const rows = bootstrapStatus(BIN);
    expect(rows[0]!.state).toBe("wired-elsewhere");
    expect(rows[0]!.existingArgs).toEqual(["/old/bin.js"]);
  });

  it("falls back to absent when the config JSON is malformed (parse throws)", async () => {
    adapters = [{ name: "Zed", detect: () => true, configPath: () => "/home/zed/settings.json" }];
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue("{ this is not json ");
    const { bootstrapStatus } = await freshBootstrap();
    const rows = bootstrapStatus(BIN);
    expect(rows[0]!.state).toBe("absent");
  });
});

describe("bootstrapMetahubMcp — wiring orchestration", () => {
  // findMetahubMcpBin needs to resolve a bin; point Path 3 at a real
  // existing file so the function returns without throwing.
  beforeEach(() => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
  });

  it("short-circuits with no writes when every detected client is already wired", async () => {
    // A single detected JSON client already pointing at the resolved
    // bin → needWire is empty → early return, wireMcpAcrossClients
    // never called.
    const mod = await freshBootstrap();
    const { bootstrapMetahubMcp, findMetahubMcpBin } = mod;
    // Resolve the bin the production code will compute, then make the
    // client config already point at it (so bootstrapStatus marks the
    // client "wired" and the non-force run skips it).
    const resolvedBin = findMetahubMcpBin();
    adapters = [{ name: "Claude", detect: () => true, configPath: () => "/home/.claude/s.json" }];
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ mcpServers: { metahub: { command: "node", args: [resolvedBin] } } }),
    );
    const res = bootstrapMetahubMcp();
    expect(res.results).toHaveLength(0);
    expect(wireSpy).not.toHaveBeenCalled();
    expect(res.bin).toContain("metahub-mcp.js");
  });

  it("calls wireMcpAcrossClients with the forwarded env when a client needs wiring", async () => {
    adapters = [{ name: "Cursor", detect: () => true, configPath: () => "/home/.cursor/mcp.json" }];
    // Detected JSON client with NO metahub entry → absent → needs wiring.
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ servers: {} }));
    const { bootstrapMetahubMcp } = await freshBootstrap();
    const res = bootstrapMetahubMcp();
    expect(wireSpy).toHaveBeenCalledTimes(1);
    const [slug, launch, env] = wireSpy.mock.calls[0] as [
      string,
      { command: string; args: string[] },
      Record<string, string>,
    ];
    expect(slug).toBe("metahub");
    expect(launch.command).toBe("node");
    expect(launch.args[0]).toContain("metahub-mcp.js");
    // Portal URL forwarded from the (mocked) auth config.
    expect(env.METAHUB_PORTAL_URL).toBe("https://portal.test");
    // Registry URL honored from the auth-config override.
    expect(env.METAHUB_REGISTRY_URL).toBe("https://registry.test");
    expect(res.bin).toContain("metahub-mcp.js");
  });

  it("omits METAHUB_REGISTRY_URL entirely when auth config has no override", async () => {
    authConfig = { portalUrl: "https://portal.test", registryUrl: "" };
    adapters = [{ name: "Cursor", detect: () => true, configPath: () => "/home/.cursor/mcp.json" }];
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ servers: {} }));
    const { bootstrapMetahubMcp } = await freshBootstrap();
    bootstrapMetahubMcp();
    const [, , env] = wireSpy.mock.calls[0] as [string, unknown, Record<string, string>];
    expect(env).not.toHaveProperty("METAHUB_REGISTRY_URL");
  });

  it("force=true re-wires even a client that is already wired", async () => {
    const { findMetahubMcpBin } = await import("../src/lib/bootstrap.js");
    const freshBin = findMetahubMcpBin();
    adapters = [{ name: "Claude", detect: () => true, configPath: () => "/home/.claude/s.json" }];
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ mcpServers: { metahub: { command: "node", args: [freshBin] } } }),
    );
    const { bootstrapMetahubMcp } = await freshBootstrap();
    bootstrapMetahubMcp({ force: true });
    expect(wireSpy).toHaveBeenCalledTimes(1);
  });
});

describe("unbootstrap", () => {
  it("delegates to unwireMcpAcrossClients with the metahub slug", async () => {
    const { unbootstrap } = await freshBootstrap();
    unbootstrap();
    expect(unwireSpy).toHaveBeenCalledTimes(1);
    expect(unwireSpy.mock.calls[0]![0]).toBe("metahub");
  });
});
