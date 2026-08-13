/**
 * Public API for @metahub/auth.
 *
 * Both the MetaHub CLI and the MetaHub MCP server import from this
 * entry point. The package owns the on-disk token format and the
 * device-code OAuth flow against the portal; consumers wrap it in
 * whatever UI they need (terminal prompts, MCP tool responses).
 */
export {
  startDeviceCodeFlow,
  pollDeviceCode,
  type DeviceCodeStart,
  type DeviceCodeStatus,
} from "./device-code.js";

export {
  persistToken,
  readPersistedToken,
  clearPersistedToken,
  refreshUserHandle,
  type AuthToken,
} from "./token.js";

export { loadAuthConfig, saveAuthConfig, type AuthConfig } from "./config.js";

export {
  currentUser,
  resolveBearer,
  tryResolveBearer,
  startDeviceFlow,
  pollDeviceFlow,
} from "./portal-api.js";

export { configRoot, configFile, writePrivateFile, isPrivateFile } from "./paths.js";
