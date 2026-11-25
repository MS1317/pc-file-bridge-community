# Security model

To report a vulnerability, see [SECURITY.md](../SECURITY.md) in the repository root.

## What the bridge protects, and what it does not

The bridge limits what an **authenticated MCP client** can do through **file tools**. It does not protect against:

- **Terminal commands.** They run as your user, unsandboxed. A command can read any file you can read, including the bridge's own tokens, and can use the network. Enabling the terminal means trusting the client with your account.
- **Edits that run later.** A client that can edit source, scripts or `package.json` can change code you or a tool will execute. Do not register the bridge's own folder with writes enabled unless you are developing the bridge.
- **Other programs on your PC.** Anything running as your user can read `data/`.
- **Prompt injection.** Text in a file can influence a model. Keep approval on when a client reads content you do not trust.

## Threats and mitigations

| Threat | Mitigation |
|---|---|
| Someone calls the Bridge API | Bearer token on every request except `/health`; binds to `127.0.0.1` only |
| Someone calls the MCP server | Separate bearer token on every `POST` |
| A client grants itself permissions | Permission and approval routes also need the local admin token, a loopback client address and, from browsers, a same-origin request |
| A website you visit calls the API | CORS allows only the dashboard origin, and admin routes check `Sec-Fetch-Site` |
| Path traversal and absolute paths | `resolveAndGuard()` rejects anything outside the workspace root |
| Links that leave the workspace | Each existing path segment is resolved and must stay inside |
| Aliases of blocked files (links, short names, different casing) | Rules are checked against the requested path and the file it really names. Deny rules ignore case. |
| Reading the bridge's own tokens | `data/` is blocked for file tools in every workspace, and cannot be registered as one |
| Alternate URL spellings of a gated route | The permission gate uses the matched route, not the raw URL |
| Overwriting newer work | Applying a preview is rejected if the file changed since. `baseHash` extends the check back to an earlier read. |
| Bad writes | Backup before each write, atomic replace, and revert |
| Missing history | Applies, reverts, terminal commands and spreadsheet writes go to `data/audit-log.jsonl` |
| Resource use | 1 MB text reads, bounded search results, capped command output and runtime, 120 API requests per minute per token |

## Ports

| Port | Service | Bind | Expose? |
|---|---|---|---|
| 4777 | Bridge API | `127.0.0.1` | Never |
| 4778 | Dashboard | `127.0.0.1` | Never |
| 4779 | MCP server | `127.0.0.1` by default | Only through an HTTPS tunnel |

A tunnel makes a localhost listener reachable from the internet. Binding to `127.0.0.1` does not protect a tunneled port; the MCP token does.

If `MCP_HOST` is set to a non-local address, the MCP server prints a warning and starts. It does not add TLS.

## Tokens

Each is 256 random bits, created on first run, and compared in constant time. Files are created with mode `0600`. Windows ignores that mode, so the files rely on your user profile's permissions.

| File | Used for | Rotate |
|---|---|---|
| `data/mcp-remote-token.txt` | MCP clients | `pnpm token:mcp:rotate`, then restart the bridge. The running server accepts the old token until it restarts. |
| `data/auth-token.txt` | Dashboard, and MCP server to API | Dashboard → Settings. Takes effect immediately. |
| `data/local-admin-token.txt` | Changing permissions and approving operations | Delete the file and restart the bridge |

The dashboard keeps the API and admin tokens in the browser's `localStorage`. Use it only in a browser profile you trust.

A token in a URL (`/mcp/<token>`) can end up in logs and history. Use the header when the client supports it.

## Permissions and approvals

Set in **Dashboard → Access Control**, stored in `data/access-policy.json`, effective immediately.

| Setting | Default |
|---|---|
| File and spreadsheet modifications | Off |
| Terminal commands | Off |
| Require local approval | Off |

The Bridge API enforces these for every caller. Tools stay listed while disabled, and calls to them fail. Turning a capability off also rejects its pending approvals.

With approval on, each write or command waits in the dashboard with its exact payload, and with the file and diff when the payload is only an ID. Approvals are single-use, expire after 10 minutes, live in memory only, and are limited to 128 KiB of payload and 100 waiting requests.

Confirmation prompts shown by Claude, ChatGPT or another client are separate and not controlled by the bridge.

## File rules

Checked in this order for every file tool. All must pass.

1. Always-blocked patterns, below
2. `.bridgeignore` in the workspace root
3. The workspace's blocked globs, plus the bridge's own `data/` folder
4. The workspace's allowed globs, if any are set
5. Path and link checks

Rules 1 to 3 ignore case. `.bridgeignore` takes one pattern per line. Naming a directory excludes everything in it. Negation (`!pattern`) is not supported. An **empty** allowed list means every file that is not blocked is accessible.

### Always blocked

```text
# Secrets
**/.env  **/.env.*  **/*.pem  **/*.key  **/*.p12  **/*.pfx
**/.ssh/**  **/id_rsa  **/id_ed25519
**/*.credentials  **/.aws/**  **/credentials  **/secrets/**

# Databases
**/*.sqlite  **/*.db  **/*.sqlite3

# Version control, dependencies, build output and caches
**/.git/**  **/node_modules/**  **/dist/**  **/build/**  **/out/**  **/coverage/**
**/.next/**  **/.nuxt/**  **/.turbo/**  **/cache/**  **/.cache/**  **/.parcel-cache/**
**/.venv/**  **/venv/**  **/__pycache__/**
**/.pnpm-store/**  **/.yarn/cache/**  **/.yarn/unplugged/**  **/.yarn/install-state.gz
**/.npm/**  **/.bun-install-cache/**  **/.nx/cache/**  **/.angular/cache/**
```

A secret in a file that does not match one of these patterns is readable. Do not rely on the list as your only protection.

## Writes

Every write re-checks the rules, creates a backup in `data/backups/`, replaces the file atomically and appends an audit entry. `revert_change` restores the backup and is itself backed up and logged. In results, `newHash: null` means the file no longer exists.

Backups contain copies of file contents, and the audit log contains the commands that were run. Neither is pruned automatically.

## Terminal

Commands start in a registered workspace, receive a minimal environment without inherited secrets, and get no stdin. Length, output and runtime are capped by `TERMINAL_EXECUTION_POLICY`. Long jobs need a lease renewal every 5 minutes or they are stopped. The starting directory is checked, but the command itself can go anywhere.

## Spreadsheets

`.xlsx` only, under the same file rules and permissions. Workbooks are validated before and after writing, and restored if verification fails. ZIP entry names that are absolute, traverse directories or collide are rejected. Limits: 50 MiB per workbook, 10,000 cells per read, 2,000 rows per write, 200 search matches, 100,000 scanned cells.
