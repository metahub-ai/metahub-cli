/**
 * `mh outdated` — compare each install's pinned SHA against the
 * currently-published SHA in the registry. Renders a two-section
 * report: "Available" (real updates) + "Unchecked" (curator imports
 * or other artifacts the public catalog can't resolve).
 */
import { getPublicArtifact, listInstalled } from "@metahub/installer";
import { c, glyph, header, relTime } from "../lib/ui.js";

export async function outdated(rest: string[] = []): Promise<number> {
  const json = rest.includes("--json");
  const installs = await listInstalled();
  if (installs.length === 0) {
    if (json) {
      console.log(JSON.stringify({ count: 0, available: [], unchecked: [] }, null, 2));
      return 0;
    }
    console.log(header("outdated", "0 installs"));
    console.log();
    console.log(`  ${c.dim("Nothing installed — try")} mh install skills/<slug>`);
    return 0;
  }
  const outdatedRows: Array<{
    ref: string;
    localSha: string;
    remoteSha: string;
    remoteVersion: string | null;
    publishedAt: string | null;
  }> = [];
  const unchecked: string[] = [];
  for (const i of installs) {
    try {
      const { artifact } = await getPublicArtifact(i.kind, i.slug);
      // Missing local SHA with a known remote SHA is still an update (not "up to date").
      if (artifact.publishedSha && artifact.publishedSha !== i.publishedSha) {
        outdatedRows.push({
          ref: `${i.kind}s/${i.slug}`,
          localSha: i.publishedSha ? i.publishedSha.slice(0, 7) : "—",
          remoteSha: artifact.publishedSha.slice(0, 7),
          remoteVersion: artifact.version,
          publishedAt: artifact.publishedAt,
        });
      }
    } catch (err) {
      const msg = (err as Error).message;
      // "not found" / 404 against the public catalog is by far the
      // common case (curator imports, private artifacts) — collect
      // them into "unchecked" rather than scary "couldn't check".
      if (/HTTP 404|not found/i.test(msg)) {
        unchecked.push(`${i.kind}s/${i.slug}`);
      } else {
        unchecked.push(`${i.kind}s/${i.slug}  ${c.dim("(" + msg + ")")}`);
      }
    }
  }

  if (json) {
    const payload = {
      count: outdatedRows.length,
      available: outdatedRows.map((r) => ({
        ref: r.ref,
        localSha: r.localSha,
        remoteSha: r.remoteSha,
        remoteVersion: r.remoteVersion,
        publishedAt: r.publishedAt,
      })),
      // Strip ANSI from unchecked entries (we may have inlined a
      // dimmed error message above) so JSON consumers don't see
      // escape sequences. Easiest: split before the two-space gap.
      unchecked: unchecked.map((u) => u.split("  ")[0]!),
    };
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  }

  console.log(
    header(
      "outdated",
      `${outdatedRows.length} update${outdatedRows.length === 1 ? "" : "s"} available`,
      unchecked.length > 0 ? `${unchecked.length} unchecked` : undefined,
    ),
  );
  console.log();

  if (outdatedRows.length === 0 && unchecked.length === 0) {
    console.log(
      `  ${c.green(glyph.check)} ${c.dim(`All ${installs.length} install${installs.length === 1 ? "" : "s"} up to date.`)}`,
    );
    return 0;
  }

  const refW = Math.max(
    ...outdatedRows.map((r) => r.ref.length),
    ...unchecked.map((u) => u.replace(/\s+\(.+/, "").length),
    20,
  );

  if (outdatedRows.length > 0) {
    console.log(`  ${c.bold("Available")}`);
    for (const r of outdatedRows) {
      const when = r.publishedAt ? c.dim("  " + relTime(r.publishedAt)) : "";
      const ver = r.remoteVersion ? c.cyan("v" + r.remoteVersion) : c.dim("—");
      console.log(
        `    ${c.bold(r.ref.padEnd(refW))}  ${ver}  ${c.dim(r.localSha)} ${glyph.arrow} ${c.cyan(r.remoteSha)}${when}`,
      );
    }
    console.log();
  }

  if (unchecked.length > 0) {
    console.log(
      `  ${c.bold("Unchecked")}  ${c.dim("(no public catalog entry — curator imports or private artifacts)")}`,
    );
    for (const u of unchecked) {
      console.log(`    ${c.dim(u)}`);
    }
    console.log();
  }

  if (outdatedRows.length > 0) {
    console.log(`  ${c.dim("Run")} mh update ${c.dim("<ref>")} ${c.dim("or")} mh update --all`);
  }
  return 0;
}
