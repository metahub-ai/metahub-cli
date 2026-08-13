/**
 * `mh list` — show installed artifacts grouped by kind. Compact by
 * default (one line per install); pass `--verbose` for the full path
 * on a separate row.
 */
import { listInstalled, type InstalledRecord } from "@metahub/installer";
import type { ArtifactKind } from "@metahub/shared";
import { c, glyph, header, tildeify } from "../lib/ui.js";

const KIND_ORDER: ArtifactKind[] = ["skill", "mcp", "agent", "plugin"];
const KIND_LABEL: Record<ArtifactKind, string> = {
  skill: "skills",
  mcp: "mcps",
  agent: "agents",
  plugin: "plugins",
};

export async function list(rest: string[] = []): Promise<number> {
  // Backwards-compat: when called without a rest array, fall back to
  // argv so `mh list --verbose` still works from the dispatcher.
  const args = rest.length > 0 ? rest : process.argv.slice(3);
  const verbose = args.includes("--verbose") || args.includes("-v");
  const json = args.includes("--json");

  const installs = await listInstalled();

  if (json) {
    const payload = {
      count: installs.length,
      installs: installs.map((i) => ({
        kind: i.kind,
        slug: i.slug,
        ref: `${i.kind}s/${i.slug}`,
        version: i.version ?? null,
        publishedSha: i.publishedSha ?? null,
        installPath: i.installPath,
        installedAt: i.installedAt,
        artifactId: i.artifactId,
        installId: i.installId,
      })),
    };
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  }

  if (installs.length === 0) {
    console.log(header("installed", "0 artifacts"));
    console.log();
    console.log(`  ${c.dim("Try")} mh install skills/<slug>`);
    return 0;
  }

  // Group by kind, preserving install order within each group.
  const byKind = new Map<ArtifactKind, InstalledRecord[]>();
  for (const i of installs) {
    if (!byKind.has(i.kind)) byKind.set(i.kind, []);
    byKind.get(i.kind)!.push(i);
  }

  console.log(
    header("installed", `${installs.length} artifact${installs.length === 1 ? "" : "s"}`),
  );
  console.log();

  // Column widths so kinds align across sections.
  const slugW = Math.max(...installs.map((i) => i.slug.length), 16);

  for (const kind of KIND_ORDER) {
    const items = byKind.get(kind);
    if (!items || items.length === 0) continue;
    console.log(`${c.dim(KIND_LABEL[kind])} ${c.dim("(" + items.length + ")")}`);
    for (const i of items) {
      const ver = i.version ? `v${i.version}` : "—";
      const sha = i.publishedSha ? i.publishedSha.slice(0, 7) : "—";
      const path = tildeify(i.installPath);
      // Compact form: name, version, sha, path on one line. Verbose
      // adds the full untruncated path on a continuation line.
      console.log(
        `  ${c.green(glyph.check)} ${c.bold(i.slug.padEnd(slugW))}  ${c.dim(ver.padEnd(8))}${c.cyan(sha)}  ${c.dim(path)}`,
      );
      if (verbose && i.installPath !== path) {
        console.log(`     ${c.dim("→ " + i.installPath)}`);
      }
    }
    console.log();
  }

  console.log(
    `  ${c.dim("Total:")} ${installs.length} installed ${c.dim("·")} run \`mh outdated\` to check for updates`,
  );
  return 0;
}
