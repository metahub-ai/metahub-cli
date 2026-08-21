/**
 * `metahub_install` — call `installArtifact` from `@metahub/installer`
 * directly. Collects progress events into a "Steps" bulleted list so the
 * AI surfaces something more useful than a silent success.
 *
 * The host string identifies the install as coming from the MCP server
 * (not the CLI) when the portal records the install.
 */
import { installArtifact, type InstallProgressEvent, type InstallResult } from "@metahub/installer";
import type { ArtifactKind } from "@metahub/shared";
import { MCP_SERVER_HOST, MCP_SERVER_VERSION } from "../lib/host.js";

export interface InstallArtifactInput {
  kind: ArtifactKind;
  slug: string;
}

export interface InstallArtifactResult {
  result: InstallResult;
  /** Pre-rendered human-readable summary the tool returns to the AI. */
  summary: string;
}

function describeProgressEvent(event: InstallProgressEvent): string | null {
  switch (event.stage) {
    case "resolve":
      return `Resolved ${event.kind}/${event.slug} in the catalog`;
    case "replace-existing":
      return `Removed existing install at ${event.path}`;
    case "download": {
      const sha = event.sha ? ` at SHA ${event.sha.slice(0, 7)}` : "";
      const sub = event.subPath ? ` (sub-path ${event.subPath})` : "";
      return `Fetched tarball${sha}${sub}`;
    }
    case "related":
      return `Installed related skill ${event.slug} from the same repo`;
    case "wire":
      return `Wiring ${event.kind}/${event.slug} into detected AI clients`;
    case "record":
      return `Recorded install at ${event.installPath}`;
    default:
      return null;
  }
}

function summarize(
  kind: ArtifactKind,
  slug: string,
  result: InstallResult,
  events: InstallProgressEvent[],
): string {
  const namePart = result.version ? `${result.name} v${result.version}` : result.name;
  const lines = [`Installed ${namePart} (${kind}/${slug}) to ${result.installPath}.`];

  if (kind === "mcp") {
    const wrote = result.clientsWired.filter((c) => c.status === "wrote");
    const manual = result.clientsWired.filter((c) => c.status === "manual");
    if (wrote.length > 0) {
      const clientList = wrote.map((c) => c.client).join(", ");
      lines.push(`Wired into ${wrote.length} client(s): ${clientList}.`);
    }
    if (manual.length > 0) {
      const manualList = manual.map((c) => `${c.client} (${c.configPath})`).join(", ");
      lines.push(`Manual config required for: ${manualList}.`);
    }
    if (wrote.length === 0 && manual.length === 0) {
      lines.push("No AI clients detected on this machine.");
    }
  }

  if ((result.relatedSkills ?? []).length > 0) {
    const relatedList = result.relatedSkills.map((r) => r.slug).join(", ");
    lines.push(
      `Also installed ${result.relatedSkills.length} related skill(s) from the same repo: ${relatedList}.`,
    );
  }

  if (result.warning) {
    lines.push(`Warning: ${result.warning}`);
  }

  const stepDescriptions = events.map(describeProgressEvent).filter((s): s is string => s !== null);
  if (stepDescriptions.length > 0) {
    lines.push("");
    lines.push("Steps:");
    for (const step of stepDescriptions) {
      lines.push(`- ${step}`);
    }
  }

  lines.push("");
  lines.push("Restart your AI client to load the new artifact.");
  return lines.join("\n");
}

export async function installArtifactTool(
  input: InstallArtifactInput,
  opts: {
    /** Test seam — override the library call. */
    installer?: typeof installArtifact;
  } = {},
): Promise<InstallArtifactResult> {
  const installerFn = opts.installer ?? installArtifact;
  const events: InstallProgressEvent[] = [];
  const result = await installerFn({
    kind: input.kind,
    slug: input.slug,
    host: MCP_SERVER_HOST,
    hostVersion: MCP_SERVER_VERSION,
    onProgress: (e) => events.push(e),
  });
  return { result, summary: summarize(input.kind, input.slug, result, events) };
}
