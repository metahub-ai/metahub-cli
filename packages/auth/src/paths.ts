/**
 * Filesystem locations for persisted auth state.
 *
 * The library writes a single JSON file at `~/.metahub/config.json` that
 * holds the bearer token + portal URL. Both the CLI and the MCP server
 * read and write through these helpers so they never disagree on where
 * the token lives.
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

function getHome(): string {
  return process.env.METAHUB_E2E_HOME || os.homedir();
}

/** Owner-only, like `~/.ssh`. Everything under here is a credential. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function configRoot(): string {
  const root = path.join(getHome(), ".metahub");
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true, mode: DIR_MODE });
  } else {
    // Repair a root created by an older version, which used the default
    // 0755. Best-effort: a chmod can fail on a mounted or foreign
    // filesystem, and that must not stop the CLI from working.
    try {
      if ((fs.statSync(root).mode & 0o077) !== 0) fs.chmodSync(root, DIR_MODE);
    } catch {
      /* not fatal — the file mode below is the load-bearing part */
    }
  }
  return root;
}

/**
 * Write a file only its owner can read.
 *
 * The `mode` option on `writeFileSync` applies **only when the file is
 * created**, and is further masked by the umask. An existing
 * world-readable file therefore keeps its mode straight through a write
 * that asked for 0600 — which is exactly how `~/.metahub/config.json`
 * came to sit at 0644 with a live session token in it. The explicit
 * `chmod` after the write is what actually enforces this, and it also
 * repairs files left behind by earlier versions.
 *
 * `wrangler` and `stripe` both re-chmod on every write for the same
 * reason. `aws` sets the mode only on creation and merely warns about
 * loose files it finds, which is the behaviour this deliberately avoids.
 */
export function writePrivateFile(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: DIR_MODE });
  fs.writeFileSync(file, contents, { encoding: "utf8", mode: FILE_MODE });
  fs.chmodSync(file, FILE_MODE);
}

/** True when nobody but the owner can read the file. */
export function isPrivateFile(file: string): boolean {
  try {
    return (fs.statSync(file).mode & 0o077) === 0;
  } catch {
    // A file that does not exist cannot leak.
    return true;
  }
}

export function configFile(): string {
  return path.join(configRoot(), "config.json");
}
