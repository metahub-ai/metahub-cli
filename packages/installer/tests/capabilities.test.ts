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
import {
  CAPABILITY_MATRIX,
  capabilityFor,
  clientIdFromLabel,
  clientLabel,
  clientsForKind,
} from "../src/capabilities.js";

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

  it("the Agent Skills dir gets a link to the canonical folder", () => {
    const cap = capabilityFor("agents-dir", "skill");
    expect(cap).not.toBeNull();
    expect(cap!.targetPath("pdf")).toBe(path.join(os.homedir(), ".agents", "skills", "pdf"));
    expect(cap!.strategy).toBe("skill-dir-link");
  });

  it("Antigravity gets a link under ~/.gemini/config/skills/", () => {
    const cap = capabilityFor("antigravity", "skill");
    expect(cap!.targetPath("pdf")).toBe(
      path.join(os.homedir(), ".gemini", "config", "skills", "pdf"),
    );
    expect(cap!.strategy).toBe("skill-dir-link");
  });

  it("Cursor, Codex, Gemini CLI, opencode and Goose read the Agent Skills dir natively", () => {
    for (const id of ["cursor", "codex-cli", "gemini-cli", "opencode", "goose"] as const) {
      const cap = capabilityFor(id, "skill");
      expect(cap, id).not.toBeNull();
      expect(cap!.strategy, id).toBe("skill-native");
      expect(cap!.targetPath("pdf"), id).toBe(path.join(os.homedir(), ".agents", "skills", "pdf"));
    }
  });

  it("no row uses the legacy Cursor .mdc strategy any more", () => {
    expect(CAPABILITY_MATRIX.some((r) => r.strategy === "cursor-rule-mdc")).toBe(false);
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

  it("clientsForKind('skill') returns every skill consumer", () => {
    const ids = clientsForKind("skill")
      .map((r) => r.client)
      .sort();
    expect(ids).toEqual([
      "agents-dir",
      "antigravity",
      "claude-code",
      "codex-cli",
      "continue",
      "cursor",
      "gemini-cli",
      "goose",
      "opencode",
      "zed",
    ]);
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

  it("All 13 known clients have an MCP row", () => {
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
      "gemini-cli",
      "goose",
      "opencode",
      "vs-code",
      "windsurf",
      "zed",
    ]);
  });

  it("Gemini CLI, Antigravity and opencode are JSON-wired", () => {
    expect(capabilityFor("gemini-cli", "mcp")!.strategy).toBe("mcp-json");
    expect(capabilityFor("gemini-cli", "mcp")!.targetPath("x")).toBe(
      path.join(os.homedir(), ".gemini", "settings.json"),
    );
    expect(capabilityFor("antigravity", "mcp")!.strategy).toBe("mcp-json");
    // The exact file depends on which Antigravity generation is on disk
    // (current ~/.gemini/config vs legacy ~/.gemini/antigravity); both
    // live under ~/.gemini and are named mcp_config.json.
    const ag = capabilityFor("antigravity", "mcp")!.targetPath("x")!;
    expect(ag.startsWith(path.join(os.homedir(), ".gemini"))).toBe(true);
    expect(path.basename(ag)).toBe("mcp_config.json");
    expect(capabilityFor("opencode", "mcp")!.strategy).toBe("mcp-json");
    expect(capabilityFor("opencode", "mcp")!.targetPath("x")).toContain(
      path.join("opencode", "opencode.json"),
    );
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
    expect(capabilityFor("windsurf", "skill")).toBeNull();
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

  it("UI-only MCP rows return a human hint, not a filesystem path", () => {
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

describe("client labels", () => {
  it("round-trips every id through its display name", () => {
    const ids = [
      "claude-code",
      "claude-desktop",
      "cursor",
      "antigravity",
      "vs-code",
      "zed",
      "windsurf",
      "continue",
      "cline",
      "goose",
      "codex-cli",
      "gemini-cli",
      "opencode",
      "agents-dir",
    ] as const;
    for (const id of ids) {
      expect(clientIdFromLabel(clientLabel(id))).toBe(id);
    }
    expect(clientLabel("gemini-cli")).toBe("Gemini CLI");
    expect(clientLabel("agents-dir")).toBe("Agent Skills dir");
  });

  it("passes unknown adapter names through unchanged", () => {
    expect(clientIdFromLabel("Totally Unknown Client")).toBe("Totally Unknown Client");
  });
});
