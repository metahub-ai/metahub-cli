/**
 * `mh install <kind>/<slug>` — thin CLI wrapper over `installArtifact`
 * from @metahub/installer. Owns the terminal UI (progress lines,
 * post-install summary, MCP wiring report); the library does the work.
 */
import type { ArtifactKind } from "@metahub/shared";
import { getPublicArtifact, installArtifact, type InstallProgressEvent } from "@metahub/installer";
import { cliVersion } from "../lib/version.js";
import { parseRef, resolveBareSlug } from "../lib/resolve-ref.js";
import { c, glyph, header, ms as fmtMs, refError, tildeify } from "../lib/ui.js";

export interface InstallOptions {
  /** Suppress the success summary at the end. Used by `mh update --all`. */
  quiet?: boolean;
}

/**
 * Tracks per-stage timing so the install output shows where time is
 * spent. Cheap — one Date.now() per stage transition.
 */
class StageTimer {
  private startedAt = Date.now();
  private lastEvent = Date.now();

  /** ms since the last stage event. */
  delta(): number {
    const d = Date.now() - this.lastEvent;
    this.lastEvent = Date.now();
    return d;
  }

  /** ms since install start. */
  total(): number {
    return Date.now() - this.startedAt;
  }
}

function makeProgressRenderer() {
  const t = new StageTimer();
  const w = 10; // step-label column width
  return {
    onEvent(event: InstallProgressEvent): void {
      switch (event.stage) {
        case "resolve":
          // Resolve has only just *started* at this point — printing
          // a green check here would lie if the catalog lookup ends
          // up 404. Use the neutral step glyph; if the next stage
          // (download) fires, the user knows resolve passed.
          console.log(
            `  ${c.dim(glyph.step)} ${"resolve".padEnd(w)} ${c.dim("checking catalog…")}`,
          );
          break;
        case "replace-existing":
          console.log(
            `  ${c.yellow(glyph.warn)} ${"replace".padEnd(w)} ${c.dim("existing install at " + tildeify(event.path))}`,
          );
          break;
        case "download": {
          const sha = event.sha?.slice(0, 7) ?? "—";
          const sub = event.subPath ? `  ${c.dim("(subdir " + event.subPath + ")")}` : "";
          console.log(
            `  ${c.green(glyph.check)} ${"download".padEnd(w)} ${c.cyan(sha)}${sub}  ${c.dim(fmtMs(t.delta()))}`,
          );
          break;
        }
        case "related":
          console.log(
            `  ${c.green(glyph.check)} ${"related".padEnd(w)} ${event.slug}  ${c.dim("skill from the same repo")}`,
          );
          break;
        case "wire":
          console.log(
            `  ${c.green(glyph.check)} ${"wire".padEnd(w)} ${c.dim("telemetry sidecar")}  ${c.dim(fmtMs(t.delta()))}`,
          );
          break;
        case "record":
          // silent — covered by the post-install summary
          break;
      }
    },
    elapsedMs(): number {
      return t.total();
    },
  };
}

export async function install(arg: string, opts: InstallOptions = {}): Promise<number> {
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
    // Bare slug — resolve it against the public catalog. Exactly one
    // kind match proceeds; anything else errors rather than guessing.
    slug = parsed.bareSlug;
    const kinds = await resolveBareSlug(slug, async (k, s) => {
      await getPublicArtifact(k, s);
      return true;
    });
    if (kinds.length === 0) {
      console.error(
        `${c.red(glyph.cross)} No artifact named ${c.bold(slug)} in the catalog. Use ${c.bold("<kind>/<slug>")} — e.g. \`skills/pdf\`, \`mcps/github\` — or try \`mh search ${slug}\`.`,
      );
      return 2;
    }
    if (kinds.length > 1) {
      console.error(
        `${c.red(glyph.cross)} ${c.bold(slug)} exists as more than one kind — pick one:`,
      );
      for (const k of kinds) console.error(`    mh install ${k}s/${slug}`);
      return 2;
    }
    kind = kinds[0]!;
  }

  if (!opts.quiet) {
    console.log(header("install", `${kind}/${slug}`));
    console.log();
  }

  const renderer = makeProgressRenderer();

  try {
    const result = await installArtifact({
      kind,
      slug,
      host: "mh-cli",
      hostVersion: cliVersion(),
      onProgress: opts.quiet ? () => {} : (e) => renderer.onEvent(e),
    });

    if (opts.quiet) return 0;

    console.log();
    console.log(
      `  ${c.bold(result.name)}  ${c.cyan(result.version ? "v" + result.version : "—")}  ${c.dim("in " + fmtMs(renderer.elapsedMs()))}`,
    );
    console.log(`    ${c.dim("Pinned    ")} ${c.cyan(result.sha?.slice(0, 7) ?? "—")}`);
    console.log(`    ${c.dim("Location  ")} ${tildeify(result.installPath)}`);
    if (kind === "skill" || kind === "plugin" || kind === "agent") {
      console.log(`    ${c.dim("Telemetry ")} ${tildeify(result.installPath)}/.metahub.json`);
    }

    if (result.warning) {
      console.log();
      console.log(`  ${c.yellow(glyph.warn)} ${c.yellow(result.warning)}`);
    }

    if ((result.relatedSkills ?? []).length > 0) {
      renderRelatedSkills(result.relatedSkills);
    }

    if (kind === "mcp") renderMcpWiring(result);
    else if (kind === "skill") {
      renderSkillMirrors(result.skillMirrors ?? []);
      renderSkillNextSteps(kind, slug);
    } else if (kind === "plugin") renderSkillNextSteps(kind, slug);
    else if (kind === "agent") renderAgentNextSteps(slug, result.installPath);

    console.log();
    console.log(`  ${c.dim("To remove:")} mh uninstall ${kind}s/${slug}`);
    if ((result.relatedSkills ?? []).length > 0) {
      console.log(`  ${c.dim("Related skills remove individually — see")} mh list`);
    }
    return 0;
  } catch (err) {
    const msg = (err as Error).message;
    console.error();
    if (/HTTP 404/.test(msg)) {
      console.error(`  ${c.red(glyph.cross)} Artifact ${c.bold(kind + "/" + slug)} not found.`);
      console.error(`  ${c.dim("Try")} mh search ${slug}  ${c.dim("to find candidates.")}`);
    } else if (/Not authenticated/.test(msg)) {
      console.error(`  ${c.red(glyph.cross)} ${msg}`);
      console.error(
        `  ${c.dim("Public artifacts shouldn't require login — check your portal URL with")} mh config get portalUrl`,
      );
    } else {
      console.error(`  ${c.red(glyph.cross)} install failed: ${msg}`);
    }
    return 1;
  }
}

interface InstallResultLike {
  clientsWired?: Array<{
    client: string;
    status: string;
    configPath: string;
    manualSnippet?: string;
  }>;
}

function renderMcpWiring(result: InstallResultLike): void {
  const wrote = (result.clientsWired ?? []).filter((cli) => cli.status === "wrote");
  const manual = (result.clientsWired ?? []).filter((cli) => cli.status === "manual");
  if (wrote.length > 0) {
    console.log();
    console.log(
      `  ${c.bold("Wired into " + wrote.length + " client" + (wrote.length === 1 ? "" : "s"))}`,
    );
    for (const cli of wrote) {
      console.log(
        `    ${c.green(glyph.check)} ${cli.client.padEnd(18)} ${c.dim(tildeify(cli.configPath))}`,
      );
    }
    console.log();
    console.log(
      `  ${c.dim("Restart your client" + (wrote.length === 1 ? "" : "s") + " to load the new MCP server.")}`,
    );
  }
  if (manual.length > 0) {
    console.log();
    console.log(
      `  ${c.yellow(glyph.warn)} ${manual.length} client${manual.length === 1 ? "" : "s"} use${manual.length === 1 ? "s" : ""} a non-JSON config. Paste this snippet into:`,
    );
    for (const cli of manual) {
      console.log();
      console.log(`    ${c.bold(cli.client)} ${c.dim(tildeify(cli.configPath))}`);
      if (cli.manualSnippet) {
        for (const line of cli.manualSnippet.split("\n")) {
          console.log(`      ${c.dim(line)}`);
        }
      }
    }
  }
  if (wrote.length === 0 && manual.length === 0) {
    console.log();
    console.log(`  ${c.yellow(glyph.warn)} No AI clients detected on this machine.`);
    console.log(`    ${c.dim("mh recognizes: Claude Code, Claude Desktop, Cursor, Antigravity,")}`);
    console.log(`    ${c.dim("VS Code, Zed, Windsurf, Continue, Cline, Goose, Codex CLI.")}`);
  }
}

interface SkillMirror {
  client: string;
  clientLabel: string;
  path: string;
  status: "wrote" | "skipped-not-detected" | "skipped-no-source" | "error";
  error?: string;
}

function renderSkillMirrors(mirrors: SkillMirror[]): void {
  // Claude Code is the canonical install path — always wrote.
  // mirrors[] only carries the *other* clients (Cursor / Continue /
  // Zed). When nothing is detected we skip the section entirely so
  // the user isn't bombarded with "n/a" lines.
  const wrote = mirrors.filter((m) => m.status === "wrote");
  const errored = mirrors.filter((m) => m.status === "error");
  // Always show Claude Code since that's the canonical install.
  console.log();
  console.log(`  ${c.bold("Wired into")}`);
  console.log(
    `    ${c.green(glyph.check)} ${"Claude Code".padEnd(16)} ${c.dim("canonical install")}`,
  );
  for (const m of wrote) {
    console.log(
      `    ${c.green(glyph.check)} ${m.clientLabel.padEnd(16)} ${c.dim(tildeify(m.path))}`,
    );
  }
  for (const m of errored) {
    console.log(
      `    ${c.red(glyph.cross)} ${m.clientLabel.padEnd(16)} ${c.dim((m.error ?? "error").slice(0, 80))}`,
    );
  }
}

function renderRelatedSkills(related: Array<{ slug: string; installPath: string }>): void {
  console.log();
  console.log(
    `  ${c.bold("Related skills")} ${c.dim("(" + related.length + " from the same repo — the skill needs them)")}`,
  );
  for (const rel of related) {
    console.log(
      `    ${c.green(glyph.check)} ${rel.slug.padEnd(16)} ${c.dim(tildeify(rel.installPath))}`,
    );
  }
}

function renderSkillNextSteps(kind: "skill" | "plugin", slug: string): void {
  console.log();
  console.log(`  ${c.bold("Next steps")}`);
  if (kind === "skill") {
    // Claude Code reads SKILL.md on next prompt — no restart needed
    // for the canonical install. Cursor / Continue / Zed mtime-watch
    // their rules dirs — also no restart needed.
    console.log(`    ${c.dim(glyph.step)} Use the skill from any wired client — no restart needed`);
    console.log(
      `    ${c.dim(glyph.step)} Run \`mh refresh\` after installing a new AI client to wire there too`,
    );
    console.log(
      `    ${c.dim(glyph.step)} Publisher-driven spans? Add ${c.cyan("`mh trace skill/" + slug + "`")} to SKILL.md`,
    );
  } else {
    console.log(`    ${c.dim(glyph.step)} Restart Claude Code to pick up the new plugin`);
    console.log(`    ${c.dim(glyph.step)} Use the plugin — spans flow to developer.metahub.ai`);
    console.log(
      `    ${c.dim(glyph.step)} Publisher-driven spans? Add ${c.cyan("`mh trace plugin/" + slug + "`")} to plugin manifest`,
    );
  }
}

function renderAgentNextSteps(slug: string, installPath: string): void {
  const ident = slug.replace(/[^a-zA-Z0-9]/g, "_");
  console.log();
  console.log(`  ${c.bold("Next steps")}`);
  console.log(`    ${c.dim(glyph.step)} Import from your Node code:`);
  console.log(`        ${c.cyan(`import ${ident} from "${tildeify(installPath)}";`)}`);
  console.log(
    `    ${c.dim(glyph.step)} ${c.dim("defineAgent() reads .metahub.json and emits spans automatically.")}`,
  );
}
