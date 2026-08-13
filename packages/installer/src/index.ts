/**
 * Public API for @metahub/installer.
 *
 * Both the MetaHub CLI and the MetaHub MCP server import from here.
 * The package owns:
 *   - High-level install / uninstall / list orchestration
 *   - The local install ledger at `~/.metahub/installs.json`
 *   - Multi-client MCP wiring + per-kind post-install hooks
 *   - Tarball fetch / extract
 *   - The typed catalog client (getPublicArtifact, listPublicArtifacts)
 *
 * The library is silent — pass `onProgress` to surface progress events.
 */
export {
  installArtifact,
  uninstallArtifact,
  listInstalled,
  findInstall,
  type ClientName,
  type InstallOptions,
  type InstallResult,
  type UninstallResult,
  type InstallProgressEvent,
} from "./install.js";

export { listInstalls, recordInstall, removeInstall, type InstalledRecord } from "./installs.js";

export {
  CLIENT_ADAPTERS,
  wireMcpAcrossClients,
  unwireMcpAcrossClients,
  type ClientAdapter,
  type ClientWriteResult,
  type LaunchSpec,
  type McpEnv,
} from "./clients.js";

export { wireHook, unwireHook, type WireResult, type SkillMirrorResult } from "./hooks.js";

export {
  CAPABILITY_MATRIX,
  capabilityFor,
  clientsForKind,
  type CapabilityRow,
  type ClientId,
  type ReloadStrategy,
  type WiringStrategy,
} from "./capabilities.js";

export { detectClient, detectedClients } from "./detection.js";

export {
  readLedger,
  recordWiring,
  findWiring,
  dropWiring,
  listWirings,
  type WiringEntry,
  type WiringSet,
} from "./wirings.js";

export {
  parseSkillSource,
  transformSkill,
  toCursorRule,
  toContinueRule,
  toZedPrompt,
  type SkillSource,
} from "./skill-transformers.js";

export { fetchAndExtractTarball, extractLocalTarball, type ExtractOptions } from "./tarball.js";

export {
  getInstallInfo,
  getPublicArtifact,
  listPublicArtifacts,
  searchPublicArtifacts,
  type PublicArtifactResponse,
  type ListPublicArtifactsResult,
} from "./portal-api.js";

export {
  installPathFor,
  installsFile,
  claudeSettingsFile,
  configRoot,
  configFile,
} from "./paths.js";
