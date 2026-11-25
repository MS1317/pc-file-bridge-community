# Contributing

Focused bug fixes, tests, documentation improvements and security hardening are welcome. For larger changes, open an issue first.

## Local development

1. Install Node.js (20.19+ or 22.12+) and pnpm 9: `npm install -g pnpm@9`
2. `pnpm install --frozen-lockfile`
3. `pnpm build`, `pnpm typecheck` and `pnpm test`
4. With ports 4777 to 4779 free, `pnpm bridge:smoke` starts the bridge and runs the preflight, as CI does
5. Open a pull request that describes the change, its security impact and how you tested it

## Safety requirements

- Never commit runtime data, tokens, logs, credentials, workspace registries or personal paths.
- Keep write and terminal capabilities off by default, and enforce them in the Bridge API rather than in a client.
- Resolve file paths with `resolveWorkspacePath()`. Do not call `resolveAndGuard()` alone from a new file tool.
- Decide on permissions from the matched route, never from the raw URL.
- Add a regression test for every security-sensitive change.
- Update the docs in the same pull request when behavior changes.

Report vulnerabilities privately. See [SECURITY.md](SECURITY.md).
