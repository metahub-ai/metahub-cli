/**
 * Environment + path resolution. Keeping it in one tiny module so
 * tests can override the home directory cleanly.
 *
 * The MCP server no longer reads `~/.metahub/installs.json` or
 * `~/.metahub/config.json` directly — `@metahub/installer` and
 * `@metahub/auth` own those paths. We still own the registry URL and
 * portal URL knobs because tests for `registry-client` and
 * `portal-client` need to pass them through.
 */

/**
 * Where the published registry JSON lives. The registry app builds
 * `.cache/registry.json` and serves it as a static asset. End users
 * can override this if they're running a private registry or want to
 * point at a staging build.
 */
export const DEFAULT_REGISTRY_URL = "https://registry.metahub.ai/registry.json";

/**
 * Default portal URL. Mirrors the default in `@metahub/auth` so a
 * fresh checkout (no `~/.metahub/config.json`) still talks to the
 * production portal.
 */
export const DEFAULT_PORTAL_URL = "https://developer.metahub.ai";

export function registryUrl(): string {
  return process.env.METAHUB_REGISTRY_URL || DEFAULT_REGISTRY_URL;
}

export function portalUrl(): string {
  return process.env.METAHUB_PORTAL_URL || DEFAULT_PORTAL_URL;
}
