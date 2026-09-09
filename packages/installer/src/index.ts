/**
 * Public API for @metahub/installer.
 *
 * Both the MetaHub CLI and the MetaHub MCP server import from here.
 * The package owns:
 *   - High-level install / uninstall / list orchestration
 *   - The local install ledger at `~/.metahub/installs.json`
 *   - Multi-client MCP wiring + per-kind post-install hooks
 *   - Tarball fetch / extract, and making MCP-kind installs runnable
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
  codexBinary,
  wireMcpAcrossClients,
  unwireMcpAcrossClients,
  readJsonConfig,
  type ClientAdapter,
  type ClientWriteResult,
  type JsonConfigRead,
  type LaunchSpec,
  type McpEnv,
} from "./clients.js";

export {
  wireHook,
  unwireHook,
  refreshSkillWiring,
  type WireResult,
  type SkillMirrorResult,
  type SkillMirrorStatus,
  type SkillRefreshResult,
} from "./hooks.js";

export {
  CAPABILITY_MATRIX,
  capabilityFor,
  clientsForKind,
  clientLabel,
  clientIdFromLabel,
  type CapabilityRow,
  type ClientId,
  type ReloadStrategy,
  type WiringStrategy,
} from "./capabilities.js";

export { CLIENT_IDS, detectClient, detectedClients } from "./detection.js";

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
  prepareMcpInstall,
  resolveMcpEntry,
  readMcpPackageJson,
  type McpLaunch,
  type McpPrepareResult,
  type McpPrepareOptions,
} from "./mcp-build.js";

export {
  getInstallInfo,
  getPublicArtifact,
  listPublicArtifacts,
  searchPublicArtifacts,
  type PublicArtifactResponse,
  type ListPublicArtifactsResult,
} from "./portal-api.js";

export {
  agentsSkillsDir,
  antigravityMcpConfigPath,
  antigravitySkillsDir,
  claudeSettingsFile,
  configFile,
  configRoot,
  geminiDir,
  geminiSettingsFile,
  getHome,
  installPathFor,
  installsFile,
  openCodeConfigPath,
  userConfigDir,
} from "./paths.js";
