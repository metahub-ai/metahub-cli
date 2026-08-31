# @metahub/installer

Install machinery shared between the MetaHub CLI ([`@metahub-ai/mh`](../cli/README.md)) and the MetaHub MCP server ([`@metahub/mcp-server`](../mcp-server/README.md)). Owns:

- Download + extract artifact tarballs (`fetchAndExtractTarball`, `extractLocalTarball`)
- Multi-client MCP wiring (`CLIENT_ADAPTERS`, `wireMcpAcrossClients`, `unwireMcpAcrossClients`)
- Post-install hooks (`wireHook`, `unwireHook`: sidecar + MCP config edits)
- The local install ledger at `~/.metahub/installs.json` (`listInstalls`, `recordInstall`, `removeInstall`, `findInstall`)
- A typed portal client for catalog reads (`getInstallInfo`, `getPublicArtifact`, `listPublicArtifacts`)
- High-level orchestration (`installArtifact`, `uninstallArtifact`, `listInstalled`)

The package is silent: no `console.log`. Pass an `onProgress` callback to `installArtifact` to surface stage transitions to a user. The CLI uses this to render progress lines; the MCP server uses it to stream MCP progress notifications.

## Install

```bash
npm install @metahub/installer
```

You probably don't need to depend on it directly: it's an internal library consumed by `@metahub-ai/mh` and `@metahub/mcp-server`. Both surfaces ship pre-wired to it.

## Public API

```ts
import {
  installArtifact,
  uninstallArtifact,
  listInstalled,
  findInstall,
  type InstallOptions,
  type InstallResult,
  type UninstallResult,
  type InstallProgressEvent,
  type ClientName,
} from "@metahub/installer";

const result = await installArtifact({
  kind: "skill",
  slug: "pdf",
  onProgress: (e) => console.log(e.stage),
});
```

Lower-level pieces are also exported when you need them:

```ts
import {
  listInstalls,
  recordInstall,
  removeInstall,
  type InstalledRecord,
  CLIENT_ADAPTERS,
  wireMcpAcrossClients,
  unwireMcpAcrossClients,
  wireHook,
  unwireHook,
  fetchAndExtractTarball,
  extractLocalTarball,
  getInstallInfo,
  getPublicArtifact,
  listPublicArtifacts,
  installPathFor,
  installsFile,
  claudeSettingsFile,
  configRoot,
  configFile,
} from "@metahub/installer";
```

## Consumers

- [`@metahub-ai/mh`](../cli/README.md): `mh install / uninstall / list / update / show / outdated / search / doctor` all delegate here.
- [`@metahub/mcp-server`](../mcp-server/README.md): `metahub_install`, `metahub_uninstall`, `metahub_list_installed` call straight into `installArtifact`, `uninstallArtifact`, `listInstalled`. Both surfaces share the same install ledger and the same MCP wiring, so installs are interchangeable.

## Boundaries

- Depends on [`@metahub/auth`](../auth/README.md) for the bearer token and portal URL.
- Depends on [`@metahub/shared`](../shared/README.md) for the wire-format contracts.
- No `console.log` or terminal UI dependencies of its own.
