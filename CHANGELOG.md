# Changelog

## Unreleased

- `mh install skill/<slug>` now installs the related skill directories a repo groups with the requested skill. Skill repos that ship as a Claude Code plugin bundle (a `.claude-plugin/marketplace.json` or `.claude-plugin/plugin.json` with custom `skills` paths, or the plugin's conventional `skills/` directory) get every declared sibling skill installed alongside the requested one — matching what Claude Code's plugin install picks up — instead of silently dropping them ([#1](https://github.com/metahub-ai/metahub-cli/issues/1)). Discovery supports string and array declarations, nested plugin sources, custom skill containers, and `metadata.pluginRoot`. Related skills are recorded as their own installs (visible in `mh list`), move with the skill that pulled them in on `mh update`, and are never clobbered if you installed one standalone. `mh uninstall` hints at related skills left behind.

## 0.1.0

- Initial standalone release. `@metahub/cli`, `@metahub/mcp-server`, `@metahub/auth`, and `@metahub/installer` extracted from [metahub-monorepo](https://github.com/metahub-ai/metahub-monorepo) into this repository, with `@metahub/shared` vendored as a synced copy. Functionality is identical to the monorepo versions at the point of extraction.
