/**
 * Bin entrypoint. The shebang wrapper in `bin/metahub-mcp.js`
 * imports this module; importing it parses argv and either prints a
 * one-line response (`--version`, `--help`) or boots the server.
 *
 * Process-level error handlers catch anything that escapes the
 * SDK — an unhandled rejection inside a tool handler that bubbles
 * past the transport would otherwise crash with the default Node
 * printer, whose output the host AI may misinterpret as garbage on
 * the stdio channel.
 */
import { run } from "./index.js";
import { serverConfig } from "./server.js";

const HELP_TEXT = `metahub-mcp — MetaHub MCP server

Usage:
  metahub-mcp                Boot the MCP server over stdio (default).
  metahub-mcp --version      Print the server version and exit.
  metahub-mcp -h, --help     Show this help and exit.

Tool registration and end-user integration: see docs/MCP_SERVER.md.
`;

process.on("unhandledRejection", (reason) => {
  process.stderr.write(
    `[metahub-mcp] unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`,
  );
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  process.stderr.write(`[metahub-mcp] uncaughtException: ${err.stack ?? err.message}\n`);
  process.exit(1);
});

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  process.stdout.write(HELP_TEXT);
  process.exit(0);
}
if (args.includes("--version") || args.includes("-V")) {
  const cfg = serverConfig();
  process.stdout.write(`${cfg.name} ${cfg.version}\n`);
  process.exit(0);
}

run().catch((err: unknown) => {
  process.stderr.write(
    `[metahub-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
