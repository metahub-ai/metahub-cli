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

## End-to-end check

`pnpm bundle && bash scripts/e2e-harness-matrix.sh` installs the freshly built
tarball into a throwaway prefix, fakes a machine that has every supported
harness on it (`METAHUB_E2E_HOME`), and walks bootstrap, a real skill install,
a real MCP install, doctor, refresh, the uninstalls, the malformed-config guard,
the stdio handshake and the npx-cache launch form. It talks to the production
portal for the two installs, so it needs network access. Run it before tagging
a release and whenever you touch the installer's wiring.

## Releasing

See [PUBLISHING.md](./PUBLISHING.md). In short: bump `packages/cli/package.json`
and `CHANGELOG.md`, merge, then publish a GitHub release tagged `v<version>`; the
`publish-npm.yml` workflow verifies, bundles, publishes `@metahub-ai/mh` to npm,
and attaches the curl tarballs to the release, which is where
`registry.metahub.ai/cli/mh-latest.tgz` redirects.
