/**
 * Download + extract a GitHub tarball into a destination directory.
 *
 * GitHub tarball archives are wrapped in a single top-level directory
 * like `owner-repo-<sha>/`. We strip that prefix so the user sees a
 * clean install path.
 *
 * For monorepo artifacts we extract the whole archive into a temp dir,
 * then move only the requested sub-path. This avoids depending on
 * GNU-tar-only flags (BSD tar on macOS doesn't have `--wildcards`).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";

async function pipeTarball(body: Readable, dest: string, stripComponents: number): Promise<void> {
  fs.mkdirSync(dest, { recursive: true });
  const tar = spawn("tar", ["-xz", "-C", dest, `--strip-components=${stripComponents}`], {
    stdio: ["pipe", "inherit", "inherit"],
  });
  await pipeline(body, tar.stdin!);
  await new Promise<void>((resolve, reject) => {
    tar.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`tar exited with ${code}`)),
    );
  });
}

export interface ExtractOptions {
  /**
   * If set, only the contents under this path within the repo land at
   * `dest/`. Everything else is extracted to a temp dir and discarded.
   */
  subPath?: string | null;
}

async function extractStream(body: Readable, dest: string, subPath: string | null): Promise<void> {
  if (!subPath) {
    // Common case — strip the outer `owner-repo-<sha>/` wrapper.
    await pipeTarball(body, dest, 1);
    return;
  }
  // Monorepo case — extract everything to a temp dir, then promote
  // just the wanted sub-path to dest.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-extract-"));
  try {
    await pipeTarball(body, tmpDir, 1);
    const src = path.join(tmpDir, subPath);
    if (!fs.existsSync(src)) {
      throw new Error(`Sub-path "${subPath}" not found in the downloaded archive.`);
    }
    fs.mkdirSync(dest, { recursive: true });
    // Copy contents of src → dest. Use recursive copy + remove the
    // outer src to "move" without crossing devices.
    fs.cpSync(src, dest, { recursive: true });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function fetchAndExtractTarball(
  url: string,
  dest: string,
  opts: ExtractOptions = {},
): Promise<void> {
  const headers: Record<string, string> = {
    "User-Agent": "metahub-installer",
    Accept: "application/vnd.github+json",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  // Bound the download so a stalled CDN can't hang an install indefinitely.
  const res = await fetch(url, {
    redirect: "follow",
    headers,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(`tarball fetch failed: HTTP ${res.status}`);
  }
  if (!res.body) {
    throw new Error("tarball response has no body");
  }
  const nodeStream = Readable.fromWeb(res.body as never);
  await extractStream(nodeStream, dest, opts.subPath ?? null);
}

// Local-test helper for tarballs already on disk. Streams the raw
// .tar.gz bytes straight to `tar -xz` so decompression happens once,
// inside the tar process. (An earlier version gunzipped in-process AND
// passed -z, which BSD tar tolerated but GNU tar rejected with exit 2.)
export async function extractLocalTarball(
  filePath: string,
  dest: string,
  opts: ExtractOptions = {},
): Promise<void> {
  const fileStream = fs.createReadStream(filePath);
  await extractStream(fileStream as unknown as Readable, dest, opts.subPath ?? null);
}
