/**
 * Local registry of installed artifacts. Records the per-install API
 * key the SDK uses for telemetry. Backed by `~/.metahub/installs.json`.
 */
import fs from "node:fs";
import { installsFile } from "./paths.js";
import { writePrivateFile } from "@metahub/auth";
import type { ArtifactKind } from "@metahub/shared";

export interface InstalledRecord {
  artifactId: string;
  installId: string;
  slug: string;
  kind: ArtifactKind;
  version: string | null;
  installPath: string;
  ingestApiKey: string;
  publishedSha: string | null;
  installedAt: string;
  /**
   * For skills installed as a sibling of another skill (the
   * specialist skills a repo's marketplace.json groups with the
   * requested one): the slug of the skill that pulled this in.
   * Undefined for standalone installs. Lets updates move satellites
   * with their parent while never clobbering a standalone install,
   * and lets uninstall hint at what else came along.
   */
  installedWith?: string;
}

interface Store {
  installs: InstalledRecord[];
}

function readStore(): Store {
  try {
    const raw = fs.readFileSync(installsFile(), "utf8");
    return JSON.parse(raw) as Store;
  } catch {
    return { installs: [] };
  }
}

function writeStore(s: Store): void {
  // Every record carries an `ingestApiKey` the SDK authenticates with,
  // so this is a credential file and gets the same 0600 treatment as
  // the auth config.
  writePrivateFile(installsFile(), JSON.stringify(s, null, 2));
}

export function listInstalls(): InstalledRecord[] {
  return readStore().installs;
}

export function recordInstall(rec: InstalledRecord): void {
  const s = readStore();
  s.installs = [...s.installs.filter((r) => !(r.kind === rec.kind && r.slug === rec.slug)), rec];
  writeStore(s);
}

export function removeInstall(kind: ArtifactKind, slug: string): InstalledRecord | null {
  const s = readStore();
  const idx = s.installs.findIndex((r) => r.kind === kind && r.slug === slug);
  if (idx === -1) return null;
  const [removed] = s.installs.splice(idx, 1);
  writeStore(s);
  /* v8 ignore next — splice with a valid idx always returns one element */
  return removed ?? null;
}

export function findInstall(kind: ArtifactKind, slug: string): InstalledRecord | undefined {
  return readStore().installs.find((r) => r.kind === kind && r.slug === slug);
}
