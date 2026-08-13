/**
 * mh — the MetaHub CLI.
 *
 *   mh install   <kind>/<slug>     install or re-install an artifact
 *   mh uninstall <kind>/<slug>     remove an installed artifact + its hook
 *   mh update    <kind>/<slug>     re-fetch the latest published SHA
 *   mh update    --all             update every install
 *   mh outdated                    show installs with newer versions
 *   mh list                        show installed artifacts
 *   mh search    <query>           search the catalog
 *   mh show      <kind>/<slug>     show artifact details without installing
 *   mh doctor    <kind>/<slug>     sanity-check a local install
 *   mh login                       sign in to the portal (GitHub Device Flow)
 *   mh config [list|get|set …]     manage local preferences (telemetry, urls)
 *   mh --help                      this message
 *   mh --version                   print version
 */
import { install } from "./commands/install.js";
import { uninstall } from "./commands/uninstall.js";
import { update } from "./commands/update.js";
import { outdated } from "./commands/outdated.js";
import { list } from "./commands/list.js";
import { search } from "./commands/search.js";
import { show } from "./commands/show.js";
import { doctor } from "./commands/doctor.js";
import { login } from "./commands/login.js";
import { logout } from "./commands/logout.js";
import { whoami } from "./commands/whoami.js";
import { config } from "./commands/config.js";
import { trace } from "./commands/trace.js";
import { refresh } from "./commands/refresh.js";
import { bootstrap } from "./commands/bootstrap.js";
import { upgrade } from "./commands/upgrade.js";
import { cliVersion } from "./lib/version.js";
import { c, glyph, usageError } from "./lib/ui.js";
import { loadAuthConfig } from "@metahub/auth";

/**
 * Render the help text. Sections in accent, command names in bold,
 * descriptions in default. Footer shows workflow + docs URL.
 *
 * Built lazily (called at help-print time, not module load) so the
 * colorMode() helper resolves against the right env each invocation.
 */
function helpText(): string {
  const sec = (s: string) => c.accent(s);
  const cmd = (s: string) => c.bold(s.padEnd(12));
  const arg = (s: string) => c.dim(s.padEnd(16));
  const line = (name: string, args: string, desc: string) => `    ${cmd(name)}${arg(args)}${desc}`;
  return [
    `${c.accent("[mh]")}  ${c.bold("the metahub CLI")} ${c.dim("· " + cliVersion())}`,
    "",
    `  ${sec("USE")}`,
    line("install", "<kind>/<slug>", "install an artifact"),
    line("uninstall", "<kind>/<slug>", "remove an installed artifact"),
    line("update", "<kind>/<slug>", "re-fetch latest published SHA  (or --all)"),
    line("list", "", "show installed artifacts"),
    line("outdated", "", "list installs with newer versions"),
    line("doctor", "<kind>/<slug>", "sanity-check a local install"),
    line("refresh", "", "re-wire installed artifacts into any newly-installed AI clients"),
    line("bootstrap", "[--status]", "wire the bundled MetaHub MCP into every detected client"),
    line("upgrade", "", "re-install the CLI itself"),
    "",
    `  ${sec("DISCOVER")}`,
    line("search", "<query>", "search the catalog"),
    line("show", "<kind>/<slug>", "show artifact details without installing"),
    "",
    `  ${sec("OBSERVE")}`,
    line("trace", "<kind>/<slug>", "push one telemetry span  [--dry-run, --quiet]"),
    "",
    `  ${sec("ACCOUNT")}`,
    line("login", "", "sign in via GitHub Device Flow"),
    line("logout", "", "clear the persisted session token"),
    line("whoami", "", "show the signed-in MetaHub user"),
    line("config", "[list|get|set]", "manage local preferences"),
    "",
    `  ${c.dim("Workflow:")} mh search ${c.dim("<q>")} ${glyph.arrow} mh install ${c.dim("<ref>")} ${glyph.arrow} mh trace ${c.dim("flows automatically")}`,
    `  ${c.dim("Docs:    ")} ${c.cyan("https://developer.metahub.ai/docs")}`,
    "",
  ].join("\n");
}

/**
 * `mh --version`. Compact line for scripts; a dim second-half shows
 * the configured registry so the user can tell at a glance whether
 * the CLI is pointing at production or a self-host.
 */
function printVersion(): void {
  const cfg = loadAuthConfig();
  const reg = (cfg.registryUrl || "").replace(/^https?:\/\//, "");
  console.log(`${c.accent("mh")} ${cliVersion()}${reg ? "  " + c.dim("· " + reg) : ""}`);
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(helpText());
    return 0;
  }
  if (cmd === "--version" || cmd === "-v") {
    printVersion();
    return 0;
  }
  try {
    switch (cmd) {
      case "install":
        if (!rest[0]) {
          console.error(usageError("install", "mh install <kind>/<slug>"));
          return 2;
        }
        return await install(rest[0]);
      case "uninstall":
      case "remove":
      case "rm":
        if (!rest[0]) {
          console.error(usageError("uninstall", "mh uninstall <kind>/<slug>"));
          return 2;
        }
        return await uninstall(rest[0]);
      case "update":
        if (!rest[0]) {
          console.error(usageError("update", "mh update <kind>/<slug>  |  mh update --all"));
          return 2;
        }
        return await update(rest[0]);
      case "upgrade":
      case "self-update":
        return await upgrade();
      case "outdated":
        return await outdated(rest);
      case "refresh":
      case "rewire":
        return await refresh();
      case "bootstrap":
        return await bootstrap(rest);
      case "list":
      case "ls":
        return await list(rest);
      case "search":
      case "find":
        if (!rest[0]) {
          console.error(
            usageError(
              "search",
              "mh search [--kind=skill|mcp|agent|plugin] [--sort=best|installs|rating|trending|updated|newest] [--limit=N] [--json] <query>",
            ),
          );
          return 2;
        }
        return await search(rest.join(" "));
      case "show":
      case "info":
        if (!rest[0]) {
          console.error(usageError("show", "mh show <kind>/<slug> [--json]"));
          return 2;
        }
        return await show(rest[0], rest.slice(1));
      case "doctor":
      case "check":
        if (!rest[0]) {
          console.error(usageError("doctor", "mh doctor <kind>/<slug> [--json]"));
          return 2;
        }
        return await doctor(rest[0], rest.slice(1));
      case "login":
        return await login();
      case "logout":
        return await logout();
      case "whoami":
        return await whoami();
      case "config":
        return await config(rest);
      case "trace":
        if (!rest[0]) {
          console.error(
            usageError(
              "trace",
              "mh trace <kind>/<slug> [--duration-ms N] [--status ok|error] [--tool T] [--model M] [--host H] [--quiet] [--dry-run]",
            ),
          );
          return 2;
        }
        return await trace(rest[0], rest.slice(1));
      default:
        console.error(`Unknown command: ${cmd}`);
        console.log(helpText());
        return 2;
    }
  } catch (err) {
    console.error(`mh: ${(err as Error).message}`);
    return 1;
  }
}

main(process.argv.slice(2)).then((code) => {
  // Prefer a natural exit: a hard process.exit() races undici's TLS
  // teardown on Windows and trips a libuv assertion (win/async.c)
  // after any command that fetched over HTTPS (search, outdated, …).
  // Idle sockets are unref'd, so the loop normally drains instantly.
  // The unref'd timer is a hang backstop only: it can't keep the
  // process alive itself, but if some stray handle does, it forces
  // the exit two seconds after completion — long past the teardown
  // window the assertion lives in.
  process.exitCode = code;
  setTimeout(() => process.exit(code), 2000).unref();
});
