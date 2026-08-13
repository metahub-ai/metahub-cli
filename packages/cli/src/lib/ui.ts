/**
 * Terminal UI primitives shared across every `mh` command.
 *
 * Design goals:
 *   - Zero runtime dependencies. `chalk` / `kleur` / `picocolors` add
 *     startup latency that's visible at every CLI invocation. The
 *     ANSI we need is ~30 lines.
 *   - Auto-detect color. Respect NO_COLOR, FORCE_COLOR, CI, TERM=dumb.
 *     When stdout isn't a TTY we strip everything — keeps logs clean
 *     for `mh outdated | grep` and CI.
 *   - Deterministic in tests. Setting NO_COLOR=1 (which vitest does)
 *     means every helper returns plain text, so snapshots stay stable
 *     across local laptops + CI.
 *
 * Visual language:
 *   - [accent header]    one-word command label at the top of output
 *   - bold artifact names, dim metadata, cyan URLs/versions
 *   - ✓ green / ✗ red / ⚠ yellow / ▸ default
 *   - paths tildeified (~/.claude/skills/foo, not /Users/x/.claude/...)
 *   - relative times (2 days ago), human bytes (47 KB), human ms (234ms)
 *
 * Whenever you add a command, import from here. Never reach for raw
 * \x1b escapes in command files — keeps the visual language consistent
 * and gives one place to flip when we add a --no-color flag.
 */
import os from "node:os";
import path from "node:path";

// ─── Color mode detection ───────────────────────────────────────────

export type ColorMode = "ansi" | "none";

let _modeCache: ColorMode | null = null;

/**
 * Resolve once per process. Re-reading env on every helper call would
 * make hot loops in `mh update --all` slower than they need to be.
 */
export function colorMode(): ColorMode {
  if (_modeCache !== null) return _modeCache;
  _modeCache = detectColorMode();
  return _modeCache;
}

/** Reset the cache. Test-only — production never needs this. */
export function _resetColorModeCache(): void {
  _modeCache = null;
}

function detectColorMode(): ColorMode {
  // Explicit opt-out wins.
  if (process.env.NO_COLOR && process.env.NO_COLOR !== "0") return "none";
  // Explicit opt-in next: forces color even when piped.
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return "ansi";
  // Dumb terminals (some CI runners, emacs shell) don't render escapes.
  if (process.env.TERM === "dumb") return "none";
  // Default CI behavior: no color. Most CI logs render plain.
  if (process.env.CI && !process.env.FORCE_COLOR) return "none";
  // Finally: only colorize when actually attached to a TTY.
  if (!process.stdout.isTTY) return "none";
  return "ansi";
}

// ─── Style primitives ───────────────────────────────────────────────

function wrap(open: string, close: string): (s: string) => string {
  return (s: string) => {
    if (colorMode() === "none") return s;
    return `\x1b[${open}m${s}\x1b[${close}m`;
  };
}

/**
 * Style helpers. Mirror chalk's surface for the colors we actually
 * use, no more. When in doubt: accent for brand-y things (the
 * command name in headers, key URLs), bold for names, dim for paths
 * and secondary info, cyan for versions/SHAs, green/red/yellow for
 * status, magenta for the spinner.
 */
export const c = {
  bold: wrap("1", "22"),
  dim: wrap("2", "22"),
  italic: wrap("3", "23"),
  red: wrap("31", "39"),
  green: wrap("32", "39"),
  yellow: wrap("33", "39"),
  blue: wrap("34", "39"),
  magenta: wrap("35", "39"),
  cyan: wrap("36", "39"),
  gray: wrap("90", "39"),
  /** Brand accent — cyan-bright. Used for [command] labels. */
  accent: wrap("96", "39"),
  /** Muted — same as dim but separate name for semantic intent. */
  muted: wrap("2", "22"),
};

// ─── Glyphs ─────────────────────────────────────────────────────────

/**
 * Unicode by default, ASCII fallback when the terminal can't render.
 * Detection is conservative: most modern terminals (iTerm, Ghostty,
 * Wezterm, gnome-terminal, Windows Terminal) render the unicode set
 * we use just fine.
 */
function asciiOnly(): boolean {
  // Windows cmd.exe ships with a code page that mangles unicode.
  // PowerShell 7+ + Windows Terminal is fine, but we can't reliably
  // distinguish, so we conservatively fall back on Windows when no
  // TERM is set (cmd.exe ships without it).
  if (process.platform === "win32" && !process.env.WT_SESSION && !process.env.TERM) {
    return true;
  }
  return false;
}

export const glyph = {
  check: asciiOnly() ? "v" : "✓",
  cross: asciiOnly() ? "x" : "✗",
  arrow: asciiOnly() ? "->" : "→",
  step: asciiOnly() ? ">" : "▸",
  warn: asciiOnly() ? "!" : "⚠",
  bullet: asciiOnly() ? "*" : "·",
  branch: asciiOnly() ? "+-" : "└─",
  star: asciiOnly() ? "*" : "★",
  spinner: asciiOnly() ? ["-", "\\", "|", "/"] : ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};

// ─── Layout helpers ─────────────────────────────────────────────────

/**
 * Section header: `[command]  subtitle                            ── extra`
 * Prints in accent. The trailing extra is dim and right-aligned when
 * the terminal width is known; falls back to inline when it isn't.
 */
export function header(label: string, subtitle?: string, trailing?: string): string {
  const tag = c.accent(`[${label}]`);
  const sub = subtitle ? `  ${c.bold(subtitle)}` : "";
  if (!trailing) return `${tag}${sub}`;
  const width = process.stdout.columns ?? 80;
  const left = `${tag}${sub}`;
  const leftPlain = stripAnsi(left);
  const trailPlain = `── ${trailing}`;
  const trailColored = c.dim(trailPlain);
  if (leftPlain.length + 4 + trailPlain.length <= width) {
    const pad = " ".repeat(width - leftPlain.length - trailPlain.length);
    return `${left}${pad}${trailColored}`;
  }
  return `${left}  ${trailColored}`;
}

/**
 * Progress step: `  ✓ resolve     2964d6a · public`
 * Indented two spaces, glyph + label column-padded to keep the value
 * column aligned across a run. Status is one of "ok" / "warn" / "fail" /
 * "info" — picks the right glyph + color.
 */
export type StepStatus = "ok" | "warn" | "fail" | "info";
export function step(status: StepStatus, label: string, value: string, labelWidth = 12): string {
  const g =
    status === "ok"
      ? c.green(glyph.check)
      : status === "warn"
        ? c.yellow(glyph.warn)
        : status === "fail"
          ? c.red(glyph.cross)
          : c.dim(glyph.step);
  return `  ${g} ${label.padEnd(labelWidth)} ${value}`;
}

/**
 * Key-value rows, column-aligned. Pass an array of [key, value]
 * tuples and we pad the key column to the longest. Indented two
 * spaces. Keys render in dim, values default.
 */
export function kv(rows: Array<[string, string]>, indent = 2): string {
  const keyW = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `${" ".repeat(indent)}${c.dim(k.padEnd(keyW))}  ${v}`).join("\n");
}

/**
 * Box-draw helper for emphasis (login device code). Pads the content
 * and draws a unicode (or ASCII fallback) frame.
 */
export function box(content: string, padding = 2): string {
  const lines = content.split("\n");
  const w = Math.max(...lines.map((l) => stripAnsi(l).length));
  const pad = " ".repeat(padding);
  const ascii = asciiOnly();
  const tl = ascii ? "+" : "┌";
  const tr = ascii ? "+" : "┐";
  const bl = ascii ? "+" : "└";
  const br = ascii ? "+" : "┘";
  const h = ascii ? "-" : "─";
  const v = ascii ? "|" : "│";
  const top = `${tl}${h.repeat(w + padding * 2)}${tr}`;
  const bottom = `${bl}${h.repeat(w + padding * 2)}${br}`;
  const body = lines.map((l) => {
    const visLen = stripAnsi(l).length;
    return `${v}${pad}${l}${" ".repeat(w - visLen)}${pad}${v}`;
  });
  return [top, ...body, bottom].join("\n");
}

// ─── Path / time / size helpers ─────────────────────────────────────

/**
 * Collapse `/Users/<me>/.claude/...` to `~/.claude/...`. Idempotent —
 * safe to apply twice.
 */
export function tildeify(p: string): string {
  if (!p) return p;
  const home = os.homedir();
  if (p === home) return "~";
  if (p.startsWith(home + path.sep)) return "~" + p.slice(home.length);
  return p;
}

/**
 * Relative-time string ("2 days ago", "in 5 minutes"). Optional `now`
 * parameter makes it testable.
 */
export function relTime(input: Date | string | number, now: number = Date.now()): string {
  const t = input instanceof Date ? input.getTime() : new Date(input).getTime();
  if (!Number.isFinite(t)) return "—";
  const diff = now - t;
  const future = diff < 0;
  const abs = Math.abs(diff);
  const s = Math.floor(abs / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  const mo = Math.floor(d / 30);
  const y = Math.floor(d / 365);
  let val: string;
  if (s < 5) val = "just now";
  else if (s < 60) val = `${s} second${s === 1 ? "" : "s"}`;
  else if (m < 60) val = `${m} minute${m === 1 ? "" : "s"}`;
  else if (h < 24) val = `${h} hour${h === 1 ? "" : "s"}`;
  else if (d < 30) val = `${d} day${d === 1 ? "" : "s"}`;
  else if (mo < 12) val = `${mo} month${mo === 1 ? "" : "s"}`;
  else val = `${y} year${y === 1 ? "" : "s"}`;
  if (val === "just now") return val;
  return future ? `in ${val}` : `${val} ago`;
}

/**
 * Human-friendly byte size: 47 KB, 1.2 MB, 980 B.
 * Decimal (1000-based) — matches macOS Finder + Linux `ls -h`.
 */
export function bytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1000) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/**
 * Human-friendly duration: 234ms, 1.2s, 3m 4s.
 */
export function ms(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1000) return `${Math.round(n)}ms`;
  const s = n / 1000;
  if (s < 60) {
    // For values <10s, keep one decimal — unless rounding pushes us
    // to ≥10, in which case drop the decimal so the result reads
    // "10s" instead of "10.0s".
    if (s < 10) {
      const oneDec = Math.round(s * 10) / 10;
      return oneDec < 10 ? `${oneDec.toFixed(1)}s` : `${oneDec}s`;
    }
    return `${Math.round(s)}s`;
  }
  const mins = Math.floor(s / 60);
  const rest = Math.round(s - mins * 60);
  return `${mins}m ${rest}s`;
}

// ─── Hyperlinks (OSC 8) ─────────────────────────────────────────────

/**
 * Emit an OSC 8 hyperlink. Rendered as a clickable link in modern
 * terminals (iTerm2 ≥ 3.1, Ghostty, Wezterm, gnome-terminal, Windows
 * Terminal). Falls back to plain "label (url)" everywhere else.
 *
 * We treat "no color" as "no hyperlinks" — if the user piped to a
 * file or has NO_COLOR set, they want plain text.
 */
export function link(label: string, url: string): string {
  if (colorMode() === "none") {
    return label === url ? url : `${label} (${url})`;
  }
  return `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
}

// ─── Spinner ────────────────────────────────────────────────────────

/**
 * Simple cursor-overwriting spinner. Used by `mh login` during the
 * device-code poll. Stops cleanly on .stop(final) which clears the
 * line and prints the final message.
 */
export interface Spinner {
  update(text: string): void;
  stop(finalLine: string): void;
}

export function spinner(initial: string): Spinner {
  let i = 0;
  let label = initial;
  let stopped = false;
  const frames = glyph.spinner as string[];
  // No-op when not a TTY (pipe / file / CI) — just print the initial label.
  if (colorMode() === "none" || !process.stdout.isTTY) {
    process.stdout.write(`  ${label}\n`);
    return {
      update: (t) => {
        process.stdout.write(`  ${t}\n`);
      },
      stop: (f) => {
        process.stdout.write(`  ${f}\n`);
      },
    };
  }
  process.stdout.write(`\r  ${c.magenta(frames[0]!)} ${label}`);
  const handle = setInterval(() => {
    if (stopped) return;
    i = (i + 1) % frames.length;
    process.stdout.write(`\r  ${c.magenta(frames[i]!)} ${label}\x1b[K`);
  }, 80);
  return {
    update: (t) => {
      label = t;
    },
    stop: (f) => {
      stopped = true;
      clearInterval(handle);
      process.stdout.write(`\r\x1b[K  ${f}\n`);
    },
  };
}

// ─── Shared error / usage helpers ───────────────────────────────────

/**
 * One canonical "bad <kind>/<slug>" error string, used by `install`,
 * `uninstall`, `update`, `show`, `doctor`, `trace` so the wording is
 * identical wherever the user typoes the segment. Prints in red with
 * the legal-list dimmed; callers wrap with `console.error()` themselves.
 *
 * Example:
 *   ✗ "nopeland/x" — must be one of: skills/<slug>, mcps/<slug>,
 *       agents/<slug>, plugins/<slug>.
 */
export function refError(rawArg: string): string {
  const legal = "skills/<slug>, mcps/<slug>, agents/<slug>, plugins/<slug>";
  return `${c.red(glyph.cross)} ${c.bold('"' + rawArg + '"')} — ${c.dim("must be one of: " + legal + ".")}`;
}

/**
 * Standard "usage error" output: styled `[command]` header + a dim
 * Usage line. Printed to stderr by the caller. The caller is
 * responsible for returning exit code 2.
 */
export function usageError(command: string, usage: string): string {
  return `${header(command)}\n  ${c.dim("Usage:")} ${usage}`;
}

// ─── Internal helpers ───────────────────────────────────────────────

/**
 * Strip ANSI escape sequences. Used internally for width math when
 * padding, and exported so tests can normalize snapshots.
 */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}
