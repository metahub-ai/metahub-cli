/**
 * Branch-coverage tests for lib/ui.ts paths that the default
 * NO_COLOR + non-TTY test environment can't reach:
 *
 *   - detectColorMode() returning "ansi" when attached to a real TTY
 *     (lines 60-61)
 *   - asciiOnly() returning true on bare Windows cmd.exe (line 111)
 *   - header() overflow fallback when the terminal is too narrow
 *     (line 148)
 *   - the live, TTY spinner with its interval frames + clean stop
 *     (lines 315-344)
 *
 * We drive these by patching process.stdout.isTTY / .columns,
 * process.platform, and the relevant env vars, then resetting the
 * color-mode cache between cases. The spinner uses fake timers so the
 * setInterval frame advance is deterministic and never leaks a handle.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { _resetColorModeCache, box, colorMode, header, spinner, stripAnsi } from "../src/lib/ui.js";

/** Run `fn` with a patched env + cleared color cache, then restore. */
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

/** Temporarily set a property on an object, restoring it afterwards. */
function withProp<T, K extends keyof T>(obj: T, key: K, value: T[K], fn: () => void) {
  const had = Object.prototype.hasOwnProperty.call(obj, key);
  const prev = obj[key];
  Object.defineProperty(obj, key, { value, configurable: true, writable: true });
  try {
    fn();
  } finally {
    if (had) Object.defineProperty(obj, key, { value: prev, configurable: true, writable: true });
    else delete obj[key];
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  _resetColorModeCache();
});

describe("detectColorMode — TTY-attached path", () => {
  it("returns 'ansi' when no env overrides are set and stdout is a TTY", () => {
    withEnv(
      { NO_COLOR: undefined, FORCE_COLOR: undefined, CI: undefined, TERM: "xterm-256color" },
      () => {
        withProp(process.stdout, "isTTY", true, () => {
          expect(colorMode()).toBe("ansi");
        });
      },
    );
  });

  it("returns 'none' when no env overrides are set and stdout is NOT a TTY", () => {
    withEnv({ NO_COLOR: undefined, FORCE_COLOR: undefined, CI: undefined, TERM: "xterm" }, () => {
      withProp(process.stdout, "isTTY", false, () => {
        expect(colorMode()).toBe("none");
      });
    });
  });
});

describe("asciiOnly — bare Windows cmd.exe fallback", () => {
  it("box() draws an ASCII frame on win32 without WT_SESSION/TERM", () => {
    const orig = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      withEnv({ WT_SESSION: undefined, TERM: undefined }, () => {
        const out = box("hi");
        // ASCII corner + horizontal characters, never the unicode set.
        expect(out).toMatch(/^\+/);
        expect(out).toContain("|");
        expect(out).not.toContain("┌");
      });
    } finally {
      if (orig) Object.defineProperty(process, "platform", orig);
    }
  });

  it("box() draws a unicode frame when a modern terminal is signalled", () => {
    const orig = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      withEnv({ WT_SESSION: "1", TERM: "xterm" }, () => {
        const out = box("hi");
        expect(out).toMatch(/^┌/);
      });
    } finally {
      if (orig) Object.defineProperty(process, "platform", orig);
    }
  });
});

describe("header — overflow fallback", () => {
  it("falls back to inline trailing text when the terminal is too narrow", () => {
    withProp(process.stdout, "columns", 10, () => {
      const out = header("install", "a-very-long-subtitle-here", "trailing-meta-text");
      const plain = stripAnsi(out);
      // No right-pad run of spaces — the wide-terminal branch is skipped;
      // instead the trailing text is appended after a two-space gap.
      expect(plain).toContain("[install]");
      expect(plain).toContain("trailing-meta-text");
      expect(plain).not.toMatch(/ {5,}/);
    });
  });

  it("right-aligns trailing text when the terminal is wide enough", () => {
    withProp(process.stdout, "columns", 120, () => {
      const out = header("install", "skills/pdf", "meta");
      const plain = stripAnsi(out);
      // Wide branch pads with a long run of spaces to push the trailing
      // text flush-right.
      expect(plain).toMatch(/ {5,}── meta$/);
    });
  });
});

describe("spinner — live TTY path", () => {
  it("advances frames on an interval and clears the line on stop", () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown): boolean => {
        writes.push(String(chunk));
        return true;
      });
    try {
      withEnv({ NO_COLOR: undefined, FORCE_COLOR: "1", CI: undefined, TERM: "xterm" }, () => {
        withProp(process.stdout, "isTTY", true, () => {
          const sp = spinner("resolving");
          // Initial frame written immediately.
          expect(writes.some((w) => w.includes("resolving"))).toBe(true);
          const beforeTick = writes.length;
          // Advance two interval ticks (80ms each) → two redraws.
          vi.advanceTimersByTime(160);
          expect(writes.length).toBeGreaterThan(beforeTick);
          // update() swaps the label for the next redraw.
          sp.update("downloading");
          vi.advanceTimersByTime(80);
          expect(writes.some((w) => w.includes("downloading"))).toBe(true);
          // stop() clears the line, prints the final message, and stops
          // the interval (no further writes after this point).
          sp.stop("done");
          const afterStop = writes.length;
          expect(writes.some((w) => w.includes("done"))).toBe(true);
          vi.advanceTimersByTime(400);
          expect(writes.length).toBe(afterStop);
        });
      });
    } finally {
      writeSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("falls back to plain line writes when stdout is not a TTY", () => {
    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown): boolean => {
        writes.push(String(chunk));
        return true;
      });
    try {
      // NO_COLOR (the vitest default) forces colorMode "none", taking
      // the non-TTY branch even if isTTY were true.
      const sp = spinner("working");
      sp.update("still working");
      sp.stop("finished");
      expect(writes.some((w) => w.includes("working"))).toBe(true);
      expect(writes.some((w) => w.includes("still working"))).toBe(true);
      expect(writes.some((w) => w.includes("finished"))).toBe(true);
      // Plain branch never emits the carriage-return cursor moves.
      expect(writes.every((w) => !w.includes("\r"))).toBe(true);
    } finally {
      writeSpy.mockRestore();
    }
  });
});
