/**
 * `mh uninstall <kind>/<slug>` — remove an installed artifact, unwire
 * its hook (MCP client configs), and drop the install-ledger entry.
 */
import type { ArtifactKind } from "@metahub/shared";
import { listInstalls, uninstallArtifact } from "@metahub/installer";
import { parseRef } from "../lib/resolve-ref.js";
import { c, glyph, header, refError, tildeify } from "../lib/ui.js";

export async function uninstall(arg: string): Promise<number> {
  const parsed = parseRef(arg);
  if (!parsed.ok) {
    console.error(refError(arg));
    return 2;
  }
  let kind: ArtifactKind;
  let slug: string;
  if (parsed.ref) {
    ({ kind, slug } = parsed.ref);
  } else {
    // Bare slug — resolve from the local install ledger. Exactly one
    // installed kind proceeds; anything else errors, never guesses.
    slug = parsed.bareSlug;
    const matches = listInstalls().filter((i) => i.slug === slug);
    if (matches.length === 0) {
      console.log(header("uninstall", slug));
      console.log();
      console.log(`  ${c.dim("Not installed — nothing to do.")}`);
      return 0;
    }
    if (matches.length > 1) {
      console.error(
        `${c.red(glyph.cross)} ${c.bold(slug)} is installed as more than one kind — pick one:`,
      );
      for (const i of matches) console.error(`    mh uninstall ${i.kind}s/${i.slug}`);
      return 2;
    }
    kind = matches[0]!.kind;
  }
  const result = await uninstallArtifact({ kind, slug });
  if (!result.removed) {
    console.log(header("uninstall", `${kind}/${slug}`));
    console.log();
    console.log(`  ${c.dim("Not installed — nothing to do.")}`);
    return 0;
  }
  console.log(header("uninstall", `${kind}/${slug}`));
  console.log();
  console.log(
    `  ${c.green(glyph.check)} ${c.dim("removed   ")} ${tildeify(result.record!.installPath)}`,
  );
  console.log(
    `  ${c.green(glyph.check)} ${c.dim("unwired   ")} hook (MCP client configs / sidecar)`,
  );
  console.log(`  ${c.green(glyph.check)} ${c.dim("ledger    ")} installs.json cleaned`);
  // Skills can pull siblings in from the same repo (a marketplace.json
  // groups them). Those install as their own ledger rows, so point at
  // them instead of silently leaving orphans.
  if (kind === "skill") {
    const siblings = listInstalls().filter(
      (i) => i.kind === "skill" && i.installedWith === slug && i.slug !== slug,
    );
    if (siblings.length > 0) {
      console.log();
      console.log(
        `  ${c.yellow(glyph.warn)} ${siblings.length} related skill${siblings.length === 1 ? "" : "s"} came along with ${slug} and ${siblings.length === 1 ? "is" : "are"} still installed:`,
      );
      console.log(`    ${c.dim(siblings.map((s) => s.slug).join(" · "))}`);
      console.log(`    ${c.dim("Remove individually with")} mh uninstall skills/<slug>`);
    }
  }
  console.log();
  console.log(`  ${c.dim("To reinstall:")} mh install ${kind}s/${slug}`);
  return 0;
}
