/**
 * `mh refresh` — walk every installed skill and (re-)wire it into
 * every CURRENTLY-detected harness. The intended use case:
 *
 *   1. User installs the CLI + a few skills with only Claude Code
 *      on their machine.
 *   2. Later, they install Codex, Gemini CLI, Cursor or Continue.
 *   3. `mh refresh` links the existing skills into ~/.agents/skills
 *      (and Antigravity's skills dir), and writes Continue / Zed rule
 *      files, without re-downloading anything.
 *
 * The mirror logic lives in @metahub/installer (`refreshSkillWiring`)
 * and persists its result to the wiring ledger on every pass, so the
 * ledger always matches what is on disk.
 *
 * No network calls. No tarball re-downloads. Just file writes.
 */
import {
  clientLabel,
  listInstalled,
  refreshSkillWiring,
  type SkillMirrorResult,
} from "@metahub/installer";
import { c, glyph, header, tildeify } from "../lib/ui.js";

export async function refresh(): Promise<number> {
  const installs = await listInstalled();
  const skills = installs.filter((i) => i.kind === "skill");
  if (skills.length === 0) {
    console.log(header("refresh", "nothing to refresh"));
    console.log();
    console.log(
      `  ${c.dim(installs.length === 0 ? "No installs found." : "No skills installed.")}`,
    );
    return 0;
  }

  console.log(
    header("refresh", `checking ${skills.length} skill${skills.length === 1 ? "" : "s"}`),
  );
  console.log();

  const added: Array<{ ref: string; client: string; path: string }> = [];
  const errored: Array<{ ref: string; result: SkillMirrorResult }> = [];
  const missing: string[] = [];

  for (const inst of skills) {
    const ref = `${inst.kind}s/${inst.slug}`;
    const out = refreshSkillWiring(inst.slug, { artifactId: inst.artifactId });
    if (out.results.some((r) => r.status === "skipped-no-source")) {
      missing.push(ref);
      continue;
    }
    for (const w of out.added) {
      added.push({ ref, client: clientLabel(w.client), path: w.path });
    }
    for (const r of out.results) {
      if (r.status === "error") errored.push({ ref, result: r });
    }
  }

  if (added.length === 0 && errored.length === 0 && missing.length === 0) {
    console.log(
      `  ${c.green(glyph.check)} ${c.dim("All skills already wired into every detected harness.")}`,
    );
    return 0;
  }

  if (added.length > 0) {
    console.log(`  ${c.bold("New wirings")}`);
    for (const o of added) {
      console.log(
        `    ${c.green(glyph.check)} ${o.ref.padEnd(28)} ${c.dim("→ " + o.client + "  " + tildeify(o.path))}`,
      );
    }
    console.log();
  }

  if (missing.length > 0) {
    console.log(`  ${c.bold("Missing on disk")}`);
    for (const ref of missing) {
      console.log(
        `    ${c.yellow(glyph.warn)} ${ref.padEnd(28)} ${c.dim("no SKILL.md — run `mh install " + ref + "` to restore it")}`,
      );
    }
    console.log();
  }

  if (errored.length > 0) {
    console.log(`  ${c.bold("Errors")}`);
    for (const o of errored) {
      console.log(
        `    ${c.red(glyph.cross)} ${o.ref.padEnd(28)} ${c.dim(o.result.clientLabel + ": " + (o.result.error ?? "unknown"))}`,
      );
    }
    console.log();
  }

  console.log(
    `  ${c.dim("Summary:")} ${added.length} new wiring${added.length === 1 ? "" : "s"}${errored.length > 0 ? `, ${errored.length} error${errored.length === 1 ? "" : "s"}` : ""}`,
  );
  return errored.length === 0 ? 0 : 1;
}
