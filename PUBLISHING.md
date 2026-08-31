# Publishing `@metahub-ai/mh`

The public npm package and the shell-installer tarball are built from the same
standalone bundle. The npm package contains both the `mh` and `metahub-mcp`
binaries and has no runtime dependencies on the workspace packages.

## First release

npm requires a package to exist before a trusted publisher can be attached to
it. For the first release only:

1. Create a granular npm token that can publish under the `@metahub-ai` scope.
2. Add it to `metahub-ai/metahub-cli` as the `NPM_TOKEN` Actions secret.
3. Merge the release commit with `packages/cli/package.json` set to `0.1.0`.
4. Create and publish the GitHub release `v0.1.0`.
5. Confirm that `@metahub-ai/mh@0.1.0` is available on npm.

The `publish-npm.yml` workflow verifies the repository, requires the release
tag to match the package version, builds the standalone package, installs both
binaries into a clean prefix, and then publishes with provenance.

## Switch to trusted publishing

After the first package exists, configure its npm trusted publisher:

- Provider: GitHub Actions
- Organization: `metahub-ai`
- Repository: `metahub-cli`
- Workflow: `publish-npm.yml`
- Allowed action: `npm publish`

Then remove the `NPM_TOKEN` repository secret and its `NODE_AUTH_TOKEN` mapping
from `publish-npm.yml`. Future releases authenticate with short-lived GitHub
OIDC credentials and publish provenance automatically.

## Subsequent releases

1. Update `packages/cli/package.json` and `CHANGELOG.md`.
2. Open and merge a pull request after CI passes.
3. Publish a GitHub release whose tag exactly matches the package version with
   a `v` prefix, such as `v0.2.0`.
4. Verify the npm package page and run:

   ```bash
   npm install -g @metahub-ai/mh
   mh --version
   metahub-mcp --version
   ```

Run `pnpm publish:check` locally before a release to inspect npm's exact file
list without publishing anything.
