/**
 * `mh show <kind>/<slug>` — print detailed info for one artifact
 * without installing. Handy for previewing before commit. Hits the
 * per-artifact public endpoint so reviewSummary + author + badges
 * are all available (unlike `mh search`'s lightweight projection).
 */
import { findInstall, getPublicArtifact } from "@metahub/installer";
import type { ArtifactKind } from "@metahub/shared";
import { c, glyph, header, kv, refError, relTime, tildeify } from "../lib/ui.js";

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

export async function show(arg: string, rest: string[] = []): Promise<number> {
  const json = rest.includes("--json");
  const m = arg.match(/^([^/]+)\/(.+)$/);
  if (!m) {
    if (json) {
      console.error(
        JSON.stringify({ error: { code: "usage", message: "expected <kind>/<slug>" } }),
      );
      return 2;
    }
    console.error("Usage: mh show <kind>/<slug>");
    return 2;
  }
  const kind = KIND_FROM_SEGMENT[m[1]!];
  const slug = m[2]!;
  if (!kind) {
    if (json) {
      console.error(JSON.stringify({ error: { code: "usage", message: "bad kind segment" } }));
      return 2;
    }
    console.error(refError(arg));
    return 2;
  }
  try {
    const { artifact, reviewSummary } = await getPublicArtifact(kind, slug);
    const local = findInstall(kind, slug);
    const ref = `${kind}s/${slug}`;

    if (json) {
      const payload = {
        kind,
        slug,
        ref,
        name: artifact.name,
        tagline: artifact.tagline ?? null,
        description: artifact.description,
        version: artifact.version ?? null,
        publishedSha: artifact.publishedSha ?? null,
        publishedAt: artifact.publishedAt ?? null,
        authorHandle: artifact.authorHandle ?? null,
        repoUrl: artifact.repoUrl,
        repoBranch: artifact.repoBranch ?? null,
        tags: artifact.tags,
        badges: artifact.badges ?? [],
        reviewSummary: { count: reviewSummary.count, avg: reviewSummary.avg },
        installed: local
          ? {
              installPath: local.installPath,
              publishedSha: local.publishedSha ?? null,
              upToDate: local.publishedSha === artifact.publishedSha,
            }
          : null,
      };
      console.log(JSON.stringify(payload, null, 2));
      return 0;
    }

    const trailing = [
      artifact.version ? `v${artifact.version}` : null,
      artifact.publishedSha ? artifact.publishedSha.slice(0, 7) : null,
    ]
      .filter(Boolean)
      .join(" · ");
    console.log(header("show", ref, trailing || undefined));
    console.log();

    console.log(`  ${c.bold(artifact.name)}`);
    const showTagline = shouldPrintTagline(artifact.tagline, artifact.description);
    const showDesc = shouldPrintDescription(artifact.tagline, artifact.description);
    if (showTagline && artifact.tagline) console.log(`  ${c.dim(artifact.tagline)}`);
    if (showDesc) {
      console.log();
      // Description gets some breathing room; soft-wrap at 80 cols.
      const wrapped = artifact.description
        .split(/\n+/)
        .map((para) => softWrap(para, 80, "  "))
        .join("\n\n");
      console.log(wrapped);
    }
    console.log();

    const rows: Array<[string, string]> = [];
    if (artifact.authorHandle) rows.push(["author", "@" + artifact.authorHandle]);
    rows.push(["repo", c.cyan(artifact.repoUrl)]);
    if (artifact.repoBranch) rows.push(["branch", artifact.repoBranch]);
    if (artifact.publishedAt) {
      rows.push([
        "published",
        `${artifact.publishedAt}  ${c.dim("(" + relTime(artifact.publishedAt) + ")")}`,
      ]);
    }
    if (artifact.supportUrl) rows.push(["support", c.cyan(artifact.supportUrl)]);
    if (artifact.docsUrl) rows.push(["docs", c.cyan(artifact.docsUrl)]);
    if (artifact.tags.length > 0) rows.push(["tags", artifact.tags.join(", ")]);
    if (artifact.badges && artifact.badges.length > 0) {
      rows.push(["badges", artifact.badges.join(", ")]);
    }
    rows.push([
      "reviews",
      reviewSummary.count === 0
        ? c.dim("(none yet)")
        : `${c.yellow(glyph.star)} ${reviewSummary.avg.toFixed(1)} · ${reviewSummary.count} rating${reviewSummary.count === 1 ? "" : "s"}`,
    ]);
    console.log(kv(rows));
    console.log();

    if (local) {
      const sameSha = local.publishedSha === artifact.publishedSha;
      console.log(
        `  ${c.green(glyph.check)} ${c.bold("installed locally")} ${c.dim("@")} ${c.cyan(local.publishedSha?.slice(0, 7) ?? "—")}  ${c.dim(tildeify(local.installPath))}`,
      );
      if (!sameSha) {
        console.log(
          `  ${c.yellow(glyph.warn)} ${c.dim("Update available — run")} mh update ${kind}s/${slug}`,
        );
      }
    } else {
      console.log(`  ${c.dim("Install with")} mh install ${kind}s/${slug}`);
    }
    return 0;
  } catch (err) {
    const msg = (err as Error).message;
    if (json) {
      const code = /HTTP 404/.test(msg) ? "not-found" : "show-failed";
      console.error(JSON.stringify({ error: { code, message: msg } }));
      return 1;
    }
    if (/HTTP 404/.test(msg)) {
      console.error(`${c.red(glyph.cross)} No such artifact: ${kind}/${slug}`);
      console.error(`  ${c.dim("Try")} mh search ${slug}`);
    } else {
      console.error(`${c.red(glyph.cross)} show failed: ${msg}`);
    }
    return 1;
  }
}

/**
 * Whitespace-collapse + lowercase normalizer. Used by the duplication
 * guards below so "Generate PDFs" vs "  generate pdfs\n" compare equal.
 */
function norm(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * True when the artifact description should be printed. We skip when
 * tagline + description carry the same content (some publishers fill
 * both fields with identical text); the tagline already covered it.
 */
export function shouldPrintDescription(tagline: string | null, description: string): boolean {
  if (!description) return false;
  const t = norm(tagline);
  const d = norm(description);
  if (!t) return true;
  return t !== d;
}

/**
 * True when the tagline should be printed as a separate dim line.
 * Always prints when present; the duplication guard lives on the
 * description side (we keep the short tagline, drop the redundant
 * description block).
 */
export function shouldPrintTagline(tagline: string | null, _description: string): boolean {
  return Boolean(tagline && tagline.trim());
}

/** Minimal indented word-wrap. ANSI-naive — fine for descriptions which are plain. */
function softWrap(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = indent;
  for (const w of words) {
    if (!w) continue;
    if (cur.length + w.length + 1 > width) {
      lines.push(cur);
      cur = indent + w;
    } else {
      cur = cur === indent ? cur + w : cur + " " + w;
    }
  }
  if (cur.trim()) lines.push(cur);
  return lines.join("\n");
}
