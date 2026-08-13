/**
 * `metahub_list_installed` — list MetaHub artifacts already installed on this
 * machine. Thin wrapper over `listInstalled()` from `@metahub/installer`.
 *
 * SECURITY: the on-disk ledger record carries the per-install ingest WRITE
 * credential (`ingestApiKey`, an `mhi_` token). MCP tool output is text the host
 * AI reads and forwards to its model provider, so this wrapper STRIPS that
 * credential — only non-secret fields cross the MCP boundary. The CLI/SDK still
 * read the full record from the local ledger; the secret just never leaves the
 * machine via MCP. We build the safe shape as an allowlist (explicit field copy)
 * so a new secret-bearing field added to InstalledRecord can never silently leak
 * here. A regression test asserts no `mhi_` token appears in the output.
 */
import { listInstalled as listInstalledLib } from "@metahub/installer";
import type { InstalledRecord } from "@metahub/installer";

/** InstalledRecord with the ingest write-credential removed — safe for MCP output. */
export type SafeInstalledRecord = Omit<InstalledRecord, "ingestApiKey">;

export async function listInstalledArtifacts(): Promise<SafeInstalledRecord[]> {
  const installs = await listInstalledLib();
  return installs.map((r) => ({
    artifactId: r.artifactId,
    installId: r.installId,
    slug: r.slug,
    kind: r.kind,
    version: r.version,
    installPath: r.installPath,
    publishedSha: r.publishedSha,
    installedAt: r.installedAt,
  }));
}

export type { InstalledRecord };
