/**
 * Unit tests for the terminal UI primitives in lib/ui.ts.
 *
 * These tests run with NO_COLOR=1 baked into the vitest config so the
 * `c.*` helpers strip ANSI by default. We separately re-enable color
 * for the few cases that need to exercise the ANSI path.
 */
import { beforeEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import {
  _resetColorModeCache,
  bytes,
  c,
  colorMode,
  glyph,
  header,
  kv,
  link,
  ms,
  relTime,
  step,
  stripAnsi,
  tildeify,
  box,
} from "../src/lib/ui.js";

function withEnv(patch: Record<string, string | undefined>, fn: () => void) {
  const before: Record<string, string | undefined> = {};
  for (const k of Object.keys(patch)) before[k] = process.env[k];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetColorModeCache();
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetColorModeCache();
  }
}

describe("colorMode", () => {
  beforeEach(() => _resetColorModeCache());

  it("respects NO_COLOR (set + truthy = none)", () => {
    withEnv({ NO_COLOR: "1", FORCE_COLOR: undefined }, () => {
      expect(colorMode()).toBe("none");
    });
  });

  it("ignores NO_COLOR=0", () => {
    withEnv({ NO_COLOR: "0", FORCE_COLOR: "1" }, () => {
      expect(colorMode()).toBe("ansi");
    });
  });

  it("respects FORCE_COLOR over NO_COLOR? — no, NO_COLOR wins per the standard", () => {
    withEnv({ NO_COLOR: "1", FORCE_COLOR: "1" }, () => {
      expect(colorMode()).toBe("none");
    });
  });

  it("returns none for TERM=dumb", () => {
    withEnv({ NO_COLOR: undefined, FORCE_COLOR: undefined, TERM: "dumb" }, () => {
      expect(colorMode()).toBe("none");
    });
  });

  it("returns none under CI without explicit FORCE_COLOR", () => {
    withEnv({ NO_COLOR: undefined, FORCE_COLOR: undefined, CI: "true", TERM: "xterm" }, () => {
      expect(colorMode()).toBe("none");
    });
  });

  it("caches: a second call doesn't re-read env", () => {
    withEnv({ NO_COLOR: "1" }, () => {
      expect(colorMode()).toBe("none");
      // Mutate env without resetting the cache — should still report none.
      process.env.NO_COLOR = undefined as unknown as string;
      delete process.env.NO_COLOR;
      expect(colorMode()).toBe("none");
    });
  });
});

describe("c.* style helpers (NO_COLOR active by default in tests)", () => {
  it("return plain strings under NO_COLOR", () => {
    expect(c.bold("hello")).toBe("hello");
    expect(c.green("ok")).toBe("ok");
    expect(c.red("fail")).toBe("fail");
    expect(c.dim("path")).toBe("path");
  });

  it("emit ANSI when FORCE_COLOR is on", () => {
    withEnv({ NO_COLOR: undefined, FORCE_COLOR: "1" }, () => {
      // Build the expected escape sequence from a String.fromCharCode
      // so this test file doesn't trigger no-control-regex.
      const ESC = String.fromCharCode(27);
      expect(c.green("ok")).toBe(`${ESC}[32mok${ESC}[39m`);
      expect(c.bold("x")).toBe(`${ESC}[1mx${ESC}[22m`);
      // Strip should give back the original.
      expect(stripAnsi(c.green("ok"))).toBe("ok");
    });
  });
});

describe("glyphs", () => {
  it("have a stable shape", () => {
    expect(["✓", "v"]).toContain(glyph.check);
    expect(["✗", "x"]).toContain(glyph.cross);
    expect(["→", "->"]).toContain(glyph.arrow);
    expect(Array.isArray(glyph.spinner)).toBe(true);
    expect((glyph.spinner as string[]).length).toBeGreaterThan(0);
  });
});

describe("tildeify", () => {
  const home = os.homedir();
  it("collapses the home dir prefix", () => {
    expect(tildeify(path.join(home, ".claude", "skills", "foo"))).toBe(
      "~" + path.sep + ".claude" + path.sep + "skills" + path.sep + "foo",
    );
  });
  it("returns ~ for the bare home dir", () => {
    expect(tildeify(home)).toBe("~");
  });
  it("leaves non-home paths alone", () => {
    expect(tildeify("/etc/hosts")).toBe("/etc/hosts");
    expect(tildeify("/var/log")).toBe("/var/log");
  });
  it("is idempotent on already-tildeified paths", () => {
    expect(tildeify("~/x")).toBe("~/x");
  });
  it("handles empty input", () => {
    expect(tildeify("")).toBe("");
  });
});

describe("relTime", () => {
  // Anchor "now" so the test is stable across CI clocks.
  const now = new Date("2026-05-29T00:00:00Z").getTime();

  it("just-now under 5 seconds", () => {
    expect(relTime(new Date(now - 2_000), now)).toBe("just now");
  });

  it.each([
    [10 * 1000, "10 seconds ago"],
    [60 * 1000, "1 minute ago"],
    [5 * 60 * 1000, "5 minutes ago"],
    [60 * 60 * 1000, "1 hour ago"],
    [3 * 60 * 60 * 1000, "3 hours ago"],
    [24 * 60 * 60 * 1000, "1 day ago"],
    [2 * 24 * 60 * 60 * 1000, "2 days ago"],
    [40 * 24 * 60 * 60 * 1000, "1 month ago"],
    [400 * 24 * 60 * 60 * 1000, "1 year ago"],
  ])("renders %dms ago", (ago, expected) => {
    expect(relTime(new Date(now - ago), now)).toBe(expected);
  });

  it("handles future dates", () => {
    expect(relTime(new Date(now + 60 * 60 * 1000), now)).toBe("in 1 hour");
  });

  it("accepts ISO strings + millisecond numbers", () => {
    expect(relTime("2026-05-28T00:00:00Z", now)).toBe("1 day ago");
    expect(relTime(now - 5_000, now)).toBe("5 seconds ago");
  });

  it("returns em-dash for invalid input", () => {
    expect(relTime("not a date")).toBe("—");
  });
});

describe("bytes", () => {
  it.each([
    [0, "0 B"],
    [123, "123 B"],
    [999, "999 B"],
    [1000, "1.0 KB"],
    [47_000, "47 KB"],
    [1_500_000, "1.5 MB"],
    [12_000_000, "12 MB"],
    [3_400_000_000, "3.4 GB"],
  ])("formats %d as %s", (n, expected) => {
    expect(bytes(n)).toBe(expected);
  });

  it("returns em-dash for invalid input", () => {
    expect(bytes(NaN)).toBe("—");
    expect(bytes(-5)).toBe("—");
  });
});

describe("ms", () => {
  it.each([
    [0, "0ms"],
    [234, "234ms"],
    [999, "999ms"],
    [1_000, "1.0s"],
    [9_999, "10s"],
    [30_000, "30s"],
    [59_999, "60s"],
    [60_000, "1m 0s"],
    [125_000, "2m 5s"],
  ])("formats %dms as %s", (n, expected) => {
    expect(ms(n)).toBe(expected);
  });

  it("returns em-dash for invalid input", () => {
    expect(ms(NaN)).toBe("—");
  });
});

describe("layout helpers", () => {
  it("header renders an accent label + subtitle", () => {
    expect(header("install", "skills/pdf")).toMatch(/\[install\].*skills\/pdf/);
  });

  it("header includes trailing text when provided", () => {
    const out = header("install", "skills/pdf", "developer.metahub.ai");
    expect(out).toContain("[install]");
    expect(out).toContain("skills/pdf");
    expect(out).toContain("developer.metahub.ai");
  });

  it("step renders ✓ for ok / ✗ for fail / ⚠ for warn", () => {
    expect(step("ok", "resolve", "2964d6a")).toMatch(/✓|v/);
    expect(step("ok", "resolve", "2964d6a")).toContain("resolve");
    expect(step("ok", "resolve", "2964d6a")).toContain("2964d6a");
    expect(step("warn", "deprecation", "old api")).toMatch(/⚠|!/);
    expect(step("fail", "auth", "401")).toMatch(/✗|x/);
  });

  it("step column-aligns labels", () => {
    const a = stripAnsi(step("ok", "a", "x"));
    const b = stripAnsi(step("ok", "abcdef", "y"));
    // Both should have the value column starting at the same position
    // when the labels are within the default padding.
    const aIdx = a.indexOf("x");
    const bIdx = b.indexOf("y");
    expect(aIdx).toBe(bIdx);
  });

  it("kv column-aligns keys", () => {
    const out = kv([
      ["short", "v1"],
      ["a-longer-key", "v2"],
    ]);
    const lines = out.split("\n");
    // Both rows should align the value column.
    const v1Idx = lines[0]!.indexOf("v1");
    const v2Idx = lines[1]!.indexOf("v2");
    expect(v1Idx).toBe(v2Idx);
  });

  it("box draws a frame", () => {
    const out = box("hello");
    expect(out.split("\n")).toHaveLength(3);
    expect(out).toContain("hello");
    // Top + bottom corners
    const ascii = process.platform === "win32" && !process.env.WT_SESSION && !process.env.TERM;
    if (ascii) {
      expect(out).toMatch(/^\+/);
    } else {
      expect(out).toMatch(/^┌|^\+/);
    }
  });
});

describe("link", () => {
  it("returns plain 'label (url)' under NO_COLOR", () => {
    expect(link("docs", "https://developer.metahub.ai")).toBe(
      "docs (https://developer.metahub.ai)",
    );
  });

  it("collapses to just url when label === url", () => {
    expect(link("https://x.test", "https://x.test")).toBe("https://x.test");
  });

  it("emits OSC 8 when colors are on", () => {
    withEnv({ NO_COLOR: undefined, FORCE_COLOR: "1" }, () => {
      const out = link("docs", "https://x.test");
      expect(out).toContain("\x1b]8;;https://x.test");
      expect(out).toContain("docs");
    });
  });
});

describe("stripAnsi", () => {
  it("removes color escapes", () => {
    expect(stripAnsi("\x1b[31mred\x1b[39m")).toBe("red");
  });
  it("removes OSC 8 hyperlinks", () => {
    expect(stripAnsi("\x1b]8;;u\x1b\\label\x1b]8;;\x1b\\")).toBe("label");
  });
  it("is identity on plain strings", () => {
    expect(stripAnsi("hello")).toBe("hello");
  });
});
