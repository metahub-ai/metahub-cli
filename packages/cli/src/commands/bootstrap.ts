/**
 * `mh bootstrap` — wire the bundled MetaHub MCP server into every
 *                  detected MCP-capable client. Idempotent.
 *
 *   `--status`     show whether MetaHub MCP is wired into each client
 *   `--force`      re-wire even if a `metahub` entry is already present
 *                  (use after a CLI upgrade when the bundled bin path
 *                  may have changed)
 *   `--uninstall`  remove the `metahub` entry from every client
 *
 * Default action (no flags): wire wherever it isn't already.
 *
 * The bootstrap step also runs automatically on first successful
 * `mh login` so the user doesn't have to remember it. Calling it
 * again is a no-op when everything's already in place.
 */
import { c, glyph, header, tildeify } from "../lib/ui.js";
import {
  bootstrapMetahubMcp,
  bootstrapStatus,
  findMetahubMcpBin,
  unbootstrap,
} from "../lib/bootstrap.js";

export async function bootstrap(args: string[]): Promise<number> {
  const status = args.includes("--status");
  const force = args.includes("--force");
  const uninstall = args.includes("--uninstall");

  if (uninstall) {
    unbootstrap();
    console.log(header("bootstrap", "uninstalled"));
    console.log();
    console.log(
      `  ${c.green(glyph.check)} Removed the ${c.bold("metahub")} MCP entry from every detected client.`,
    );
    console.log(`  ${c.dim("Re-run")} mh bootstrap ${c.dim("to wire it again.")}`);
    return 0;
  }

  if (status) {
    let bin: string;
    try {
      bin = findMetahubMcpBin();
    } catch (err) {
      console.error(`${c.red(glyph.cross)} ${(err as Error).message}`);
      return 1;
    }
    const rows = bootstrapStatus(bin);
    console.log(header("bootstrap status", "metahub MCP"));
    console.log();
    console.log(`  ${c.dim("Bundled MCP bin:")} ${tildeify(bin)}`);
    console.log();
    const w = Math.max(...rows.map((r) => r.client.length), 16);
    for (const r of rows) {
      let glyphCh: string;
      let label: string;
      switch (r.state) {
        case "wired":
          glyphCh = c.green(glyph.check);
          label = c.dim("wired");
          break;
        case "wired-elsewhere":
          glyphCh = c.yellow(glyph.warn);
          label = c.yellow("wired to a different path — run `mh bootstrap --force` to re-point");
          break;
        case "absent":
          glyphCh = c.dim(glyph.step);
          label = c.dim("not wired");
          break;
        case "not-detected":
          glyphCh = c.dim(glyph.bullet);
          label = c.dim("client not detected");
          break;
        case "manual":
          glyphCh = c.dim(glyph.bullet);
          label = c.dim("manual config (YAML/TOML/UI) — see `mh bootstrap`");
          break;
      }
      console.log(`  ${glyphCh} ${c.bold(r.client.padEnd(w))}  ${label}`);
    }
    return 0;
  }

  // Default: wire.
  console.log(header("bootstrap", "metahub MCP"));
  console.log();
  let result;
  try {
    result = bootstrapMetahubMcp({ force });
  } catch (err) {
    console.error(`${c.red(glyph.cross)} ${(err as Error).message}`);
    return 1;
  }
  console.log(`  ${c.dim("Bundled MCP bin:")} ${tildeify(result.bin)}`);
  console.log();

  const wrote = result.results.filter((r) => r.status === "wrote");
  const manual = result.results.filter((r) => r.status === "manual");

  if (wrote.length === 0 && manual.length === 0) {
    // Nothing to do — every detected client already had the entry.
    const detected = result.status.filter((s) => s.state === "wired");
    if (detected.length > 0) {
      console.log(
        `  ${c.green(glyph.check)} ${c.dim("Already wired into")} ${detected.length} ${c.dim("client" + (detected.length === 1 ? "" : "s") + " — nothing to do.")}`,
      );
      for (const d of detected) {
        console.log(
          `    ${c.green(glyph.check)} ${c.bold(d.client.padEnd(18))} ${c.dim(tildeify(d.configPath))}`,
        );
      }
    } else {
      console.log(`  ${c.yellow(glyph.warn)} No MCP-capable clients detected on this machine.`);
      console.log(
        `    ${c.dim("Install Claude Code, Cursor, Claude Desktop, or any other MCP client and re-run.")}`,
      );
    }
    return 0;
  }

  if (wrote.length > 0) {
    console.log(
      `  ${c.bold("Wired metahub into " + wrote.length + " client" + (wrote.length === 1 ? "" : "s"))}`,
    );
    for (const w of wrote) {
      console.log(
        `    ${c.green(glyph.check)} ${c.bold(w.client.padEnd(18))} ${c.dim(tildeify(w.configPath))}`,
      );
    }
  }
  if (manual.length > 0) {
    console.log();
    console.log(
      `  ${c.yellow(glyph.warn)} ${manual.length} client${manual.length === 1 ? "" : "s"} use${manual.length === 1 ? "s" : ""} a non-JSON config — paste the snippet into:`,
    );
    for (const m of manual) {
      console.log();
      console.log(`    ${c.bold(m.client)} ${c.dim(tildeify(m.configPath))}`);
      if (m.manualSnippet) {
        for (const line of m.manualSnippet.split("\n")) {
          console.log(`      ${c.dim(line)}`);
        }
      }
    }
  }
  console.log();
  console.log(
    `  ${c.dim("Now ask your AI:")} ${c.cyan('"install skills/pdf"')} ${c.dim("from any wired client.")}`,
  );
  return 0;
}
