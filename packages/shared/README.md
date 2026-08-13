# @metahub/shared

> **Vendored copy.** The canonical source of this package lives in
> [metahub-monorepo](https://github.com/metahub-ai/metahub-monorepo)'s `packages/shared`
> (the portal, registry, and publisher SDKs build against it there). Do not hand-edit
> it in this repo — change it in the monorepo, then run `pnpm sync:shared` here.

Wire-format types and API contracts shared across the portal, registry, CLI, and SDK family.

## What's in here

- `artifact.ts` — `Artifact`, `ArtifactKind`, `Visibility`, `Author`, `ArtifactManifest`, `ArtifactInfo`
- `public.ts` — `PublicArtifact`, `PublicReview`, `PublicReviewSummary` — the safe-to-leak projections
- `ingest.ts` — `SpanRow`, `IngestBatch`, `IngestResponse` — telemetry wire format
- `tokens.ts` — `RegistryTokenScope`, `RegistryTokenSummary`, `CreatedRegistryToken`
- `eval.ts` — `EvalReport`, `EvalCheck` — onboarding eval results
- `api-contracts.ts` — request/response shape for **every** public HTTP endpoint

## Convention

Every endpoint the portal exposes has its `Request` and `Response` typed in `api-contracts.ts`. The portal imports these to type its handlers; the registry and CLI import these to type their fetches. No `unknown` body types in production code.

## When to change something here

Touching a type in this package affects multiple teams. PRs here auto-request review from the portal, registry, and CLI/SDK teams (see `.github/CODEOWNERS`). Keep changes minimal and additive when possible.
