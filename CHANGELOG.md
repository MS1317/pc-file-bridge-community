# Changelog

## 0.2.0

### Security

- The permission gate now uses the matched route. Before, encoded spellings such as `/changes/%77rite` ran while the capability was disabled. The Bridge API token was required.
- File tools can no longer reach the bridge's `data/` folder, and it cannot be registered as a workspace.
- Deny rules ignore case, and are also checked against the real file behind a path. Before, `SECRETS/x.json` bypassed the `secrets/` rule on Windows and macOS.
- A directory named in `.bridgeignore` now also blocks direct reads of its files, and apply and revert check the same rules as preview.
- An approval for an apply or revert shows the file and diff. Before, it showed only an ID.
- `tunnel:tailscale` no longer replaces another app on the same Tailscale port, or makes its other paths public, and `:off` no longer removes one.
- Upgraded to Fastify 5, React Router 7 and Vite 6.4 to clear known advisories.

### Changed

- **Local approval is off by default** for new installs. File changes and terminal commands are still off by default. Existing `data/access-policy.json` files keep their setting.
- Node.js 20.19+ or 22.12+ is required.
- Start, test and typecheck scripts compile the shared packages first, and no longer need Corepack.
- New workspaces allow more source file types by default, including Python, Go, Rust, Java and C#.
- `preflight:mcp` no longer requires a workspace with a specific name.
- The relay saves its client token in `data/relay-client-token.txt`, and the agent keeps its credentials in `data/agent`.
- Removed `bridge:safe`, `bridge:write` and `mcp:server`, which were duplicates of other scripts.

### Fixed

- First start failed because `data/` did not exist and the shared packages were not compiled.
- The API and MCP server could each create a different token on first start.
- Dashboard: Approve and Reject failed with 400, the approval queue failed with "Untrusted origin", writes waiting for approval were shown as applied, and the token page accepted any token.
- The MCP server accepts protocol versions from 2024-11-05 on. Before, clients that did not know 2025-11-25 could not connect.
- Backups keep the exact bytes of files that are not UTF-8, and line edits to such files are refused. Before, they were corrupted.
- A preview can no longer overwrite a file that appeared, or recreate one that was deleted, after it was made. A stale `baseHash` is rejected by every write path.
- Writes above 128 KiB work when approval is off.
- Dashboard: a rejected token shows the sign-in prompt, errors clear on refresh, spreadsheet changes can be reverted, a failed approval says why, and pages no longer hang when the API is down.
- Terminal jobs that finished successfully could be reported as `failed` on a busy machine.
- The dashboard no longer moves to port 4779 when 4778 is taken.
- The Workspaces page no longer shows an "Approval Required" badge, which did not reflect the access policy.
- `bridge:stop` also stops the watchers, which used to restart the bridge on the next file change, and supports macOS and Linux. `bridge-autostart.ps1` works without pm2.
- The experimental relay and agent start outside tests.

## 0.1.0

Initial community edition.
