/**
 * `mh update <kind>/<slug>` — re-fetch the latest published SHA and
 * re-install in place.
 * `mh update --all` — update every install with a per-row status pill
 * and a closing tally (checked / updated / already current / failed).
 */
import { findInstall, getPublicArtifact, listInstalled } from "@metahub/installer";
import { install } from "./install.js";
import type { ArtifactKind } from "@metahub/shared";
import { c, glyph, header, refError } from "../lib/ui.js";

const KIND_FROM_SEGMENT: Record<string, ArtifactKind> = {
  skill: "skill",
  skills: "skill",
  mcp: "mcp",
  mcps: "mcp",
  agent: "agent",
  agents: "agent",
  plugin: "plugin",
  plugins: "plugin",
};

export async function update(arg: string): Promise<number> {
  if (arg === "--all") return updateAll();
  const m = arg.match(/^([^/]+)\/(.+)$/);
  if (!m) {
    console.error("Usage: mh update <kind>/<slug>  |  mh update --all");
    return 2;
  }
  const kind = KIND_FROM_SEGMENT[m[1]!];
  const slug = m[2]!;
  if (!kind) {
    console.error(refError(arg));
    return 2;
  }
  const existing = findInstall(kind, slug);
  if (!existing) {
    console.log(`${c.red(glyph.cross)} ${kind}/${slug} is not installed.`);
    console.log(`  ${c.dim("Use")} mh install ${kind}s/${slug} ${c.dim("instead.")}`);
    return 1;
  }
  console.log(
    header("update", `${kind}/${slug}`, `was ${existing.publishedSha?.slice(0, 7) ?? "—"}`),
  );
  console.log();
  return install(arg);
}

async function updateAll(): Promise<number> {
  const installs = await listInstalled();
  if (installs.length === 0) {
    console.log(header("update --all", "0 installs"));
    console.log();
    console.log(`  ${c.dim("Nothing installed.")}`);
    return 0;
  }

  console.log(
    header(
      "update --all",
      `checking ${installs.length} install${installs.length === 1 ? "" : "s"}`,
    ),
  );
  console.log();

  let updated = 0;
  let upToDate = 0;
  let failed = 0;
  const unchecked: string[] = [];
  const refW = Math.max(...installs.map((i) => i.slug.length), 16) + 4;

  for (const i of installs) {
    const ref = `${i.kind}s/${i.slug}`;
    const slugCol = i.slug.padEnd(refW);
    let needsUpdate = false;
    let remoteSha: string | null = null;
    let catalogMissing = false;
    try {
      const { artifact } = await getPublicArtifact(i.kind, i.slug);
      if (artifact.publishedSha && i.publishedSha && artifact.publishedSha !== i.publishedSha) {
        needsUpdate = true;
        remoteSha = artifact.publishedSha;
      }
    } catch (err) {
      const msg = (err as Error).message;
      // 404 / "not found" against the public catalog is the common
      // case for curator imports and private artifacts — these aren't
      // failures, they just can't be checked for updates. We route
      // them into "Unchecked" the same way `mh outdated` does instead
      // of scaring the user with a red ✗.
      if (/HTTP 404|not found/i.test(msg)) {
        catalogMissing = true;
      } else {
        // Real catalog error (network / 5xx) — try the install anyway;
        // if that fails we'll mark it as a hard failure below.
        needsUpdate = true;
      }
    }

    if (catalogMissing) {
      unchecked.push(ref);
      continue;
    }

    if (!needsUpdate) {
      console.log(`  ${c.green(glyph.check)} ${c.bold(slugCol)} ${c.dim("up to date")}`);
      upToDate++;
      continue;
    }

    process.stdout.write(`  ${c.dim(glyph.step)} ${c.bold(slugCol)} ${c.dim("updating →")} `);
    const code = await install(ref, { quiet: true });
    if (code === 0) {
      console.log(`${c.green(glyph.check)} ${c.cyan(remoteSha?.slice(0, 7) ?? "ok")}`);
      updated++;
    } else {
      console.log(`${c.red(glyph.cross)} ${c.red("failed")}`);
      failed++;
    }
  }

  if (unchecked.length > 0) {
    console.log();
    console.log(
      `  ${c.bold("Unchecked")}  ${c.dim("(no public catalog entry — curator imports or private artifacts)")}`,
    );
    for (const ref of unchecked) {
      console.log(`    ${c.dim(ref)}`);
    }
  }

  console.log();
  const tally = [
    `${c.dim("checked:")} ${installs.length - unchecked.length}`,
    `${c.dim("updated:")} ${updated}`,
    `${c.dim("already current:")} ${upToDate}`,
    unchecked.length > 0 ? `${c.dim("unchecked:")} ${unchecked.length}` : null,
    failed > 0 ? `${c.red("failed:")} ${failed}` : null,
  ]
    .filter(Boolean)
    .join("  ·  ");
  console.log(`  ${tally}`);
  // Exit non-zero only when every attempted update failed. Unchecked
  // installs don't count as failures — they're just not in the public
  // catalog. Up-to-date installs count as wins.
  const attempted = updated + failed;
  return attempted > 0 && updated === 0 ? 1 : 0;
}
