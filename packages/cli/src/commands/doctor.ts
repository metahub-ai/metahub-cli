/**
 * `mh doctor <kind>/<slug>` — sanity-check a local install. Prints
 * what's on disk, what file an MCP would launch, and whether the
 * sidecar telemetry credentials are intact. Each row is a single
 * named check; the closing tally tells the user at a glance how many
 * passed.
 */
import fs from "node:fs";
import path from "node:path";
import {
  CLIENT_ADAPTERS,
  agentsSkillsDir,
  findInstall,
  getHome,
  installPathFor,
  readJsonConfig,
} from "@metahub/installer";
import type { ArtifactKind } from "@metahub/shared";
import { c, glyph, header, refError, tildeify } from "../lib/ui.js";

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

/** `skip` rows are shown but not counted: a manual config mh cannot read. */
type CheckResult = { status: "ok" | "fail" | "skip"; label: string; value: string };

/**
 * `mh doctor` exit code matters: scripts use it to decide whether to
 * re-install. Pass = 0, any fail = 1, not-installed = 1.
 */
export async function doctor(arg: string, rest: string[] = []): Promise<number> {
  const json = rest.includes("--json");
  const m = arg.match(/^([^/]+)\/(.+)$/);
  if (!m) {
    if (json) {
      console.error(
        JSON.stringify({ error: { code: "usage", message: "expected <kind>/<slug>" } }),
      );
      return 2;
    }
    console.error("Usage: mh doctor <kind>/<slug>");
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
  const local = findInstall(kind, slug);
  if (!local) {
    if (json) {
      console.log(
        JSON.stringify(
          {
            ref: `${kind}s/${slug}`,
            installed: false,
            checks: [],
            passed: 0,
            failed: 0,
          },
          null,
          2,
        ),
      );
      return 1;
    }
    console.log(header("doctor", `${kind}/${slug}`));
    console.log();
    console.log(`  ${c.red(glyph.cross)} Not installed.`);
    console.log(`  ${c.dim("Install with")} mh install ${kind}s/${slug}`);
    return 1;
  }

  const checks: CheckResult[] = [];

  const dest = local.installPath;
  if (fs.existsSync(dest)) {
    const stat = fs.statSync(dest);
    checks.push({
      status: "ok",
      label: "install dir",
      value: `${tildeify(dest)} ${c.dim("(" + (stat.isDirectory() ? "dir" : "file") + ")")}`,
    });
  } else {
    checks.push({
      status: "fail",
      label: "install dir",
      value: `${tildeify(dest)} ${c.dim("(missing)")}`,
    });
  }

  const sidecar = path.join(dest, ".metahub.json");
  if (fs.existsSync(sidecar)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(sidecar, "utf8")) as {
        artifactId?: string;
        ingestApiKey?: string;
      };
      checks.push({
        status: "ok",
        label: "telemetry sidecar",
        value: `${c.dim((parsed.ingestApiKey?.slice(0, 8) ?? "?") + "…")}  ${c.dim("artifact " + (parsed.artifactId ?? "?"))}`,
      });
    } catch {
      checks.push({ status: "fail", label: "telemetry sidecar", value: c.red("parse error") });
    }
  } else {
    checks.push({
      status: "fail",
      label: "telemetry sidecar",
      value: `${c.dim(tildeify(sidecar))}  ${c.red("(missing — telemetry will be silent)")}`,
    });
  }

  if (kind === "skill" || kind === "plugin") {
    const claudeDir =
      kind === "skill"
        ? path.join(getHome(), ".claude", "skills", slug)
        : path.join(getHome(), ".claude", "plugins", slug);
    if (fs.existsSync(claudeDir)) {
      checks.push({ status: "ok", label: "claude code path", value: tildeify(claudeDir) });
    } else {
      checks.push({
        status: "fail",
        label: "claude code path",
        value: `${tildeify(claudeDir)} ${c.red("(Claude Code won't find it)")}`,
      });
    }
    if (kind === "skill") {
      const skillMd = path.join(installPathFor("skill", slug), "SKILL.md");
      if (fs.existsSync(skillMd)) {
        checks.push({ status: "ok", label: "SKILL.md", value: tildeify(skillMd) });
      } else {
        checks.push({
          status: "fail",
          label: "SKILL.md",
          value: `${tildeify(skillMd)} ${c.red("(missing — skill won't load)")}`,
        });
      }
      // Codex, Gemini CLI, Cursor, opencode and Goose read the shared
      // Agent Skills directory; the install links the skill there.
      const agentsLink = path.join(agentsSkillsDir(), slug);
      if (fs.existsSync(path.join(agentsLink, "SKILL.md"))) {
        checks.push({ status: "ok", label: "agent skills dir", value: tildeify(agentsLink) });
      } else {
        checks.push({
          status: "fail",
          label: "agent skills dir",
          value: `${tildeify(agentsLink)} ${c.red("(missing — Codex / Gemini / Cursor won't see it; run `mh refresh`)")}`,
        });
      }
    }
  }

  if (kind === "mcp") {
    let wiredCount = 0;
    const keys = ["mcpServers", "servers", "context_servers", "mcp"] as const;
    for (const adapter of CLIENT_ADAPTERS) {
      if (!adapter.detect()) continue;
      const file = adapter.configPath();
      const isJson = file.endsWith(".json") || file.endsWith(".jsonc");
      if (!isJson) {
        if (file.endsWith(".toml")) {
          let text = "";
          try {
            text = fs.readFileSync(file, "utf8");
          } catch {
            /* absent */
          }
          const present = text.includes(`[mcp_servers.${slug}]`);
          if (present) wiredCount++;
          checks.push({
            status: present ? "ok" : "fail",
            label: adapter.name,
            value: present
              ? c.dim(`[mcp_servers.${slug}] in ${tildeify(file)}`)
              : `no [mcp_servers.${slug}] in ${tildeify(file)}`,
          });
        } else {
          checks.push({
            status: "skip",
            label: adapter.name,
            value: c.dim(`manual config — check ${tildeify(file)} yourself`),
          });
        }
        continue;
      }
      const read = readJsonConfig(file);
      if (read.state === "absent") {
        checks.push({
          status: "fail",
          label: adapter.name,
          value: `no entry (${tildeify(file)} absent)`,
        });
        continue;
      }
      if (read.state === "invalid") {
        checks.push({
          status: "fail",
          label: adapter.name,
          value: `${tildeify(file)} ${c.red("is not valid JSON")}`,
        });
        continue;
      }
      const key = keys.find((k) => k in read.data);
      const entry = key
        ? ((read.data[key] as Record<string, unknown>)[slug] as
            { command?: string | string[]; args?: string[] } | undefined)
        : undefined;
      if (!entry) {
        checks.push({
          status: "fail",
          label: adapter.name,
          value: `no entry in ${tildeify(file)}`,
        });
        continue;
      }
      wiredCount++;
      const argv = Array.isArray(entry.command)
        ? entry.command
        : [entry.command ?? "?", ...(entry.args ?? [])];
      checks.push({ status: "ok", label: adapter.name, value: c.dim(argv.join(" ")) });
      // A `node <file>` launch must point at a file that exists; an
      // `npx …` launch resolves at start time and has nothing to check.
      const main = argv[0] === "node" ? argv[1] : undefined;
      if (main && fs.existsSync(main)) {
        checks.push({ status: "ok", label: `${adapter.name} entry`, value: tildeify(main) });
      } else if (main) {
        checks.push({
          status: "fail",
          label: `${adapter.name} entry`,
          value: `${tildeify(main)} ${c.red("(missing)")}`,
        });
      }
    }
    if (wiredCount === 0) {
      checks.push({
        status: "fail",
        label: "client wiring",
        value: c.red("no AI client has an entry — re-run `mh install`"),
      });
    }
  }

  if (kind === "agent") {
    const pkgPath = path.join(dest, "package.json");
    if (fs.existsSync(pkgPath)) {
      checks.push({ status: "ok", label: "package.json", value: tildeify(pkgPath) });
    } else {
      checks.push({
        status: "fail",
        label: "package.json",
        value: `${tildeify(pkgPath)} ${c.red("(missing)")}`,
      });
    }
  }

  const counted = checks.filter((x) => x.status !== "skip");
  const passed = counted.filter((x) => x.status === "ok").length;
  const total = counted.length;
  const failedCount = total - passed;

  if (json) {
    const payload = {
      ref: `${kind}s/${slug}`,
      installed: true,
      pinnedSha: local.publishedSha ?? null,
      passed,
      failed: failedCount,
      checks: checks.map((x) => ({
        status: x.status,
        label: x.label,
        // Strip ANSI from value to keep JSON clean — color codes
        // leaked from c.red()/c.dim() in the check messages above.
        // eslint-disable-next-line no-control-regex
        value: x.value.replace(/\x1b\[[0-9;]*m/g, ""),
      })),
    };
    console.log(JSON.stringify(payload, null, 2));
    return failedCount > 0 ? 1 : 0;
  }

  const trailing = `${passed} of ${total} checks ${passed === total ? "passed" : "passed · " + failedCount + " failed"}`;
  console.log(header("doctor", `${kind}/${slug}`, trailing));
  console.log();

  const labelW = Math.max(...checks.map((x) => x.label.length), 18);
  for (const x of checks) {
    const g =
      x.status === "ok"
        ? c.green(glyph.check)
        : x.status === "skip"
          ? c.dim(glyph.bullet)
          : c.red(glyph.cross);
    console.log(`  ${g} ${c.dim(x.label.padEnd(labelW))}  ${x.value}`);
  }

  console.log();
  console.log(`  ${c.dim("Pinned at")} ${c.cyan(local.publishedSha?.slice(0, 7) ?? "—")}`);

  // Surface a fix-it hint for the most common failure modes.
  const fails = checks.filter((x) => x.status === "fail");
  if (fails.length > 0) {
    console.log();
    console.log(`  ${c.yellow(glyph.warn)} ${c.bold("Recommended fixes")}`);
    if (fails.some((f) => /install dir|missing|won't find/i.test(f.value))) {
      console.log(
        `    ${c.dim(glyph.step)} mh uninstall ${kind}s/${slug}  &&  mh install ${kind}s/${slug}`,
      );
    }
    if (fails.some((f) => /sidecar|parse error/i.test(f.label + f.value))) {
      console.log(
        `    ${c.dim(glyph.step)} ${c.dim("Telemetry sidecar is regenerated on re-install.")}`,
      );
    }
    return 1;
  }
  return 0;
}
