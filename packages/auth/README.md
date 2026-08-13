# @metahub/auth

Auth machinery shared between the MetaHub CLI ([`@metahub/cli`](../cli/README.md)) and the MetaHub MCP server ([`@metahub/mcp-server`](../mcp-server/README.md)). Owns:

- Persisted-token storage at `~/.metahub/config.json` (read, write, clear)
- The GitHub device-code flow against the portal (`startDeviceCodeFlow`, `pollDeviceCode`)
- Auth-only portal calls (`currentUser`, bearer resolution)

The package is silent: no `console.log`. Consumers wrap it with terminal UI, MCP responses, or whatever surface they need.

## Install

```bash
npm install @metahub/auth
```

You probably don't need to depend on it directly: it's an internal library consumed by `@metahub/cli` and `@metahub/mcp-server`. Both surfaces ship pre-wired to it.

## Public API

```ts
import {
  startDeviceCodeFlow,
  pollDeviceCode,
  persistToken,
  readPersistedToken,
  clearPersistedToken,
  refreshUserHandle,
  resolveBearer,
  currentUser,
  loadAuthConfig,
  saveAuthConfig,
  configRoot,
  configFile,
  type DeviceCodeStart,
  type DeviceCodeStatus,
  type AuthToken,
  type AuthConfig,
} from "@metahub/auth";
```

Typical flow:

```ts
const start = await startDeviceCodeFlow();
// surface `start.verificationUrl` + `start.userCode` to the user
const status = await pollDeviceCode(start.deviceCode);
// on `status.state === "complete"`, the token is already persisted to disk
```

`pollDeviceCode` writes the session token to `~/.metahub/config.json` on success. `readPersistedToken` returns it for subsequent requests; `clearPersistedToken` removes it (used by `mh logout` and `metahub_signout`).

## Consumers

- [`@metahub/cli`](../cli/README.md): `mh login` and the bearer-token reader on every authenticated command.
- [`@metahub/mcp-server`](../mcp-server/README.md): `metahub_signin_begin` / `metahub_signin_complete` split the device-code flow across two tool calls (MCP needs the verification URL surfaced to the AI before polling blocks). `metahub_signout`, `metahub_whoami` use `clearPersistedToken` / `readPersistedToken`. Lazy-auth tools call `resolveBearer` and prompt the user to sign in when it returns `null`.

Both surfaces share the on-disk token, so a `mh login` session lights up the MCP server's authenticated tools (and vice versa) without re-signing in.

## Boundaries

- Depends on [`@metahub/shared`](../shared/README.md) for wire-format types.
- No `console.log` or terminal UI dependencies of its own.

## Roadmap

The current device-code flow targets `/api/auth/github/start` and `/api/auth/github/poll` on the portal: the same endpoints the CLI has always used. A true headless device-code flow (no browser tab on the user's machine) will need new portal endpoints; see the `TODO` comments in `src/device-code.ts`.
