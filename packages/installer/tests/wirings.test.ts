/**
 * Round-trip tests for the wiring ledger. Walks the read → record →
 * find → drop cycle and verifies the on-disk JSON shape.
 *
 * Uses METAHUB_E2E_HOME to redirect ~/.metahub to a tmpdir per test.
 * The auth + installer libraries both honor that env var (see
 * packages/auth/src/paths.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dropWiring, findWiring, listWirings, readLedger, recordWiring } from "../src/wirings.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-wirings-"));
  process.env.METAHUB_E2E_HOME = tmp;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.METAHUB_E2E_HOME;
});

describe("ledger lifecycle", () => {
  it("starts empty when no file exists", () => {
    expect(readLedger().byRef).toEqual({});
    expect(listWirings()).toEqual([]);
  });

  it("recordWiring + findWiring round-trip", () => {
    recordWiring({
      artifactId: "art_1",
      kind: "skill",
      slug: "pdf",
      installedMs: 1700000000000,
      wirings: [
        {
          client: "claude-code",
          path: "/Users/x/.claude/skills/pdf",
          strategy: "anthropic-skill-md",
          writtenMs: 1700000000000,
          status: "wrote",
        },
        {
          client: "cursor",
          path: "/Users/x/.cursor/rules/pdf.mdc",
          strategy: "cursor-rule-mdc",
          writtenMs: 1700000000000,
          status: "wrote",
        },
      ],
    });
    const got = findWiring("skill", "pdf");
    expect(got).not.toBeNull();
    expect(got!.wirings).toHaveLength(2);
    expect(got!.wirings.map((w) => w.client).sort()).toEqual(["claude-code", "cursor"]);
  });

  it("recordWiring overwrites prior set for the same ref", () => {
    recordWiring({
      artifactId: "art_1",
      kind: "skill",
      slug: "pdf",
      installedMs: 1,
      wirings: [
        {
          client: "claude-code",
          path: "/a",
          strategy: "anthropic-skill-md",
          writtenMs: 1,
          status: "wrote",
        },
      ],
    });
    recordWiring({
      artifactId: "art_1",
      kind: "skill",
      slug: "pdf",
      installedMs: 2,
      wirings: [
        {
          client: "claude-code",
          path: "/a",
          strategy: "anthropic-skill-md",
          writtenMs: 2,
          status: "wrote",
        },
        {
          client: "cursor",
          path: "/b",
          strategy: "cursor-rule-mdc",
          writtenMs: 2,
          status: "wrote",
        },
      ],
    });
    const got = findWiring("skill", "pdf");
    expect(got!.installedMs).toBe(2);
    expect(got!.wirings).toHaveLength(2);
  });

  it("dropWiring returns the dropped set and removes it from the ledger", () => {
    recordWiring({
      artifactId: "art_1",
      kind: "skill",
      slug: "pdf",
      installedMs: 1,
      wirings: [
        {
          client: "claude-code",
          path: "/a",
          strategy: "anthropic-skill-md",
          writtenMs: 1,
          status: "wrote",
        },
      ],
    });
    const dropped = dropWiring("skill", "pdf");
    expect(dropped).not.toBeNull();
    expect(dropped!.slug).toBe("pdf");
    expect(findWiring("skill", "pdf")).toBeNull();
  });

  it("listWirings returns every set", () => {
    for (const slug of ["pdf", "pptx", "drawio-skill"]) {
      recordWiring({
        artifactId: `art_${slug}`,
        kind: "skill",
        slug,
        installedMs: 1,
        wirings: [],
      });
    }
    expect(listWirings()).toHaveLength(3);
  });
});

describe("file format", () => {
  it("file lives at ~/.metahub/wirings.json", () => {
    recordWiring({
      artifactId: "art_x",
      kind: "skill",
      slug: "pdf",
      installedMs: 1,
      wirings: [],
    });
    expect(fs.existsSync(path.join(tmp, ".metahub", "wirings.json"))).toBe(true);
  });

  it("corrupt JSON is treated as empty ledger (no throw)", () => {
    fs.mkdirSync(path.join(tmp, ".metahub"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".metahub", "wirings.json"), "{ not json");
    expect(readLedger().byRef).toEqual({});
  });

  it("future version bumps don't crash (returns empty)", () => {
    fs.mkdirSync(path.join(tmp, ".metahub"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".metahub", "wirings.json"),
      JSON.stringify({ version: 99, byRef: { "skill/pdf": {} } }),
    );
    expect(readLedger().byRef).toEqual({});
  });
});
