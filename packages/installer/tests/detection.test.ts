/**
 * Tests for detection.ts — path-based "is this AI client installed?"
 * probing. detectClient() checks whether a client's user-config dir
 * exists on disk; detectedClients() runs the full sweep.
 *
 * detection.ts captures `os.homedir()` into a module-level HOME const
 * at first import. We therefore set USERPROFILE/HOME to a single tmp
 * dir BEFORE importing the module, and create/remove the per-client
 * config dirs under that root to flip detection on and off. The
 * platform-conditional helpers (xdgConfigDir / claudeDesktopDir /
 * documentsDir) read process.platform + env vars at call time, so we
 * stub those per-test where a branch needs it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SAVE = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "APPDATA", "OneDrive"] as const;
const saved: Record<string, string | undefined> = {};
let tmp: string;
let origCwd: () => string;
// Filled in beforeAll once the module's HOME const is pinned.
let HOME: string;

beforeAll(() => {
  for (const k of SAVE) saved[k] = process.env[k];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-installer-detect-"));
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  // os.homedir() — and thus detection's HOME const — now resolves to tmp.
  HOME = os.homedir();
});

afterAll(() => {
  for (const k of SAVE) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  // Wipe every client dir we might have created so tests stay isolated.
  for (const sub of [
    ".claude",
    ".cursor",
    ".antigravity",
    ".vscode",
    ".codeium",
    ".continue",
    ".codex",
    ".config",
    "Documents",
    "AppData",
  ]) {
    fs.rmSync(path.join(HOME, sub), { recursive: true, force: true });
  }
});

function mkdir(...segs: string[]) {
  fs.mkdirSync(path.join(HOME, ...segs), { recursive: true });
}

function withPlatform(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  fn: () => void,
) {
  const origDesc = Object.getOwnPropertyDescriptor(process, "platform")!;
  const restore: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    restore[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k]!;
  }
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(process, "platform", origDesc);
    for (const k of Object.keys(restore)) {
      if (restore[k] === undefined) delete process.env[k];
      else process.env[k] = restore[k];
    }
  }
}

describe("detectClient — present vs absent (home-relative clients)", () => {
  it("returns false for every client when nothing is on disk", async () => {
    const { detectClient } = await import("../src/detection");
    for (const id of [
      "claude-code",
      "cursor",
      "antigravity",
      "windsurf",
      "continue",
      "codex-cli",
    ] as const) {
      expect(detectClient(id)).toBe(false);
    }
  });

  it("detects claude-code via ~/.claude", async () => {
    const { detectClient } = await import("../src/detection");
    expect(detectClient("claude-code")).toBe(false);
    mkdir(".claude");
    expect(detectClient("claude-code")).toBe(true);
  });

  it("detects cursor via ~/.cursor", async () => {
    const { detectClient } = await import("../src/detection");
    mkdir(".cursor");
    expect(detectClient("cursor")).toBe(true);
  });

  it("detects antigravity via ~/.antigravity", async () => {
    const { detectClient } = await import("../src/detection");
    mkdir(".antigravity");
    expect(detectClient("antigravity")).toBe(true);
  });

  it("detects windsurf via ~/.codeium/windsurf", async () => {
    const { detectClient } = await import("../src/detection");
    mkdir(".codeium", "windsurf");
    expect(detectClient("windsurf")).toBe(true);
  });

  it("detects continue via ~/.continue", async () => {
    const { detectClient } = await import("../src/detection");
    mkdir(".continue");
    expect(detectClient("continue")).toBe(true);
  });

  it("detects codex-cli via ~/.codex", async () => {
    const { detectClient } = await import("../src/detection");
    mkdir(".codex");
    expect(detectClient("codex-cli")).toBe(true);
  });
});

describe("detectClient — vs-code uses cwd/.vscode", () => {
  it("detects vs-code when <cwd>/.vscode exists", async () => {
    origCwd = process.cwd;
    process.cwd = () => HOME;
    try {
      const { detectClient } = await import("../src/detection");
      expect(detectClient("vs-code")).toBe(false);
      mkdir(".vscode");
      expect(detectClient("vs-code")).toBe(true);
    } finally {
      process.cwd = origCwd;
    }
  });
});

describe("detectClient — cline OR-branches", () => {
  it("detects cline via ~/Documents/Cline/MCP", async () => {
    const { detectClient } = await import("../src/detection");
    withPlatform("linux", {}, () => {
      expect(detectClient("cline")).toBe(false);
    });
    mkdir("Documents", "Cline", "MCP");
    withPlatform("linux", {}, () => {
      expect(detectClient("cline")).toBe(true);
    });
  });

  it("detects cline via the ~/.vscode fallback", async () => {
    mkdir(".vscode");
    const { detectClient } = await import("../src/detection");
    withPlatform("linux", {}, () => {
      expect(detectClient("cline")).toBe(true);
    });
  });

  it("uses OneDrive Documents on win32 when OneDrive is set", async () => {
    const oneDrive = path.join(HOME, "OneDriveDocs");
    fs.mkdirSync(path.join(oneDrive, "Documents", "Cline", "MCP"), { recursive: true });
    const { detectClient } = await import("../src/detection");
    withPlatform("win32", { OneDrive: oneDrive, APPDATA: undefined }, () => {
      expect(detectClient("cline")).toBe(true);
    });
  });

  it("falls back to ~/Documents on win32 without OneDrive", async () => {
    mkdir("Documents", "Cline", "MCP");
    const { detectClient } = await import("../src/detection");
    withPlatform(
      "win32",
      { OneDrive: undefined, OneDriveConsumer: undefined, APPDATA: undefined },
      () => {
        expect(detectClient("cline")).toBe(true);
      },
    );
  });
});

describe("detectClient — zed / goose / opencode use xdgConfigDir", () => {
  it("zed detected via <xdg>/zed on linux with XDG_CONFIG_HOME", async () => {
    const xdg = path.join(HOME, "xdg");
    fs.mkdirSync(path.join(xdg, "zed"), { recursive: true });
    const { detectClient } = await import("../src/detection");
    withPlatform("linux", { XDG_CONFIG_HOME: xdg }, () => {
      expect(detectClient("zed")).toBe(true);
    });
  });

  it("opencode detected via <xdg>/opencode on linux", async () => {
    fs.mkdirSync(path.join(HOME, "_xdg", "opencode"), { recursive: true });
    const { detectClient } = await import("../src/detection");
    withPlatform("linux", { XDG_CONFIG_HOME: path.join(HOME, "_xdg") }, () => {
      expect(detectClient("opencode")).toBe(true);
    });
  });

  it("opencode detected via ~/.config/opencode with no XDG override", async () => {
    mkdir(".config", "opencode");
    const { detectClient } = await import("../src/detection");
    withPlatform("linux", { XDG_CONFIG_HOME: undefined }, () => {
      expect(detectClient("opencode")).toBe(true);
    });
  });


  it("goose detected via ~/.config/goose on darwin", async () => {
    mkdir(".config", "goose");
    const { detectClient } = await import("../src/detection");
    withPlatform("darwin", {}, () => {
      expect(detectClient("goose")).toBe(true);
    });
  });

  it("goose detected via APPDATA/goose on win32", async () => {
    const appdata = path.join(HOME, "AppData", "Roaming");
    fs.mkdirSync(path.join(appdata, "goose"), { recursive: true });
    const { detectClient } = await import("../src/detection");
    withPlatform("win32", { APPDATA: appdata }, () => {
      expect(detectClient("goose")).toBe(true);
    });
  });
});

describe("detectClient — claude-desktop platform branches", () => {
  it("darwin: ~/Library/Application Support/Claude", async () => {
    fs.mkdirSync(path.join(HOME, "Library", "Application Support", "Claude"), { recursive: true });
    const { detectClient } = await import("../src/detection");
    withPlatform("darwin", {}, () => {
      expect(detectClient("claude-desktop")).toBe(true);
    });
  });

  it("win32: APPDATA/Claude", async () => {
    const appdata = path.join(HOME, "AppData", "Roaming");
    fs.mkdirSync(path.join(appdata, "Claude"), { recursive: true });
    const { detectClient } = await import("../src/detection");
    withPlatform("win32", { APPDATA: appdata }, () => {
      expect(detectClient("claude-desktop")).toBe(true);
    });
  });

  it("linux: ~/.config/Claude", async () => {
    mkdir(".config", "Claude");
    const { detectClient } = await import("../src/detection");
    withPlatform("linux", {}, () => {
      expect(detectClient("claude-desktop")).toBe(true);
    });
  });
});

describe("detectedClients", () => {
  it("returns only the clients whose config dirs exist", async () => {
    mkdir(".claude");
    mkdir(".cursor");
    const { detectedClients } = await import("../src/detection");
    const realCwd = process.cwd;
    // Point cwd at an empty dir so the vs-code (cwd/.vscode) probe is false.
    process.cwd = () => path.join(HOME, "empty-cwd");
    let result: string[] = [];
    try {
      withPlatform("linux", { XDG_CONFIG_HOME: undefined }, () => {
        result = detectedClients();
      });
    } finally {
      process.cwd = realCwd;
    }
    expect(result).toContain("claude-code");
    expect(result).toContain("cursor");
    expect(result).not.toContain("antigravity");
    expect(result).not.toContain("codex-cli");
  });

  it("returns an empty array when no clients are present", async () => {
    const { detectedClients } = await import("../src/detection");
    const realCwd = process.cwd;
    process.cwd = () => path.join(HOME, "empty-cwd");
    let result: string[] = ["sentinel"];
    try {
      withPlatform("linux", { XDG_CONFIG_HOME: undefined }, () => {
        result = detectedClients();
      });
    } finally {
      process.cwd = realCwd;
    }
    expect(result).toEqual([]);
  });
});
