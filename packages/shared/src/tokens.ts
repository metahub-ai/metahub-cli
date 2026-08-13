/**
 * Service-to-service Bearer tokens minted by the portal admin UI. Used
 * by the registry (build pipeline + review proxy) and by the CLI
 * (anonymous install lookups).
 */
export type RegistryTokenScope = "artifacts:read" | "reviews:write" | "ingest:write";

export interface RegistryTokenSummary {
  id: string;
  name: string;
  prefix: string;
  scopes: RegistryTokenScope[];
  createdMs: number;
  lastUsedMs: number | null;
  revokedMs: number | null;
}

export interface CreatedRegistryToken extends RegistryTokenSummary {
  /** Returned ONCE at create time; never recoverable. */
  plaintext: string;
}
