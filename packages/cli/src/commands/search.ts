/**
 * `mh search [--kind=…] [--sort=…] [--limit=N] [--json] <query>` — ranked
 * search over the public catalog.
 *
 * Calls the server-ranked endpoint (GET /api/public/artifacts/search), which
 * applies relevance-gating plus the popularity/quality blend (see
 * @metahub/shared rankArtifacts). Results arrive already ranked AND filtered —
 * no client-side filtering — and the first three carry a "top-pick" reason,
 * rendered under a "Top matches" marker.
 */
import { searchPublicArtifacts } from "@metahub/installer";
import type { ArtifactKind, RankedArtifact, SearchSort } from "@metahub/shared";
import { c, glyph, header } from "../lib/ui.js";

const KIND_FROM_FLAG: Record<string, ArtifactKind> = {
  skill: "skill",
  mcp: "mcp",
  agent: "agent",
  plugin: "plugin",
};

const SORT_VALUES = new Set<SearchSort>([
  "best",
  "installs",
  "rating",
  "trending",
  "updated",
  "newest",
]);

interface ParsedArgs {
  query: string;
  kind?: ArtifactKind;
  sort: SearchSort;
  limit: number;
  json: boolean;
}

function parseArgs(raw: string): ParsedArgs {
  const tokens = raw.split(/\s+/);
  let kind: ArtifactKind | undefined;
  let sort: SearchSort = "best";
  let limit = 20;
  let json = false;
  const remaining: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith("--kind=")) {
      kind = KIND_FROM_FLAG[t.slice("--kind=".length)];
    } else if (t === "--kind") {
      const v = tokens[i + 1];
      if (v) {
        kind = KIND_FROM_FLAG[v];
        i++;
      }
    } else if (t.startsWith("--sort=")) {
      const v = t.slice("--sort=".length) as SearchSort;
      if (SORT_VALUES.has(v)) sort = v;
    } else if (t === "--sort") {
      const v = tokens[i + 1] as SearchSort | undefined;
      if (v && SORT_VALUES.has(v)) {
        sort = v;
        i++;
      }
    } else if (t.startsWith("--limit=")) {
      const n = parseInt(t.slice("--limit=".length), 10);
      if (Number.isFinite(n) && n > 0) limit = Math.min(n, 100);
    } else if (t === "--limit") {
      const n = parseInt(tokens[i + 1] ?? "", 10);
      if (Number.isFinite(n) && n > 0) {
        limit = Math.min(n, 100);
        i++;
      }
    } else if (t === "--json") {
      json = true;
    } else {
      remaining.push(t);
    }
  }
  return { query: remaining.join(" ").trim(), kind, sort, limit, json };
}

/**
 * Render the "badges" annotation a row can carry. Badges are a compact
 * quality/maintenance signal (battle-tested, well-reviewed, …) shown inline.
 */
function badgeTag(a: RankedArtifact): string {
  if (!a.badges || a.badges.length === 0) return "";
  const top = a.badges.slice(0, 2);
  return c.dim(`  [${top.join(", ")}]`);
}

export async function search(raw: string): Promise<number> {
  const { query, kind, sort, limit, json } = parseArgs(raw);
  if (!query) {
    if (json) {
      console.error(JSON.stringify({ error: { code: "usage", message: "query is required" } }));
      return 2;
    }
    console.error(
      "Usage: mh search [--kind=skill|mcp|agent|plugin] [--sort=best|installs|rating|trending|updated|newest] [--limit=N] [--json] <query>",
    );
    return 2;
  }
  try {
    const data = await searchPublicArtifacts({ q: query, kind, sort, limit });
    const matches = data.items; // already ranked + filtered server-side

    if (json) {
      const payload = {
        query,
        kind: kind ?? null,
        sort,
        limit,
        count: matches.length,
        total: data.total,
        results: matches.map((m) => ({
          rank: m.rank,
          kind: m.kind,
          slug: m.slug,
          name: m.name,
          tagline: m.tagline ?? null,
          version: m.version ?? null,
          why: m.why,
        })),
      };
      console.log(JSON.stringify(payload, null, 2));
      return 0;
    }

    const trailing =
      `${data.total} total · showing ${matches.length}` +
      (kind ? " · kind=" + kind : "") +
      (sort !== "best" ? " · sort=" + sort : "");
    console.log(header("search", `"${query}"`, trailing));
    console.log();

    if (matches.length === 0) {
      console.log(`  ${c.dim("Nothing matches. Try a different keyword.")}`);
      return 0;
    }

    const slugW = Math.max(...matches.map((m) => m.slug.length), 16);
    let lastWasTopPick = false;
    for (const m of matches) {
      const isTopPick = m.why.includes("top-pick");
      // "Top matches" banner before the first top-pick; a divider once they end.
      if (isTopPick && !lastWasTopPick) {
        console.log(`  ${c.accent(glyph.star + " Top matches")}`);
        console.log();
      } else if (!isTopPick && lastWasTopPick) {
        console.log(`  ${c.dim("── more results ──")}`);
        console.log();
      }
      lastWasTopPick = isTopPick;

      const ver = m.version ? c.cyan("v" + m.version) : c.dim("—");
      const tease =
        (m.tagline ?? m.description).slice(0, 96) +
        ((m.tagline ?? m.description).length > 96 ? "…" : "");
      const mark = isTopPick ? c.accent(glyph.star + " ") : "  ";
      console.log(
        `${mark}${c.dim(m.kind.padEnd(7))} ${c.bold(m.slug.padEnd(slugW))}  ${ver}${badgeTag(m)}`,
      );
      console.log(`          ${c.dim(tease)}`);
      const meta: string[] = [];
      if (m.authorHandle) meta.push(c.dim("@" + m.authorHandle));
      if (m.tags && m.tags.length > 0) meta.push(c.dim(m.tags.slice(0, 4).join(", ")));
      if (meta.length > 0) console.log(`          ${meta.join("    ")}`);
      console.log();
    }
    const first = matches[0]!;
    console.log(
      `  ${c.dim("Install with")} mh install ${c.dim("<ref>")}  ${c.dim("(e.g.")} mh install ${first.kind}/${first.slug}${c.dim(")")}`,
    );
    return 0;
  } catch (err) {
    const msg = (err as Error).message;
    if (json) {
      console.error(JSON.stringify({ error: { code: "search-failed", message: msg } }));
      return 1;
    }
    console.error(`${c.red(glyph.cross)} search failed: ${msg}`);
    if (/Not authenticated|Bearer required/.test(msg)) {
      console.error(
        `  ${c.dim("Public discovery should work without login. Check `mh config get portalUrl`.")}`,
      );
    }
    return 1;
  }
}
