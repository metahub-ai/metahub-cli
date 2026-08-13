/**
 * Telemetry wire formats. The SDK family posts these to the portal at
 * /api/ingest. The portal stores them and rolls them up for the
 * /artifacts/<id>/observability view.
 */
import type { ArtifactKind } from "./artifact.js";

export type SpanStatus = "ok" | "error";

/**
 * One invocation of an installed artifact. The SDK buffers spans for
 * 30s (or until process shutdown) and POSTs a batch.
 */
export interface SpanRow {
  /** Stable ID minted by the SDK. */
  spanId: string;
  /** The artifact whose runtime emitted this span. */
  artifactId: string;
  artifactSlug: string;
  artifactKind: ArtifactKind;
  /** The version that was installed. */
  version: string | null;
  /** Opaque per-install handle. Never identifies the end user beyond a
   *  random ID minted at install time. */
  installId: string;
  /** Which AI client invoked this — `claude-code`, `cursor`, ... */
  host: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  status: SpanStatus;
  errorMessage?: string | null;
  /** Which LLM the host paired with the artifact on this invocation. */
  model?: string | null;
  /** Tools the artifact invoked during the run, e.g. ["Read","Bash"]. */
  tools?: string[];
  /** When the artifact handed off to another skill, this is its slug. */
  handoffTo?: string | null;
}

export interface IngestBatch {
  spans: SpanRow[];
}

export interface IngestResponse {
  accepted: number;
  rejected: number;
  errors?: Array<{ index: number; message: string }>;
}
