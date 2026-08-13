/**
 * Tests for the tarball download/extract layer.
 *
 * `extractLocalTarball` reads from disk and lets us exercise both the
 * `strip-components=1` (common case) and `subPath` (monorepo) paths
 * with a real tar.gz built on the fly. `fetchAndExtractTarball` adds
 * a fetch wrapper on top — we stub fetch to return our fixture stream.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import zlib from "node:zlib";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-installer-tar-"));
  delete process.env.GITHUB_TOKEN;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeFixtureTarball(): { tgz: string; workDir: string } {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-tar-fixture-"));
  const root = "owner-repo-deadbeef";
  fs.mkdirSync(path.join(workDir, root, "src"), { recursive: true });
  fs.writeFileSync(path.join(workDir, root, "README.md"), "# Hello");
  fs.writeFileSync(path.join(workDir, root, "src", "index.js"), "console.log(1);");
  fs.mkdirSync(path.join(workDir, root, "packages", "child"), { recursive: true });
  fs.writeFileSync(path.join(workDir, root, "packages", "child", "SKILL.md"), "child skill body");
  const tgz = path.join(workDir, "fixture.tar.gz");
  const r = spawnSync("tar", ["-czf", tgz, "-C", workDir, root], { stdio: "pipe" });
  if (r.status !== 0) throw new Error(`tar failed: ${r.stderr.toString()}`);
  return { tgz, workDir };
}

describe("extractLocalTarball (no subPath)", () => {
  it("strips the owner-repo-sha wrapper and lands files at dest/", async () => {
    const { tgz, workDir } = makeFixtureTarball();
    try {
      const { extractLocalTarball } = await import("../src/tarball");
      const dest = path.join(tmp, "extract");
      await extractLocalTarball(tgz, dest);
      expect(fs.existsSync(path.join(dest, "README.md"))).toBe(true);
      expect(fs.existsSync(path.join(dest, "src", "index.js"))).toBe(true);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe("extractLocalTarball (subPath)", () => {
  it("only the requested sub-path's contents land at dest/", async () => {
    const { tgz, workDir } = makeFixtureTarball();
    try {
      const { extractLocalTarball } = await import("../src/tarball");
      const dest = path.join(tmp, "extract");
      await extractLocalTarball(tgz, dest, { subPath: "packages/child" });
      expect(fs.existsSync(path.join(dest, "SKILL.md"))).toBe(true);
      expect(fs.existsSync(path.join(dest, "README.md"))).toBe(false);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("throws when the requested sub-path is missing from the archive", async () => {
    const { tgz, workDir } = makeFixtureTarball();
    try {
      const { extractLocalTarball } = await import("../src/tarball");
      const dest = path.join(tmp, "extract");
      await expect(extractLocalTarball(tgz, dest, { subPath: "packages/missing" })).rejects.toThrow(
        /not found/,
      );
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe("fetchAndExtractTarball", () => {
  it("fails when the response is non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 404 }));
    const { fetchAndExtractTarball } = await import("../src/tarball");
    await expect(
      fetchAndExtractTarball("https://example.com/x.tgz", path.join(tmp, "d")),
    ).rejects.toThrow(/HTTP 404/);
  });

  it("fails when the response has no body", async () => {
    const empty = new Response(null, { status: 200 });
    Object.defineProperty(empty, "body", { value: null });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(empty);
    const { fetchAndExtractTarball } = await import("../src/tarball");
    await expect(
      fetchAndExtractTarball("https://example.com/x.tgz", path.join(tmp, "d")),
    ).rejects.toThrow(/no body/);
  });

  it("succeeds end-to-end with a tar.gz stream", async () => {
    const { tgz, workDir } = makeFixtureTarball();
    try {
      const buf = fs.readFileSync(tgz);
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(buf, { status: 200 }));
      const { fetchAndExtractTarball } = await import("../src/tarball");
      const dest = path.join(tmp, "stream-extract");
      await fetchAndExtractTarball("https://example.com/x.tgz", dest);
      expect(fs.existsSync(path.join(dest, "README.md"))).toBe(true);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("sends Authorization: Bearer when GITHUB_TOKEN is set", async () => {
    process.env.GITHUB_TOKEN = "ghp_test";
    const empty = new Response(null, { status: 404 });
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(empty);
    const { fetchAndExtractTarball } = await import("../src/tarball");
    await expect(
      fetchAndExtractTarball("https://example.com/x.tgz", path.join(tmp, "d")),
    ).rejects.toThrow();
    const headers = (spy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ghp_test");
  });
});

describe("tar process error path", () => {
  it("rejects when the underlying tar process exits non-zero", async () => {
    const fakeTgz = path.join(tmp, "fake.tar.gz");
    fs.writeFileSync(fakeTgz, Buffer.from("this is not a gzipped tar archive at all"));
    const { extractLocalTarball } = await import("../src/tarball");
    await expect(extractLocalTarball(fakeTgz, path.join(tmp, "out"))).rejects.toThrow(/tar exited/);
  });
});

describe("zlib paranoia", () => {
  it("the fixture starts with the gzip magic bytes", () => {
    const { tgz, workDir } = makeFixtureTarball();
    try {
      const head = fs.readFileSync(tgz).subarray(0, 2);
      expect(head[0]).toBe(0x1f);
      expect(head[1]).toBe(0x8b);
      expect(() => zlib.gunzipSync(fs.readFileSync(tgz))).not.toThrow();
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});
