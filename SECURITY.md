# Security Policy

The MetaHub CLI and MCP server run on end-user machines, download artifacts, and write into AI-client config directories — security reports are taken seriously.

## Reporting a vulnerability

Please **do not** open a public issue for security reports. Email **security@metahub.ai** with:

- A description of the issue and its impact
- Steps to reproduce (a proof of concept helps)
- The version affected (`mh --version`)

You should receive an acknowledgement within 72 hours.

## Scope

Of particular interest:

- Path traversal or arbitrary write during artifact install/extraction
- Token leakage from `~/.metahub/config.json` or per-install API keys
- Command injection via artifact metadata or registry responses
- MCP tool inputs escaping their intended effect

## Supported versions

Only the latest released version receives security fixes.
