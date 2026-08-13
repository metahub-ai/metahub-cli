/**
 * HTTP transport boot. Uses the MCP SDK's
 * {@link StreamableHTTPServerTransport} (the current streamable HTTP
 * spec — see `docs/MCP_SERVER.md`), which speaks the streamable HTTP
 * profile of MCP and falls back to JSON for non-streaming clients.
 * The older SSE transport (`@modelcontextprotocol/sdk/server/sse.js`)
 * is deprecated and not used here.
 *
 * The transport runs in stateless mode (no session ID). The SDK
 * forbids reusing a stateless transport across requests (it tracks
 * `_hasHandledRequest` and throws on the second call), so this
 * module spins up a fresh `McpServer` + `StreamableHTTPServerTransport`
 * pair per inbound HTTP request and tears them down on response
 * close. There is no per-tenant state to keep on the hosted node,
 * which matches the catalog-read workload — every tool call already
 * fetches the registry fresh; sessions would only complicate
 * horizontal scaling without buying anything.
 *
 * A `GET /healthz` route returns 200 with a small JSON payload for
 * uptime probes (Railway, Render, Vercel, etc. all expect one).
 *
 * The HTTP server is intended for the hosted `mcp.metahub.dev`
 * deployment. Self-hosters embed it programmatically via
 * `run({ transport: "http", http: { port, host } })` (see index.ts); the
 * `metahub-mcp` CLI binary itself only serves stdio.
 */
import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer, serverConfig } from "../server.js";

export interface RunHttpOptions {
  /** Port to listen on. Defaults to env `PORT` or 3030. */
  port?: number;
  /** Host to bind. Defaults to env `HOST` or `0.0.0.0` for hosted. */
  host?: string;
}

export interface RunningHttpServer {
  /** The underlying Node HTTP server (exposed for tests). */
  server: http.Server;
  /** Actual port the server is listening on (resolves "port 0"). */
  port: number;
  /** Shut down the HTTP server cleanly. */
  close(): Promise<void>;
}

// Permissive CORS for now — the hosted MCP endpoint is read-only over
// the catalog and is called by an open set of web clients and
// server-side tools. We can lock this down later if a specific abuse
// pattern shows up; document the choice in the PR if you change it.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Mcp-Session-Id, Authorization",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

function applyCors(res: http.ServerResponse): void {
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    res.setHeader(k, v);
  }
}

function resolvePort(opts: RunHttpOptions): number {
  if (typeof opts.port === "number") return opts.port;
  const fromEnv = process.env.PORT;
  if (fromEnv && fromEnv.length > 0) {
    const parsed = Number.parseInt(fromEnv, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 3030;
}

function resolveHost(opts: RunHttpOptions): string {
  return opts.host ?? process.env.HOST ?? "0.0.0.0";
}

async function handleMcpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  // Stateless: build a fresh server + transport per request. The SDK
  // throws "Stateless transport cannot be reused across requests"
  // otherwise, since each transport instance is single-shot when
  // sessionIdGenerator is undefined.
  const server = buildServer({ mode: "http" });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } finally {
    res.on("close", () => {
      transport.close().catch(() => {
        // Already closed; swallow.
      });
      server.close().catch(() => {
        // Already closed; swallow.
      });
    });
  }
}

export async function startHttp(opts: RunHttpOptions = {}): Promise<RunningHttpServer> {
  const cfg = serverConfig();

  const httpServer = http.createServer((req, res) => {
    applyCors(res);
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    const url = req.url ?? "/";
    if (req.method === "GET" && (url === "/healthz" || url.startsWith("/healthz?"))) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ status: "ok", name: cfg.name, version: cfg.version }));
      return;
    }
    // Everything else is MCP traffic. The SDK transport handles
    // POST (JSON-RPC), GET (SSE stream), and DELETE (session close).
    handleMcpRequest(req, res).catch((err: unknown) => {
      process.stderr.write(
        `[metahub-mcp] http handler error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "internal_error" }));
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });

  const desiredPort = resolvePort(opts);
  const desiredHost = resolveHost(opts);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      httpServer.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      httpServer.removeListener("error", onError);
      resolve();
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(desiredPort, desiredHost);
  });

  const address = httpServer.address();
  const port =
    typeof address === "object" && address && "port" in address ? address.port : desiredPort;

  process.stderr.write(
    `[metahub-mcp] ${cfg.name} v${cfg.version} ready over http on ${desiredHost}:${port} (registry: ${cfg.registryUrl})\n`,
  );

  return {
    server: httpServer,
    port,
    async close() {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}

export async function runHttp(opts: RunHttpOptions = {}): Promise<void> {
  const running = await startHttp(opts);

  const shutdown = (signal: NodeJS.Signals) => {
    process.stderr.write(`[metahub-mcp] received ${signal}, shutting down\n`);
    running
      .close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        process.stderr.write(
          `[metahub-mcp] shutdown error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      });
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
