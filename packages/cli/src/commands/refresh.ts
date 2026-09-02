/**
 * `mh refresh` — walk every installed artifact and (re-)wire it into
 * every CURRENTLY-detected client. The intended use case:
 *
 *   1. User installs the CLI + a few skills with only Claude Code
 *      on their machine.
 *   2. Later, they install Cursor.
 *   3. `mh refresh` writes the existing skills into ~/.cursor/rules/
 *      without re-downloading anything.
 *
 * The flow is read-from-state-then-write:
 *   - Walk listInstalled() for the list of artifacts.
 *   - For each, walk the capability matrix; check the wiring ledger.
 *   - If a (client, kind) row applies AND the client is detected AND
 *     we haven't already written it, write it and record in the ledger.
 *
 * No network calls. No tarball re-downloads. Just file writes.
 */
import fs from "node:fs";
import path from "node:path";
import {
  capabilityFor,
  clientsForKind,
  detectClient,
  findWiring,
  installPathFor,
  listInstalled,
  parseSkillSource,
  recordWiring,
  transformSkill,
  type ClientId,
  type WiringEntry,
  type WiringStrategy,
} from "@metahub/installer";
import { c, glyph, header, tildeify } from "../lib/ui.js";

function clientLabelFor(id: ClientId): string {
  switch (id) {
    case "claude-code":
      return "Claude Code";
    case "claude-desktop":
      return "Claude Desktop";
    case "cursor":
      return "Cursor";
    case "antigravity":
      return "Antigravity";
    case "vs-code":
      return "VS Code";
    case "zed":
      return "Zed";
    case "windsurf":
      return "Windsurf";
    case "continue":
      return "Continue";
    case "cline":
      return "Cline";
    case "goose":
      return "Goose";
    case "codex-cli":
      return "Codex CLI";
    case "opencode":
      return "opencode";
  }
}

export async function refresh(): Promise<number> {
  const installs = await listInstalled();
  if (installs.length === 0) {
    console.log(header("refresh", "nothing to refresh"));
    console.log();
    console.log(`  ${c.dim("No installs found.")}`);
    return 0;
  }

  console.log(
    header("refresh", `checking ${installs.length} install${installs.length === 1 ? "" : "s"}`),
  );
  console.log();

  type Outcome = {
    ref: string;
    client: ClientId;
    path: string;
    status: "wrote" | "skipped" | "error";
    error?: string;
  };
  const outcomes: Outcome[] = [];

  for (const inst of installs) {
    const ref = `${inst.kind}s/${inst.slug}`;
    // We only refresh kinds with capability rows beyond Claude Code.
    // For now that's skills; plugins/agents stay Claude-Code-only.
    if (inst.kind !== "skill") continue;

    // Source: re-read SKILL.md from the canonical install dir.
    const canonical = installPathFor("skill", inst.slug);
    const sourcePath = path.join(canonical, "SKILL.md");
    let raw: string;
    try {
      raw = fs.readFileSync(sourcePath, "utf8");
    } catch {
      outcomes.push({
        ref,
        client: "claude-code",
        path: sourcePath,
        status: "skipped",
        error: "no SKILL.md on disk",
      });
      continue;
    }
    const source = parseSkillSource(inst.slug, raw);

    // For each client that can consume a skill, check whether we've
    // already wired it — if not, and the client is detected, wire now.
    const existing = findWiring("skill", inst.slug);
    const alreadyWired = new Set<ClientId>((existing?.wirings ?? []).map((w) => w.client));
    const newWirings: WiringEntry[] = existing?.wirings ?? [];

    for (const row of clientsForKind("skill")) {
      if (row.client === "claude-code") continue; // canonical; never re-write
      if (alreadyWired.has(row.client)) continue;
      if (!detectClient(row.client)) continue;

      const target = row.targetPath(inst.slug);
      if (!target) continue;
      try {
        if (row.strategy === "opencode-skill-md") {
          // opencode reads a whole skill folder (verbatim SKILL.md), so
          // copy the canonical dir (with supporting files) rather than
          // writing a single transformed file.
          fs.cpSync(canonical, target, { recursive: true, force: true });
        } else {
          const content = transformSkill(row.strategy as WiringStrategy, source);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, content, "utf8");
        }
        newWirings.push({
          client: row.client,
          path: target,
          strategy: row.strategy,
          writtenMs: Date.now(),
          status: "wrote",
        });
        outcomes.push({ ref, client: row.client, path: target, status: "wrote" });
      } catch (err) {
        outcomes.push({
          ref,
          client: row.client,
          path: target,
          status: "error",
          error: (err as Error).message,
        });
      }
    }

    if (newWirings.length !== (existing?.wirings.length ?? 0)) {
      // Persist updated set.
      const cap = capabilityFor("claude-code", "skill");
      void cap; // satisfy linter (we use cap implicitly via the existing entry)
      recordWiring({
        artifactId: existing?.artifactId ?? inst.artifactId,
        kind: "skill",
        slug: inst.slug,
        installedMs: existing?.installedMs ?? Date.now(),
        wirings: newWirings,
      });
    }
  }

  const wrote = outcomes.filter((o) => o.status === "wrote");
  const errored = outcomes.filter((o) => o.status === "error");

  if (wrote.length === 0 && errored.length === 0) {
    console.log(
      `  ${c.green(glyph.check)} ${c.dim("All installs already wired into every detected client.")}`,
    );
    return 0;
  }

  if (wrote.length > 0) {
    console.log(`  ${c.bold("New wirings")}`);
    for (const o of wrote) {
      console.log(
        `    ${c.green(glyph.check)} ${o.ref.padEnd(28)} ${c.dim("→ " + clientLabelFor(o.client) + "  " + tildeify(o.path))}`,
      );
    }
    console.log();
  }

  if (errored.length > 0) {
    console.log(`  ${c.bold("Errors")}`);
    for (const o of errored) {
      console.log(
        `    ${c.red(glyph.cross)} ${o.ref.padEnd(28)} ${c.dim(clientLabelFor(o.client) + ": " + (o.error ?? "unknown"))}`,
      );
    }
    console.log();
  }

  console.log(
    `  ${c.dim("Summary:")} ${wrote.length} new wiring${wrote.length === 1 ? "" : "s"}${errored.length > 0 ? `, ${errored.length} error${errored.length === 1 ? "" : "s"}` : ""}`,
  );
  return errored.length === 0 ? 0 : 1;
}
