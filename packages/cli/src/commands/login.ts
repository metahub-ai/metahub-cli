/**
 * `mh login` — thin CLI wrapper over @metahub/auth's device-code flow.
 * The library handles the portal handshake + token persistence; this
 * command owns the printed instructions, the device code in a box, a
 * spinner during the poll, and the success banner.
 */
import { currentUser, pollDeviceCode, startDeviceCodeFlow } from "@metahub/auth";
import { box, c, glyph, header, link, spinner } from "../lib/ui.js";
import { bootstrapMetahubMcp } from "../lib/bootstrap.js";
import { tildeify } from "../lib/ui.js";

export async function login(): Promise<number> {
  console.log(header("login", "GitHub device flow"));
  console.log();
  const start = await startDeviceCodeFlow();
  console.log(
    `  1. Open  ${c.cyan(link(start.verificationUrl, start.verificationUrl))}  ${c.dim("(Cmd/Ctrl+click to follow)")}`,
  );
  console.log(`  2. Enter`);
  console.log();
  const code = box(c.bold(start.userCode));
  for (const line of code.split("\n")) console.log("            " + line);
  console.log();

  const startedAt = Date.now();
  const spin = spinner("Waiting for you to confirm in GitHub…");
  let interval = start.interval;
  const renderElapsed = () => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    const mm = Math.floor(s / 60)
      .toString()
      .padStart(1, "0");
    const ss = (s % 60).toString().padStart(2, "0");
    spin.update(`Waiting for you to confirm in GitHub…  ${c.dim(`elapsed ${mm}:${ss}`)}`);
  };
  const timer = setInterval(renderElapsed, 1000);

  try {
    while (true) {
      await new Promise((r) => setTimeout(r, Math.max(interval, 1) * 1000));
      const result = await pollDeviceCode(start.deviceCode);
      if (result.state === "complete") {
        const me = await currentUser(result.token.token);
        spin.stop(`${c.green(glyph.check)} Signed in as ${c.bold("@" + me.user.githubLogin)}`);
        console.log(`  ${c.dim("Session cached at")} ~/.metahub/config.json`);
        // First-run bootstrap: wire the bundled MetaHub MCP into every
        // detected client so the user can immediately ask their AI to
        // search / install artifacts. Idempotent — if already wired,
        // prints "already current" and returns. Never fatal for login.
        runBootstrapBanner();
        return 0;
      }
      if (result.state === "denied") {
        spin.stop(`${c.red(glyph.cross)} Sign-in denied.`);
        return 2;
      }
      if (result.state === "expired") {
        spin.stop(`${c.red(glyph.cross)} Sign-in expired. Run \`mh login\` again.`);
        return 2;
      }
      interval = result.interval || interval;
    }
  } finally {
    clearInterval(timer);
  }
}

/**
 * Print a short "MetaHub MCP wired into N clients" banner after a
 * successful sign-in. Idempotent — only wires where the entry is
 * missing. Swallows all errors: failing to bootstrap the MCP should
 * never break login.
 */
function runBootstrapBanner(): void {
  try {
    const result = bootstrapMetahubMcp({ force: false });
    const wrote = result.results.filter((r) => r.status === "wrote");
    const alreadyWired = result.status.filter((s) => s.state === "wired");
    if (wrote.length === 0 && alreadyWired.length === 0) {
      // Nothing to print — no MCP-capable clients detected.
      return;
    }
    console.log();
    if (wrote.length > 0) {
      console.log(
        `  ${c.bold("MetaHub MCP")} ${c.dim("wired into")} ${wrote.length} ${c.dim("client" + (wrote.length === 1 ? "" : "s") + ":")}`,
      );
      for (const w of wrote) {
        console.log(
          `    ${c.green(glyph.check)} ${c.bold(w.client.padEnd(18))} ${c.dim(tildeify(w.configPath))}`,
        );
      }
      console.log();
      console.log(
        `  ${c.dim("Try:")} ${c.cyan("ask your AI")} ${c.dim('"install skills/pdf"')} ${c.dim("— it'll do it.")}`,
      );
    } else if (alreadyWired.length > 0) {
      console.log(
        `  ${c.dim("MetaHub MCP already wired into")} ${alreadyWired.length} ${c.dim("client" + (alreadyWired.length === 1 ? "" : "s") + " — nothing to do.")}`,
      );
    }
  } catch {
    /* never let bootstrap break login */
  }
}
