/**
 * Artifact-ref parsing shared by install / uninstall / trace.
 *
 * Canonical form is `<kind>/<slug>` (kind singular or plural), but a
 * bare slug is accepted too: commands resolve it against a probe —
 * the public catalog for install, the local ledger for uninstall and
 * trace — and proceed when exactly one kind matches. Ambiguity is an
 * error listing the qualified refs, never a guess.
 */
import type { ArtifactKind } from "@metahub/shared";

export const KIND_FROM_SEGMENT: Record<string, ArtifactKind> = {
  skill: "skill",
  skills: "skill",
  mcp: "mcp",
  mcps: "mcp",
  agent: "agent",
  agents: "agent",
  plugin: "plugin",
  plugins: "plugin",
};

export const ALL_KINDS: readonly ArtifactKind[] = ["skill", "mcp", "agent", "plugin"];

export interface ParsedRef {
  kind: ArtifactKind;
  slug: string;
}

export type ParseRefResult =
  | { ok: true; ref: ParsedRef }
  | { ok: true; bareSlug: string; ref?: undefined }
  | { ok: false; badKindSegment: string };

/**
 * Parse a CLI artifact argument. `skills/pdf` → a full ref;
 * `pdf` → a bare slug for the caller to resolve; `wat/pdf` → error
 * carrying the unrecognized kind segment.
 */
export function parseRef(arg: string): ParseRefResult {
  const m = arg.match(/^([^/]+)\/(.+)$/);
  if (!m) return { ok: true, bareSlug: arg };
  const kind = KIND_FROM_SEGMENT[m[1]!.toLowerCase()];
  if (!kind) return { ok: false, badKindSegment: m[1]! };
  return { ok: true, ref: { kind, slug: m[2]! } };
}

/**
 * Resolve a bare slug by probing every kind. The probe returns true
 * when `<kind>/<slug>` exists; probe rejections count as "not found"
 * so one flaky kind lookup can't fail the whole resolution.
 */
export async function resolveBareSlug(
  slug: string,
  probe: (kind: ArtifactKind, slug: string) => Promise<boolean>,
): Promise<ArtifactKind[]> {
  const hits = await Promise.all(
    ALL_KINDS.map(async (kind) => ((await probe(kind, slug).catch(() => false)) ? kind : null)),
  );
  return hits.filter((k): k is ArtifactKind => k !== null);
}
