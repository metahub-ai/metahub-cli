# Contributing

Thanks for helping improve the MetaHub client toolchain.

## Setup

```bash
pnpm install
pnpm verify
```

Node ≥ 20, pnpm ≥ 9. `pnpm verify` runs build, typecheck, lint, and tests across every package in dependency order — it must pass before you open a PR.

## Ground rules

- **Tests live in `packages/<name>/tests/`**, one Vitest config per package.
- **`packages/shared` is a synced copy** of the monorepo's wire-format contract. Don't hand-edit it here — change it in [metahub-monorepo](https://github.com/metahub-ai/metahub-monorepo) first, then run `pnpm sync:shared`.
- **CLI and MCP server share `@metahub/auth` and `@metahub/installer`.** A change to either library affects both surfaces; run the full `pnpm verify`, not just one package's tests.
- **Commit messages:** `<area>: <one-line summary>` (e.g. `cli: add --json to mh list`, `installer: harden tarball extraction`).
- Format with Prettier: `pnpm format:check` should be clean.

## Releasing

1. Bump versions, update `CHANGELOG.md`.
2. `pnpm verify && pnpm bundle`.
3. Publish the standalone tarball to the registry: `pnpm tarball:monorepo` (copies into a sibling monorepo checkout, commit it there).
4. Optionally `npm publish` the individual packages.
