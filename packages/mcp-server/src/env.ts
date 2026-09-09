/**
 * Environment + path resolution. Keeping it in one tiny module so
 * tests can override the endpoints cleanly.
 *
 * The MCP server no longer reads `~/.metahub/installs.json` or
 * `~/.metahub/config.json` directly — `@metahub/installer` and
 * `@metahub/auth` own those paths. We still own the registry URL knob
 * because `registry-client` needs to pass it through.
 */

/**
 * Optional baked-catalog URL.
 *
 * There is deliberately **no default**. The registry app builds
 * `.cache/registry.json` as a private build input and has never served
 * it over HTTP — the request-time catalog read was removed outright
 * (see `apps/registry/src/lib/registry/index.ts`, the 40-70 MB
 * per-request payload behind the registry 502 incident). A compiled-in
 * default of `https://registry.metahub.ai/registry.json` therefore
 * pointed at a URL that 404s, which took `metahub_get` and
 * `metahub://catalog` down permanently and silently disabled
 * `metahub_search`'s degraded fallback.
 *
 * The portal's public catalog API is the source of truth for every
 * catalog read now. This knob survives only for self-hosters and tests
 * that publish their own snapshot; when it is unset the tools use the
 * portal and nothing else.
 */
/**
 * The registry *website* root, which older `mh bootstrap` versions baked
 * into every wired client's MCP env as `METAHUB_REGISTRY_URL`.
 *
 * It serves HTML, not a catalog. Honouring it would make
 * `hasRegistryConfigured()` true for every already-bootstrapped user and
 * turn the degraded fallback into `registry payload ... is not valid
 * JSON` — the confusing wrong-source error this whole change set exists
 * to remove. Bootstrap no longer emits it, but configs already on disk
 * are only rewritten by `mh bootstrap --force`, so ignore the value here
 * and let existing installs heal themselves.
 */
const LEGACY_NON_CATALOG_URLS = new Set([
  "https://registry.metahub.ai",
  "https://registry.metahub.ai/",
]);

export function registryUrl(): string | null {
  const raw = process.env.METAHUB_REGISTRY_URL;
  if (!raw || raw.length === 0) return null;
  if (LEGACY_NON_CATALOG_URLS.has(raw.trim())) return null;
  return raw;
}
