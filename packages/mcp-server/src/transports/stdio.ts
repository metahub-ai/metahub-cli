/**
 * Stdio transport boot. Pure side-effect entrypoint — opens stdin /
 * stdout for MCP JSON-RPC frames and logs readiness to stderr (never
 * stdout, which would corrupt the frame stream the host AI parses).
 *
 * This is the default transport for the `npx -y @metahub/mcp-server`
 * install path: one process per user, running on the user's own
 * machine, with full access to `~/.metahub/`.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer, serverConfig } from "../server.js";

export async function runStdio(): Promise<void> {
  const server = buildServer({ mode: "stdio" });
  const transport = new StdioServerTransport();
  const cfg = serverConfig();
  process.stderr.write(
    `[metahub-mcp] ${cfg.name} v${cfg.version} ready over stdio (registry: ${cfg.registryUrl})\n`,
  );
  await server.connect(transport);
}
