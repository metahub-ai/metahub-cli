#!/usr/bin/env node
/**
 * Forwarding shim for the dev / tsc-built CLI layout. The standalone
 * bundler (scripts/build-standalone.mjs) replaces this with a shim
 * that imports from `../dist/mcp/server.js`. In dev we just delegate
 * to the workspace's @metahub/mcp-server package directly.
 */
import "@metahub/mcp-server/dist/cli.js";
