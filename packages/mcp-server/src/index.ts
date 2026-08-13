/**
 * Entrypoint module. Exposes {@link run} which the bin wrapper calls
 * to boot the MCP server. Two transports are supported:
 *
 *   - `"stdio"` (default): one process per user via `npx`, local
 *     filesystem available, all tools registered.
 *   - `"http"`: streamable HTTP for the hosted `mcp.metahub.dev`
 *     endpoint or self-hosted nodes. Filesystem-only tools are
 *     omitted (see `server.ts`).
 *
 * Importing this module on its own has no side effects; only
 * `run()` opens a transport.
 */
import { runStdio } from "./transports/stdio.js";
import { runHttp, type RunHttpOptions } from "./transports/http.js";

export { buildServer, serverConfig } from "./server.js";
export type { ServerMode, BuildServerOptions } from "./server.js";
export { runStdio } from "./transports/stdio.js";
export { runHttp, startHttp } from "./transports/http.js";
export type { RunHttpOptions, RunningHttpServer } from "./transports/http.js";

export type Transport = "stdio" | "http";

export interface RunOptions {
  /** Which transport to start. Defaults to `"stdio"`. */
  transport?: Transport;
  /** Extra options passed through to the HTTP transport. Ignored for stdio. */
  http?: RunHttpOptions;
}

export async function run(opts: RunOptions = {}): Promise<void> {
  const transport: Transport = opts.transport ?? "stdio";
  if (transport === "http") {
    await runHttp(opts.http ?? {});
    return;
  }
  await runStdio();
}
