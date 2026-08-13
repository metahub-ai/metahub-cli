/**
 * `metahub_uninstall` — thin wrapper over `uninstallArtifact()` from
 * `@metahub/installer`. The library removes the on-disk install dir,
 * unwires MCP config across detected clients, and drops the install
 * ledger entry; this tool returns a friendly summary string.
 */
import { uninstallArtifact, type UninstallResult } from "@metahub/installer";
import type { ArtifactKind } from "@metahub/shared";

export interface UninstallArtifactInput {
  kind: ArtifactKind;
  slug: string;
}

export interface UninstallArtifactResult {
  result: UninstallResult;
  summary: string;
}

export async function uninstallArtifactTool(
  input: UninstallArtifactInput,
  opts: {
    uninstaller?: typeof uninstallArtifact;
  } = {},
): Promise<UninstallArtifactResult> {
  const uninstallerFn = opts.uninstaller ?? uninstallArtifact;
  const result = await uninstallerFn({ kind: input.kind, slug: input.slug });
  if (!result.removed) {
    return {
      result,
      summary: `${input.kind}/${input.slug} is not installed.`,
    };
  }
  return {
    result,
    summary: `Removed ${input.kind}/${input.slug}.`,
  };
}
