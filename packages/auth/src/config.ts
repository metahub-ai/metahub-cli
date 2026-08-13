/**
 * Persisted auth + portal config at `~/.metahub/config.json`.
 *
 * This is the on-disk source of truth for which portal / registry the
 * client talks to and the session token returned by `mh login`. The
 * file is shared with the installer (which reads the portal URL +
 * telemetry preference) and the MCP server (Phase 7).
 *
 * The full schema covers more than auth on its own — telemetry mode
 * lives here too — so the persistent format stays one file across
 * surfaces rather than fragmenting state between packages.
 */
import fs from "node:fs";
import { configFile, writePrivateFile } from "./paths.js";

export interface AuthConfig {
  portalUrl: string;
  registryUrl: string;
  /** Session token from device-flow login (Bearer for /api routes). */
  sessionToken?: string;
  /** Service token for anonymous reads — env-set, never written. */
  serviceToken?: string;
  /**
   * Local telemetry preference. Owned here for backwards compatibility
   * with `~/.metahub/config.json`; the installer reads it but doesn't
   * write it.
   *   on          — full telemetry (default)
   *   off         — no payloads leave the machine
   *   no-handoff  — invocations only; skip the handoff graph
   */
  telemetry?: "on" | "off" | "no-handoff";
}

const DEFAULTS: AuthConfig = {
  portalUrl: process.env.METAHUB_PORTAL_URL ?? "https://developer.metahub.ai",
  registryUrl: process.env.METAHUB_REGISTRY_URL ?? "https://registry.metahub.ai",
  serviceToken: process.env.METAHUB_SERVICE_TOKEN,
};

export function loadAuthConfig(): AuthConfig {
  try {
    const raw = fs.readFileSync(configFile(), "utf8");
    const parsed = JSON.parse(raw) as Partial<AuthConfig>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveAuthConfig(cfg: Partial<AuthConfig>): AuthConfig {
  const next: AuthConfig = { ...loadAuthConfig(), ...cfg };
  // 0600, and re-chmod'd on every write: this file holds the session
  // token, and it shipped world-readable for long enough that existing
  // installs need repairing rather than just new ones getting it right.
  writePrivateFile(configFile(), JSON.stringify(next, null, 2));
  return next;
}
