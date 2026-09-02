/**
 * Tests for the capability matrix in src/capabilities.ts.
 *
 * The matrix is the source of truth for "what each client supports
 * and where it expects its artifacts." If a row drifts (wrong path
 * for Cursor, missing reload strategy), every install across that
 * client breaks silently. These tests pin the high-leverage rows so
 * a regression is caught at PR-review time.
 */
import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { CAPABILITY_MATRIX, capabilityFor, clientsForKind } from "../src/capabilities.js";

/**
 * Temporarily pretend the process is running on a given platform.
 * `process.platform` is read-only, so we redefine it and restore the
 * original descriptor afterwards. The capability helpers
 * (xdgConfigDir / claudeDesktopDir) read process.platform + the
 * relevant env vars at call time, so flipping it here lets us drive
 * each OS branch deterministically regardless of the real host.
 */
function withPlatform(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  fn: () => void,
): void {
  const origDesc = Object.getOwnPropertyDescriptor(process, "platform")!;
  const savedEnv: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    savedEnv[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k]!;
  }
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(process, "platform", origDesc);
    for (const k of Object.keys(savedEnv)) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  }
}

describe("capability matrix shape", () => {
  it("every row has a strategy and reload field", () => {
    for (const row of CAPABILITY_MATRIX) {
      expect(row.client).toBeTruthy();
      expect(row.kind).toBeTruthy();
      expect(row.strategy).toBeTruthy();
      expect(row.reload).toBeTruthy();
      expect(typeof row.targetPath).toBe("function");
    }
  });

  it("no duplicate (client, kind) rows", () => {
    const seen = new Set<string>();
    for (const row of CAPABILITY_MATRIX) {
      const key = `${row.client}|${row.kind}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

describe("skill rows", () => {
  it("Claude Code skill target is the canonical ~/.claude/skills/<slug>/", () => {
    const cap = capabilityFor("claude-code", "skill");
    expect(cap).not.toBeNull();
    expect(cap!.targetPath("pdf")).toBe(path.join(os.homedir(), ".claude", "skills", "pdf"));
    expect(cap!.strategy).toBe("anthropic-skill-md");
    expect(cap!.reload).toBe("hot-mtime");
  });

  it("Cursor skill target is .mdc under ~/.cursor/rules/", () => {
    const cap = capabilityFor("cursor", "skill");
    expect(cap).not.toBeNull();
    expect(cap!.targetPath("pdf")).toBe(path.join(os.homedir(), ".cursor", "rules", "pdf.mdc"));
    expect(cap!.strategy).toBe("cursor-rule-mdc");
  });

  it("Continue skill target is .md under ~/.continue/rules/", () => {
    const cap = capabilityFor("continue", "skill");
    expect(cap).not.toBeNull();
    expect(cap!.targetPath("pdf")).toBe(path.join(os.homedir(), ".continue", "rules", "pdf.md"));
    expect(cap!.strategy).toBe("continue-rule-md");
  });

  it("Zed skill target is .md under <xdg>/zed/prompts/", () => {
    const cap = capabilityFor("zed", "skill");
    expect(cap).not.toBeNull();
    expect(cap!.targetPath("pdf")).toContain(path.join("zed", "prompts", "pdf.md"));
  });

  it("opencode skill target is a verbatim folder under <xdg>/opencode/skills/", () => {
    const cap = capabilityFor("opencode", "skill");
    expect(cap).not.toBeNull();
    expect(cap!.strategy).toBe("opencode-skill-md");
    expect(cap!.targetPath("pdf")).toContain(path.join("opencode", "skills", "pdf"));
  });

  it("clientsForKind('skill') returns exactly the 5 skill-capable clients", () => {
    const ids = clientsForKind("skill")
      .map((r) => r.client)
      .sort();
    expect(ids).toEqual(["claude-code", "continue", "cursor", "opencode", "zed"]);
  });
});

describe("MCP rows", () => {
  it("Claude Code MCP is mcp-rpc reloadable", () => {
    const cap = capabilityFor("claude-code", "mcp");
    expect(cap?.reload).toBe("mcp-rpc");
  });

  it("Claude Desktop MCP needs a restart", () => {
    const cap = capabilityFor("claude-desktop", "mcp");
    expect(cap?.reload).toBe("restart-required");
    expect(cap?.reloadHint).toBeTruthy();
  });

  it("Cursor MCP is hot-mtime", () => {
    expect(capabilityFor("cursor", "mcp")?.reload).toBe("hot-mtime");
  });

  it("All 12 known clients have an MCP row", () => {
    const mcpClients = clientsForKind("mcp")
      .map((r) => r.client)
      .sort();
    expect(mcpClients).toEqual([
      "antigravity",
      "claude-code",
      "claude-desktop",
      "cline",
      "codex-cli",
      "continue",
      "cursor",
      "goose",
      "opencode",
      "vs-code",
      "windsurf",
      "zed",
    ]);
  });
});

describe("plugin rows", () => {
  it("plugins are Claude-Code-only today", () => {
    const ids = clientsForKind("plugin").map((r) => r.client);
    expect(ids).toEqual(["claude-code"]);
  });
});

describe("agent rows", () => {
  it("agents use node-import strategy and no real targetPath", () => {
    const cap = capabilityFor("claude-code", "agent");
    expect(cap?.strategy).toBe("node-import");
    expect(cap?.targetPath("pdf")).toBeNull();
  });
});

describe("capabilityFor", () => {
  it("returns null for unknown (client, kind) pairs", () => {
    expect(capabilityFor("claude-desktop", "skill")).toBeNull();
    expect(capabilityFor("antigravity", "skill")).toBeNull();
    expect(capabilityFor("cursor", "plugin")).toBeNull();
  });
});

describe("every targetPath resolves to a string or null", () => {
  it("exercises every row's targetPath function", () => {
    for (const row of CAPABILITY_MATRIX) {
      const out = row.targetPath("pdf");
      // agent rows return null; everything else returns a path string.
      if (row.strategy === "node-import") {
        expect(out).toBeNull();
      } else {
        expect(typeof out).toBe("string");
        expect((out as string).length).toBeGreaterThan(0);
      }
    }
  });

  it("manual-snippet MCP rows return a human hint, not a filesystem path", () => {
    expect(capabilityFor("antigravity", "mcp")!.targetPath("pdf")).toBe(
      "Antigravity → Settings → MCP servers",
    );
    expect(capabilityFor("cline", "mcp")!.targetPath("pdf")).toBe(
      "Cline panel → MCP Servers → Add",
    );
  });
});

describe("MCP targetPath details", () => {
  it("Claude Code MCP points at user-scoped ~/.claude.json", () => {
    expect(capabilityFor("claude-code", "mcp")!.targetPath("pdf")).toBe(
      path.join(os.homedir(), ".claude.json"),
    );
  });

  it("Cursor MCP points at ~/.cursor/mcp.json", () => {
    expect(capabilityFor("cursor", "mcp")!.targetPath("pdf")).toBe(
      path.join(os.homedir(), ".cursor", "mcp.json"),
    );
  });

  it("Windsurf MCP points at ~/.codeium/windsurf/mcp_config.json", () => {
    expect(capabilityFor("windsurf", "mcp")!.targetPath("pdf")).toBe(
      path.join(os.homedir(), ".codeium", "windsurf", "mcp_config.json"),
    );
  });

  it("Continue MCP points at ~/.continue/config.yaml", () => {
    expect(capabilityFor("continue", "mcp")!.targetPath("pdf")).toBe(
      path.join(os.homedir(), ".continue", "config.yaml"),
    );
  });

  it("Codex CLI MCP points at ~/.codex/config.toml", () => {
    expect(capabilityFor("codex-cli", "mcp")!.targetPath("pdf")).toBe(
      path.join(os.homedir(), ".codex", "config.toml"),
    );
  });

  it("opencode MCP is hot-mtime and targets opencode.json under <xdg>/opencode/", () => {
    const cap = capabilityFor("opencode", "mcp");
    expect(cap).not.toBeNull();
    expect(cap!.strategy).toBe("mcp-json");
    expect(cap!.reload).toBe("hot-mtime");
    expect(cap!.targetPath("pdf")).toContain(path.join("opencode", "opencode.json"));
  });

  it("VS Code MCP points at <cwd>/.vscode/mcp.json", () => {
    expect(capabilityFor("vs-code", "mcp")!.targetPath("pdf")).toBe(
      path.join(process.cwd(), ".vscode", "mcp.json"),
    );
  });
});

describe("xdgConfigDir platform branches (via Zed / Goose targetPath)", () => {
  const zed = () => capabilityFor("zed", "skill")!;
  const goose = () => capabilityFor("goose", "mcp")!;

  it("darwin uses ~/.config", () => {
    withPlatform("darwin", {}, () => {
      expect(zed().targetPath("pdf")).toBe(
        path.join(os.homedir(), ".config", "zed", "prompts", "pdf.md"),
      );
    });
  });

  it("win32 prefers APPDATA when set", () => {
    withPlatform("win32", { APPDATA: "D:\\Roaming" }, () => {
      expect(goose().targetPath("pdf")).toBe(path.join("D:\\Roaming", "goose", "config.yaml"));
    });
  });

  it("win32 falls back to ~/AppData/Roaming when APPDATA is unset", () => {
    withPlatform("win32", { APPDATA: undefined }, () => {
      expect(goose().targetPath("pdf")).toBe(
        path.join(os.homedir(), "AppData", "Roaming", "goose", "config.yaml"),
      );
    });
  });

  it("linux prefers XDG_CONFIG_HOME when set", () => {
    withPlatform("linux", { XDG_CONFIG_HOME: "/xdg" }, () => {
      expect(zed().targetPath("pdf")).toBe(path.join("/xdg", "zed", "prompts", "pdf.md"));
    });
  });

  it("linux falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
    withPlatform("linux", { XDG_CONFIG_HOME: undefined }, () => {
      expect(zed().targetPath("pdf")).toBe(
        path.join(os.homedir(), ".config", "zed", "prompts", "pdf.md"),
      );
    });
  });
});

describe("claudeDesktopDir platform branches (via Claude Desktop MCP targetPath)", () => {
  const cd = () => capabilityFor("claude-desktop", "mcp")!;

  it("darwin uses ~/Library/Application Support/Claude", () => {
    withPlatform("darwin", {}, () => {
      expect(cd().targetPath("pdf")).toBe(
        path.join(
          os.homedir(),
          "Library",
          "Application Support",
          "Claude",
          "claude_desktop_config.json",
        ),
      );
    });
  });

  it("win32 uses APPDATA/Claude when APPDATA is set", () => {
    withPlatform("win32", { APPDATA: "D:\\Roaming" }, () => {
      expect(cd().targetPath("pdf")).toBe(
        path.join("D:\\Roaming", "Claude", "claude_desktop_config.json"),
      );
    });
  });

  it("win32 falls back to ~/AppData/Roaming/Claude when APPDATA is unset", () => {
    withPlatform("win32", { APPDATA: undefined }, () => {
      expect(cd().targetPath("pdf")).toBe(
        path.join(os.homedir(), "AppData", "Roaming", "Claude", "claude_desktop_config.json"),
      );
    });
  });

  it("linux falls back to ~/.config/Claude", () => {
    withPlatform("linux", {}, () => {
      expect(cd().targetPath("pdf")).toBe(
        path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json"),
      );
    });
  });
});
