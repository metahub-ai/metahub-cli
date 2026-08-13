/**
 * On-disk permissions for credential files.
 *
 * These are regression tests for a real exposure: `~/.metahub/config.json`
 * shipped at 0644 containing a live session token, and
 * `~/.metahub/installs.json` at 0644 containing per-install API keys.
 *
 * The root cause is a Node behaviour that is easy to get wrong. The
 * `mode` option on `writeFileSync` applies **only when the file is
 * created**, and is masked by the umask on top of that. So a file that
 * already exists keeps its old mode straight through a write that asked
 * for 0600, and passing the option looks like it worked. Every
 * assertion below therefore checks `statSync` on the real file rather
 * than trusting the option we passed.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPrivateFile, writePrivateFile } from "../src/paths";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-perm-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const modeOf = (f: string) => fs.statSync(f).mode & 0o777;

describe("writePrivateFile", () => {
  it("creates a file readable only by its owner", () => {
    const f = path.join(dir, "config.json");
    writePrivateFile(f, '{"sessionToken":"secret"}');
    expect(modeOf(f)).toBe(0o600);
  });

  // The actual bug. Without the explicit chmod this test fails: the
  // pre-existing 0644 survives the write untouched.
  it("REPAIRS a file that already exists world-readable", () => {
    const f = path.join(dir, "config.json");
    fs.writeFileSync(f, "{}");
    fs.chmodSync(f, 0o644);
    expect(modeOf(f)).toBe(0o644);

    writePrivateFile(f, '{"sessionToken":"secret"}');
    expect(modeOf(f)).toBe(0o600);
  });

  it("repairs a group-readable file too, not only world-readable", () => {
    const f = path.join(dir, "installs.json");
    fs.writeFileSync(f, "{}");
    fs.chmodSync(f, 0o640);
    writePrivateFile(f, "{}");
    expect(modeOf(f)).toBe(0o600);
  });

  it("writes the contents it was given", () => {
    const f = path.join(dir, "config.json");
    writePrivateFile(f, '{"a":1}');
    expect(fs.readFileSync(f, "utf8")).toBe('{"a":1}');
  });

  it("creates missing parent directories, owner-only", () => {
    const f = path.join(dir, "nested", "deep", "config.json");
    writePrivateFile(f, "{}");
    expect(fs.existsSync(f)).toBe(true);
    expect(modeOf(path.dirname(f)) & 0o077).toBe(0);
  });

  // The umask can only ever remove bits, so this holds regardless of
  // the shell's umask — which is the point of not relying on it.
  it("is not defeated by a permissive umask", () => {
    const previous = process.umask(0o000);
    try {
      const f = path.join(dir, "config.json");
      writePrivateFile(f, "{}");
      expect(modeOf(f)).toBe(0o600);
    } finally {
      process.umask(previous);
    }
  });
});

describe("isPrivateFile", () => {
  it("is true for an owner-only file", () => {
    const f = path.join(dir, "a");
    writePrivateFile(f, "x");
    expect(isPrivateFile(f)).toBe(true);
  });

  it.each([0o644, 0o640, 0o604, 0o666])("is false at mode %s", (mode) => {
    const f = path.join(dir, "a");
    fs.writeFileSync(f, "x");
    fs.chmodSync(f, mode);
    expect(isPrivateFile(f)).toBe(false);
  });

  // A file that does not exist cannot leak, and reporting it as exposed
  // would make the doctor output noisy and wrong.
  it("is true for a file that does not exist", () => {
    expect(isPrivateFile(path.join(dir, "nope"))).toBe(true);
  });
});
