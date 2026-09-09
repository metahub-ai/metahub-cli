/**
 * `mh bootstrap` — wire the bundled MetaHub MCP server into every
 *                  detected MCP-capable client, and tell every detected
 *                  harness to consult MetaHub. Idempotent.
 *
 *   `--status`          show what is wired where, and which instruction
 *                       files carry the MetaHub block
 *   `--force`           re-wire even if a `metahub` entry is already present
 *                       (use after a CLI upgrade when the bundled bin path
 *                       may have changed)
 *   `--instructions`    only (re)write the instruction blocks
 *   `--no-instructions` wire the MCP server but leave instruction files alone
 *                       (METAHUB_NO_INSTRUCTIONS=1 does the same)
 *   `--uninstall`       remove the `metahub` entry and the instruction block
 *                       from every client
 *
 * Default action (no flags): wire wherever it isn't already, and write
 * the instruction blocks.
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
  instructionsEnabledByEnv,
  isNpxCachePath,
  unbootstrap,
} from "../lib/bootstrap.js";
import {
  instructionStatus,
  writeInstructionBlocks,
  type InstructionWriteResult,
} from "../lib/instructions.js";

export const EXAMPLE_PROMPT = '"install skills/keynote-deck"';

function renderInstructions(rows: InstructionWriteResult[]): void {
  const wrote = rows.filter((r) => r.status === "wrote" || r.status === "updated");
  const current = rows.filter((r) => r.status === "current");
  const skippedLarge = rows.filter((r) => r.status === "skipped-too-large");
  const errored = rows.filter((r) => r.status === "error");
  if (wrote.length + current.length + skippedLarge.length + errored.length === 0) {
    console.log(`  ${c.dim("No harness instruction files detected — nothing to tell.")}`);
    return;
  }
  const w = Math.max(...rows.map((r) => r.label.length), 16);
  if (wrote.length > 0) {
    console.log(
      `  ${c.bold("Told " + wrote.length + " harness" + (wrote.length === 1 ? "" : "es") + " to look on MetaHub first")}`,
    );
    for (const r of wrote) {
      console.log(
        `    ${c.green(glyph.check)} ${c.bold(r.label.padEnd(w))}  ${c.dim(tildeify(r.file))}${r.status === "updated" ? c.dim("  (updated)") : ""}`,
      );
    }
  }
  if (current.length > 0) {
    if (wrote.length === 0) {
      console.log(
        `  ${c.green(glyph.check)} ${c.dim("Instruction block already current in")} ${current.length} ${c.dim("file" + (current.length === 1 ? "" : "s"))}`,
      );
    }
    for (const r of current) {
      console.log(
        `    ${c.dim(glyph.check)} ${c.dim(r.label.padEnd(w))}  ${c.dim(tildeify(r.file))}`,
      );
    }
  }
  for (const r of skippedLarge) {
    console.log(
      `    ${c.yellow(glyph.warn)} ${c.bold(r.label.padEnd(w))}  ${c.dim(tildeify(r.file) + " is at its size limit — add the block by hand")}`,
    );
  }
  for (const r of errored) {
    console.log(
      `    ${c.red(glyph.cross)} ${c.bold(r.label.padEnd(w))}  ${c.dim(tildeify(r.file) + ": " + (r.error ?? "error"))}`,
    );
  }
  console.log(
    `  ${c.dim("Remove with")} mh bootstrap --uninstall${c.dim(", or skip next time with")} --no-instructions`,
  );
}

export async function bootstrap(args: string[]): Promise<number> {
  const status = args.includes("--status");
  const force = args.includes("--force");
  const uninstall = args.includes("--uninstall");
  const onlyInstructions = args.includes("--instructions");
  const noInstructions = args.includes("--no-instructions");

  if (uninstall) {
    const removed = unbootstrap();
    console.log(header("bootstrap", "uninstalled"));
    console.log();
    console.log(
      `  ${c.green(glyph.check)} Removed the ${c.bold("metahub")} MCP entry from every detected client.`,
    );
    const gone = removed.filter((r) => r.status === "removed");
    if (gone.length > 0) {
      console.log(
        `  ${c.green(glyph.check)} Removed the MetaHub block from ${gone.length} instruction file${gone.length === 1 ? "" : "s"}:`,
      );
      for (const r of gone) console.log(`    ${c.dim(glyph.step)} ${c.dim(tildeify(r.file))}`);
    }
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
    if (isNpxCachePath(bin)) {
      console.log(
        `  ${c.dim("Running from the npx cache — clients are wired to")} npx -y --package=@metahub-ai/mh metahub-mcp`,
      );
    }
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
          label = c.dim("manual config (YAML/UI) — see `mh bootstrap`");
          break;
      }
      console.log(`  ${glyphCh} ${c.bold(r.client.padEnd(w))}  ${label}`);
    }
    console.log();
    console.log(`  ${c.dim("Instruction files:")}`);
    const irows = instructionStatus();
    const iw = Math.max(...irows.map((r) => r.label.length), 16);
    for (const r of irows) {
      let glyphCh: string;
      let label: string;
      switch (r.state) {
        case "present":
          glyphCh = c.green(glyph.check);
          label = c.dim(tildeify(r.file));
          break;
        case "stale":
          glyphCh = c.yellow(glyph.warn);
          label = c.yellow(tildeify(r.file) + " — older block, run `mh bootstrap` to refresh");
          break;
        case "absent":
          glyphCh = c.dim(glyph.step);
          label = c.dim("no MetaHub block in " + tildeify(r.file));
          break;
        case "not-detected":
          glyphCh = c.dim(glyph.bullet);
          label = c.dim("harness not detected");
          break;
      }
      console.log(`  ${glyphCh} ${c.bold(r.label.padEnd(iw))}  ${label}`);
    }
    return 0;
  }

  if (onlyInstructions) {
    console.log(header("bootstrap", "instructions"));
    console.log();
    renderInstructions(writeInstructionBlocks());
    return 0;
  }

  // Default: wire.
  console.log(header("bootstrap", "metahub MCP"));
  console.log();
  let result;
  try {
    result = bootstrapMetahubMcp({
      force,
      instructions: noInstructions ? false : instructionsEnabledByEnv(),
    });
  } catch (err) {
    console.error(`${c.red(glyph.cross)} ${(err as Error).message}`);
    return 1;
  }
  console.log(`  ${c.dim("Bundled MCP bin:")} ${tildeify(result.bin)}`);
  if (result.launch.command === "npx") {
    console.log(
      `  ${c.dim("Running from the npx cache, so clients get")} ${c.cyan("npx -y --package=@metahub-ai/mh metahub-mcp")}`,
    );
    console.log(
      `  ${c.dim("For an instant start install globally:")} ${c.cyan("npm install -g @metahub-ai/mh")}`,
    );
  }
  console.log();

  const wrote = result.results.filter((r) => r.status === "wrote");
  const manual = result.results.filter((r) => r.status === "manual");
  const skipped = result.results.filter((r) => r.status === "skipped");

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
        `    ${c.dim("Install Claude Code, Cursor, Codex, Gemini CLI, or any other MCP client and re-run.")}`,
      );
    }
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
  for (const s of skipped) {
    console.log(
      `    ${c.yellow(glyph.warn)} ${c.bold(s.client.padEnd(18))} ${c.yellow(s.warning ?? "skipped")}`,
    );
  }
  if (manual.length > 0) {
    console.log();
    console.log(
      `  ${c.yellow(glyph.warn)} ${manual.length} client${manual.length === 1 ? "" : "s"} use${manual.length === 1 ? "s" : ""} a config mh cannot edit — paste the snippet into:`,
    );
    for (const m of manual) {
      console.log();
      console.log(`    ${c.bold(m.client)} ${c.dim(tildeify(m.configPath))}`);
      if (m.warning) console.log(`      ${c.yellow(m.warning)}`);
      if (m.manualSnippet) {
        for (const line of m.manualSnippet.split("\n")) {
          console.log(`      ${c.dim(line)}`);
        }
      }
    }
  }

  console.log();
  if (result.instructions.length > 0) {
    renderInstructions(result.instructions);
  } else {
    console.log(
      `  ${c.dim("Instruction files left alone (--no-instructions / METAHUB_NO_INSTRUCTIONS=1).")}`,
    );
  }
  console.log();
  console.log(
    `  ${c.dim("Now ask your AI:")} ${c.cyan(EXAMPLE_PROMPT)} ${c.dim("from any wired client.")}`,
  );
  return 0;
}
