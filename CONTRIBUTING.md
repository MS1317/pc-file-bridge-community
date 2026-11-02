# Contributing

PC File Bridge accepts focused bug fixes, tests, documentation improvements, and security hardening.

## Local development

1. Install Node.js 20 or newer and enable Corepack.
2. Run `corepack pnpm install --frozen-lockfile`.
3. Run `corepack pnpm build` and `corepack pnpm test`.
4. Send a pull request describing the change, security impact, and tests.

## Safety requirements

- Never commit runtime data, tokens, logs, credentials, workspace registries, or local device identifiers.
- Preserve server-side authorization checks for every MCP tool, including direct calls.
- Keep write and terminal execution disabled by default.
- Do not weaken path traversal, symlink, or glob protections.
- Add regression tests for security-sensitive changes.

Report vulnerabilities privately; see SECURITY.md.
