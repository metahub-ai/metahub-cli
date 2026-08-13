/**
 * `metahub_submit_review` — submit a star-rated review for an artifact
 * on behalf of the signed-in user.
 *
 * Submission is two-step: kind+slug → artifact ID via the public
 * artifact endpoint (which already accepts `sess_*` bearers), then POST
 * the review payload to the portal's review-write endpoint.
 *
 * TODO: confirm with portal team — `POST /api/public/reviews` currently
 * accepts only `mhrg_*` service tokens with the `reviews:write` scope
 * (used by the registry to forward verified-author reviews). A
 * user-bearer path that accepts `sess_*` tokens and stamps the review
 * as verified-by-the-signed-in-user does not yet exist; this tool's
 * wiring assumes the portal team adds that additive support to the
 * same endpoint. Until then the portal returns 401/403 and the tool
 * passes the error through.
 */
import { callPortal, PortalError } from "../lib/portal-client.js";
import type { ItemKind } from "../types.js";

export interface SubmitReviewInput {
  kind: ItemKind;
  slug: string;
  rating: number;
  body: string;
  /** Optional short headline displayed above the review body. */
  title?: string;
}

export interface SubmitReviewOptions {
  bearer: string;
  baseUrl?: string;
  fetcher?: typeof fetch;
}

interface PublicArtifactResponse {
  artifact: { id: string };
}

interface SubmittedReview {
  id: string;
  artifactId: string;
  rating: number;
  title: string | null;
  body: string;
  authorName: string;
  authorHandle: string | null;
  verifiedUser: boolean;
  createdMs: number;
}

interface PortalReviewResponse {
  ok: boolean;
  review: SubmittedReview;
}

export async function submitReview(
  input: SubmitReviewInput,
  opts: SubmitReviewOptions,
): Promise<SubmittedReview> {
  const lookup = await callPortal<PublicArtifactResponse>(
    `/api/public/artifacts/${input.kind}/${encodeURIComponent(input.slug)}`,
    {
      bearer: opts.bearer,
      baseUrl: opts.baseUrl,
      fetcher: opts.fetcher,
    },
  );
  const id = lookup.artifact?.id;
  if (!id) {
    throw new PortalError(`No artifact found for kind=${input.kind} slug=${input.slug}.`, 404);
  }
  const body: Record<string, unknown> = {
    artifactId: id,
    rating: input.rating,
    body: input.body,
  };
  if (input.title) body.title = input.title;
  const res = await callPortal<PortalReviewResponse>("/api/public/reviews", {
    method: "POST",
    bearer: opts.bearer,
    baseUrl: opts.baseUrl,
    fetcher: opts.fetcher,
    body,
  });
  return res.review;
}

export { PortalError };
