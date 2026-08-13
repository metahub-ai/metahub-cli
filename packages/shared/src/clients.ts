/**
 * Canonical list of AI tools / IDEs MetaHub knows how to talk about.
 * Shared between the portal (so the artifact-info editor's checkbox
 * catalog matches) and the registry (so the detail page can render
 * per-client setup snippets).
 *
 * Only the `name` field is the wire identifier — it's what gets stored
 * in `artifact_info.supported_clients` and shown in the UI. Keep names
 * stable; bumping a name is a data-migration event.
 *
 * `supports` tells the editor which checkboxes to show for which
 * artifact kind. The registry-side `client-catalog.ts` extends each
 * entry with the actual install snippet for each (client, kind) pair.
 */
import type { ArtifactKind } from "./artifact.js";

export interface ClientMeta {
  /** Canonical display name. Stored as-is in supportedClients. */
  name: string;
  /** Marketing/product page. */
  url: string;
  /** Which artifact kinds this client supports natively. */
  supports: ArtifactKind[];
}

export const CLIENTS: ClientMeta[] = [
  {
    name: "Claude Code",
    url: "https://www.anthropic.com/claude-code",
    supports: ["skill", "mcp", "plugin"],
  },
  {
    name: "Claude Desktop",
    url: "https://claude.ai/download",
    supports: ["skill", "mcp"],
  },
  {
    name: "Cursor",
    url: "https://cursor.com",
    supports: ["mcp"],
  },
  {
    name: "Antigravity",
    url: "https://antigravity.google",
    supports: ["mcp"],
  },
  {
    name: "VS Code",
    url: "https://code.visualstudio.com",
    supports: ["mcp"],
  },
  {
    name: "Zed",
    url: "https://zed.dev",
    supports: ["mcp"],
  },
  {
    name: "Windsurf",
    url: "https://windsurf.com",
    supports: ["mcp"],
  },
  {
    name: "Continue",
    url: "https://continue.dev",
    supports: ["mcp"],
  },
  {
    name: "Cline",
    url: "https://cline.bot",
    supports: ["mcp"],
  },
  {
    name: "Goose",
    url: "https://block.github.io/goose/",
    supports: ["mcp"],
  },
  {
    name: "Codex CLI",
    url: "https://github.com/openai/codex",
    supports: ["mcp"],
  },
];

/** Clients that work with a given artifact kind. Used by the editor. */
export function clientsForKind(kind: ArtifactKind): ClientMeta[] {
  return CLIENTS.filter((c) => c.supports.includes(kind));
}
