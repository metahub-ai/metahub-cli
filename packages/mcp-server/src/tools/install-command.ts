/**
 * `metahub_install_command` — returns the exact `mh install ...`
 * invocation for an artifact, plus a short tip the AI can show the
 * user. Phase 1 deliberately does not shell out; the AI can offer to
 * run the command via its own Bash tool with the user's consent.
 *
 * Mirrors `apps/registry/src/lib/registry/url.ts#kindSegment` — kept
 * inline rather than imported to avoid the package-from-app boundary
 * violation.
 */
import type { ItemKind } from "../types.js";

export interface InstallCommandInput {
  kind: ItemKind;
  slug: string;
}

export interface InstallCommandResult {
  command: string;
  tip: string;
}

export function kindSegment(kind: ItemKind): string {
  return `${kind}s`;
}

export function installCommand(input: InstallCommandInput): InstallCommandResult {
  const command = `mh install ${kindSegment(input.kind)}/${input.slug}`;
  const tip = `Run \`${command}\` in your terminal to install this ${input.kind}. The MetaHub CLI (\`mh\`) ships from npm — see https://registry.metahub.ai for setup.`;
  return { command, tip };
}
