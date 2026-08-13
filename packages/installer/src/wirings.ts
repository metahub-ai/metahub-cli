/**
 * Wiring ledger — a JSON file at `~/.metahub/wirings.json` recording
 * every per-(client, artifact) write the installer makes.
 *
 * Why a separate file from `installs.json`?
 *   - installs.json is the "what artifact lives where" ledger (one
 *     entry per kind/slug, points at the install dir).
 *   - wirings.json is the "what did we write into other people's
 *     config dirs on behalf of this artifact" ledger (multiple
 *     entries per artifact — one per client we wired to).
 *
 * Without this file:
 *   - `mh uninstall` can't reliably undo every place we touched.
 *   - `mh refresh` can't tell "I haven't wired skill/pdf into Cursor
 *     yet" from "I tried but it failed" — we just retry blindly.
 *   - `mh doctor` can't show "skill/pdf is wired into 4 places".
 *
 * The ledger is the single source of truth for these.
 *
 * Concurrency note: writes are last-writer-wins. The installer is
 * single-threaded per process; if two `mh` processes race on the
 * same artifact we accept the second write. Read-modify-write is
 * fast enough for the catalog size we expect (<100 wirings per
 * machine).
 */
import fs from "node:fs";
import path from "node:path";
import type { ArtifactKind } from "@metahub/shared";
import type { ClientId, WiringStrategy } from "./capabilities.js";
import { configRoot } from "./paths.js";
import { writePrivateFile } from "@metahub/auth";

/**
 * Single wiring entry: "for artifact X, we wrote to disk path P on
 * behalf of client C using strategy S". Strategy is recorded so
 * uninstall knows whether to delete a file, splice a JSON key, etc.
 */
export interface WiringEntry {
  /** Client we wired this artifact for. */
  client: ClientId;
  /** Absolute path that was written / spliced. */
  path: string;
  /** Format we used — drives the unwire branch. */
  strategy: WiringStrategy;
  /**
   * For mcp-json wirings, the JSON key (e.g. "github") so we can
   * splice it out cleanly. Null for kinds that own their own file.
   */
  key?: string | null;
  /** When we wrote — useful for diagnostics + future drift detection. */
  writtenMs: number;
  /** Human-friendly status: "wrote" or "manual" (paste required). */
  status: "wrote" | "manual";
}

export interface WiringSet {
  /** ArtifactId so we can survive slug-rename / re-onboard. */
  artifactId: string;
  kind: ArtifactKind;
  slug: string;
  installedMs: number;
  /** One entry per client we wired to. */
  wirings: WiringEntry[];
}

interface Ledger {
  /** Bumped when we change the on-disk shape. */
  version: 1;
  /** Keyed by `${kind}/${slug}` for fast lookup. */
  byRef: Record<string, WiringSet>;
}

function ledgerPath(): string {
  return path.join(configRoot(), "wirings.json");
}

function emptyLedger(): Ledger {
  return { version: 1, byRef: {} };
}

/** Read the ledger from disk. Empty ledger when the file is absent. */
export function readLedger(): Ledger {
  const file = ledgerPath();
  if (!fs.existsSync(file)) return emptyLedger();
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<Ledger>;
    if (parsed.version !== 1 || !parsed.byRef) {
      // Future migration hook lives here. For v1 we just reset.
      return emptyLedger();
    }
    return parsed as Ledger;
  } catch {
    // Corrupt — better to start fresh than crash the CLI.
    return emptyLedger();
  }
}

/** Write the ledger atomically. mkdir -p the config root first. */
export function writeLedger(l: Ledger): void {
  const dir = configRoot();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `wirings.json.tmp.${process.pid}`);
  // The temp file is written private and renamed over the target, so
  // the ledger is never briefly world-readable mid-write. `rename`
  // preserves the mode, which is why writing the tmp file correctly is
  // sufficient — but the destination may predate this change, so it is
  // repaired explicitly too.
  writePrivateFile(tmp, JSON.stringify(l, null, 2));
  fs.renameSync(tmp, ledgerPath());
  fs.chmodSync(ledgerPath(), 0o600);
}

/**
 * Record the result of wiring an artifact across N clients. Overwrites
 * any prior set for the same `${kind}/${slug}` — the new wiring set
 * is authoritative.
 */
export function recordWiring(set: WiringSet): void {
  const l = readLedger();
  l.byRef[`${set.kind}/${set.slug}`] = set;
  writeLedger(l);
}

/** Look up an artifact's wirings. Returns null when not in the ledger. */
export function findWiring(kind: ArtifactKind, slug: string): WiringSet | null {
  const l = readLedger();
  return l.byRef[`${kind}/${slug}`] ?? null;
}

/** Drop an artifact's wirings from the ledger. Idempotent. */
export function dropWiring(kind: ArtifactKind, slug: string): WiringSet | null {
  const l = readLedger();
  const ref = `${kind}/${slug}`;
  const existing = l.byRef[ref];
  if (!existing) return null;
  delete l.byRef[ref];
  writeLedger(l);
  return existing;
}

/** All wirings across all artifacts. Used by `mh refresh`. */
export function listWirings(): WiringSet[] {
  return Object.values(readLedger().byRef);
}
