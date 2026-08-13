/**
 * `mh trace <kind>/<slug>` — push a single telemetry span for the
 * named install. Used by skill / plugin content that wants
 * observability but doesn't have a Node runtime of its own.
 *
 * The skill author includes the command in their SKILL.md (or in a
 * plugin's command script) so it fires every time the artifact runs.
 * The CLI looks up the install's ingest credentials from the local
 * installs.json and posts a span — no env-var plumbing required.
 *
 * Optional flags:
 *   --duration-ms <n>   how long the invocation took (default 0)
 *   --status ok|error   span status (default ok)
 *   --error <msg>       error message when --status=error
 *   --tool <name>       tool name to record (repeatable)
 *   --model <name>      model used for the invocation
 *   --host <name>       host that fired this (default mh-trace)
 */
import process from "node:process";
import type { ArtifactKind, SpanRow } from "@metahub/shared";
import { findInstall, listInstalls } from "@metahub/installer";
import { loadAuthConfig } from "@metahub/auth";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { parseRef } from "../lib/resolve-ref.js";
import { c, glyph, ms as fmtMs, refError } from "../lib/ui.js";

/**
 * One-shot JSON POST over node:http(s) with `agent: false`.
 * Deliberately NOT global fetch: undici's TLS handles race the
 * `process.exit(code)` in cli.ts on Windows and trip a libuv
 * assertion (win/async.c) after the span has already been recorded.
 * A keep-alive-free classic request tears down cleanly.
 */
function postJson(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ ok: boolean; status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === "https:" ? httpsRequest : httpRequest)(
      u,
      { method: "POST", headers, agent: false },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          resolve({ ok: status >= 200 && status < 300, status, text });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

interface ParsedFlags {
  durationMs: number;
  status: "ok" | "error";
  errorMessage: string | null;
  tools: string[];
  model: string | null;
  host: string;
  /**
   * Legacy flag — used to gate the success line. The success line now
   * prints by default; this stays as a no-op alias so existing
   * SKILL.md scripts that pass --verbose don't break.
   */
  verbose: boolean;
  /**
   * Suppress the default success line for SKILL.md authors who insist
   * on zero stdout/stderr noise.
   */
  quiet: boolean;
  /**
   * Don't POST the span — print the payload + redacted Authorization
   * header to stdout for offline inspection. Mirrors the secrets-
   * hygiene posture: the API key is shown as first-8 + ellipsis.
   */
  dryRun: boolean;
}

function parseFlags(rest: string[]): ParsedFlags {
  const out: ParsedFlags = {
    durationMs: 0,
    status: "ok",
    errorMessage: null,
    tools: [],
    model: null,
    host: "mh-trace",
    verbose: process.env.METAHUB_TRACE_VERBOSE === "1",
    quiet: false,
    dryRun: false,
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const next = (): string => rest[++i] ?? "";
    switch (a) {
      case "--duration-ms": {
        const n = Number(next());
        if (Number.isFinite(n) && n >= 0) out.durationMs = n;
        break;
      }
      case "--status": {
        const v = next();
        if (v === "ok" || v === "error") out.status = v;
        break;
      }
      case "--error":
        out.errorMessage = next();
        break;
      case "--tool":
        out.tools.push(next());
        break;
      case "--model":
        out.model = next();
        break;
      case "--host":
        out.host = next();
        break;
      case "--verbose":
        out.verbose = true;
        break;
      case "--quiet":
      case "-q":
        out.quiet = true;
        break;
      case "--dry-run":
        out.dryRun = true;
        break;
    }
  }
  return out;
}

/**
 * Redact an ingest API key to its first 8 chars + ellipsis. Used by
 * `--dry-run` output so users can spot-check which install the trace
 * would post to without leaking the bearer in shell history / logs.
 */
function redactKey(key: string): string {
  if (!key) return "<missing>";
  return `${key.slice(0, 8)}…<redacted>`;
}

export async function trace(arg: string, rest: string[]): Promise<number> {
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
    // Bare slug — resolve from the local install ledger, same policy
    // as uninstall: one match proceeds, ambiguity errors.
    slug = parsed.bareSlug;
    const matches = listInstalls().filter((i) => i.slug === slug);
    if (matches.length === 0) {
      console.error(`${c.red(glyph.cross)} Not installed: ${slug}.`);
      console.error(`  ${c.dim("Run")} mh install ${slug} ${c.dim("first.")}`);
      return 1;
    }
    if (matches.length > 1) {
      console.error(
        `${c.red(glyph.cross)} ${c.bold(slug)} is installed as more than one kind — pick one:`,
      );
      for (const i of matches) console.error(`    mh trace ${i.kind}s/${i.slug}`);
      return 2;
    }
    kind = matches[0]!.kind;
  }

  const local = findInstall(kind, slug);
  if (!local) {
    console.error(`${c.red(glyph.cross)} Not installed: ${kind}/${slug}.`);
    console.error(`  ${c.dim("Run")} mh install ${kind}s/${slug} ${c.dim("first.")}`);
    return 1;
  }

  const flags = parseFlags(rest);
  const cfg = loadAuthConfig();
  const now = Date.now();
  const startMs = now - flags.durationMs;
  const span: SpanRow = {
    spanId: `spn_${randomBytes(12).toString("hex")}`,
    artifactId: local.artifactId,
    artifactSlug: slug,
    artifactKind: kind,
    version: local.version,
    installId: local.installId,
    host: flags.host,
    startMs,
    endMs: now,
    durationMs: flags.durationMs,
    status: flags.status,
    errorMessage: flags.errorMessage,
    model: flags.model,
    tools: flags.tools,
    handoffTo: null,
  };

  const url = `${cfg.portalUrl.replace(/\/$/, "")}/api/ingest`;

  if (flags.dryRun) {
    // No POST — emit the would-be payload + redacted Authorization
    // header to stdout. Useful for offline inspection and CI smoke.
    // The first-8-chars redaction matches the secrets-hygiene
    // posture in the MCP P0-2 finding.
    console.log(JSON.stringify({ spans: [span] }, null, 2));
    console.log();
    console.log(`POST ${url}`);
    console.log(`Authorization: Bearer ${redactKey(local.ingestApiKey)}`);
    return 0;
  }

  const res = await postJson(
    url,
    {
      Authorization: `Bearer ${local.ingestApiKey}`,
      "Content-Type": "application/json",
    },
    JSON.stringify({ spans: [span] }),
  ).catch((err) => {
    console.error(`trace failed: ${(err as Error).message}`);
    return null;
  });

  if (!res) return 1;
  if (!res.ok) {
    console.error(
      `${c.red(glyph.cross)} trace rejected: HTTP ${res.status} ${c.dim(res.text.slice(0, 200))}`,
    );
    return 1;
  }
  if (!flags.quiet) {
    // Default success line — printed to stderr so SKILL.md callers
    // that grep / pipe stdout aren't surprised by extra output. The
    // span-id prefix is dimmed so the eye lands on the kind/slug.
    const idShort = span.spanId.slice(0, 12);
    console.error(
      `${c.green(glyph.check)} ${c.dim("recorded " + idShort)} ${c.dim("●")} ${c.bold(kind + "/" + slug)}  ${c.dim(fmtMs(flags.durationMs))}`,
    );
  }
  return 0;
}
