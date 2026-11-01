# Security

## Threat Model

| Threat | Mitigation |
|---|---|
| Unauthorized access to API | Bearer token required on every non-health request |
| Unauthorized access to MCP | Separate Bearer token required on every POST /mcp |
| Path traversal (`../../etc/passwd`) | `resolveAndGuard()` rejects any path outside the workspace root |
| Symlink escape | `realpathSync` checks block symlinks that point outside the workspace |
| Absolute path injection | Absolute paths are rejected before resolution |
| Secrets exposure (`.env`, keys) | Default blocked globs are enforced before workspace rules |
| Outside-workspace file access | File tools only accept registered workspace paths; terminal commands run with local user authority |
| Stale write overwriting newer changes | Optional `baseHash` check blocks mismatched writes |
| Unreviewed writes | MCP write tools are marked destructive and use the ChatGPT permission prompt; bridge-side writes still require workspace/path authorization |
| Lost data from bad write | A backup is created before every write; same-directory atomic replacement, read-after-write verification, and revert restore the prior state |
| Missing audit trail | Every apply/revert/terminal/spreadsheet mutation appends to `data/audit-log.jsonl` |
| API accessible from other machines | API binds only to `127.0.0.1` |
| MCP write tools exposed remotely | Write tools hidden and blocked by default (safe mode) |
| MCP adapter bypassing safety | `apps/mcp-server` forwards only allowlisted MCP tools to bridge-api and never touches workspace files directly |
| Unapproved shell execution | MCP token auth, ChatGPT permission prompt, guarded initial workspace directory, runtime/output caps, and audit logging |
| Large file reads crashing server | A 1 MB read limit is enforced in `FileService` |
| Spreadsheet package corruption | `.xlsx` writes validate the ZIP/OpenXML package before and after replacement; failed verification restores the original |
| Spreadsheet feature loss | Cell updates mutate only required worksheet XML; unrelated package parts are carried through unchanged |
| Remote writes without explicit opt-in | `MCP_ALLOW_REMOTE_WRITES=true` required when `MCP_HOST` is non-localhost and writes are enabled |

## Port Architecture

| Port | Service | Bind | Expose? |
|---|---|---|---|
| 4777 | Bridge API | `127.0.0.1` only | **Never** — local only |
| 4778 | Dashboard | `127.0.0.1` only | **Never** — local only |
| 4779 | MCP server | `127.0.0.1` by default | Optional — see below |

**Bridge API (4777) must never be exposed publicly.** It has no rate-limiting designed for internet traffic and its token is also used for internal MCP-to-bridge communication.

If you need ChatGPT or another remote MCP client to reach the server, expose only the MCP server (4779) through a tunnel and keep everything else local.

## Auth Tokens

Two separate tokens protect two separate surfaces:

### Bridge API token (`data/auth-token.txt`)

- Used by the dashboard and the MCP server (internally) when calling bridge-api.
- 256-bit cryptographically random, stored with mode 0600.
- Compared with `crypto.timingSafeEqual` to prevent timing attacks.
- Never logged to stdout.
- Rotatable via `POST /auth/rotate-token`.

### MCP remote token (`data/mcp-remote-token.txt`)

- Required on every `POST /mcp` or `POST /mcp/<token>` request (ChatGPT → MCP).
- Completely separate from the bridge API token. A leaked MCP token does not grant bridge API access.
- 256-bit cryptographically random, stored with mode 0600, never logged.
- Override at startup with `MCP_REMOTE_TOKEN=<value>` env var.
- Print the token: `pnpm token:mcp`
- Rotate (only if compromised): `pnpm token:mcp:rotate`
- **Do not rotate before every session** — rotation invalidates the ChatGPT config until you update it.

Two authentication modes are supported (both use the same token):

| Mode | How to use | For whom |
|---|---|---|
| Header auth | `Authorization: Bearer <token>` on `POST /mcp` | curl, programmatic clients |
| Path-token auth | `POST /mcp/<token>` with no auth header | ChatGPT (No Auth mode) |

## Ignore Rules and .bridgeignore

Ignore rules are a **convenience and safety filter**, not a replacement for path guards. They control which files appear in listings and block direct reads — but they run after path guards, so:

- Path traversal (`../../etc`) is still rejected by `resolveAndGuard()` before ignore rules are checked.
- Symlink escapes are still caught by `realpathSync` checks.
- Absolute paths are still rejected before ignore rules run.

Ignore rule priority (highest to lowest):

1. **Path guards** — `resolveAndGuard()`, symlink checks. Cannot be bypassed by any config.
2. **Default blocked globs** — hardcoded in `globFilter.ts`. Cannot be overridden.
3. **`.bridgeignore` patterns** — loaded from the workspace root. Additive only.
4. **Workspace `blockedGlobs`** — set at workspace registration time. Additive only.
5. **Workspace `allowedGlobs`** — whitelist. If set, file must match to be accessible.

### .bridgeignore

Each workspace can contain a `.bridgeignore` file at its root with one glob pattern per line (blank lines and `#` comments are ignored). These patterns are applied to every bridge operation:

- `list_files`, `list_tree`, `find_file`, `search_files` — ignored files/dirs are excluded from results.
- `read_file`, `read_file_range` — returns `Access denied: Blocked by .bridgeignore`.

**Important:** `.bridgeignore` patterns are additive. They cannot remove or weaken any built-in protection. A `.bridgeignore` entry of `!**/.env` does NOT allow `.env` files — negation patterns are not supported as overrides of default security rules.

Do not commit workspace-specific `.bridgeignore` files to this repository. Each user creates their own in their workspace root. See `.bridgeignore.example` for a generic template.

## Default Blocked Patterns

These patterns are blocked on every workspace regardless of workspace or `.bridgeignore` config:

```text
# Secrets and credentials
**/.env
**/.env.*
**/*.pem  **/*.key  **/*.p12  **/*.pfx
**/.ssh/**  **/id_rsa  **/id_ed25519
**/*.credentials  **/.aws/**  **/credentials  **/secrets/**

# Databases
**/*.sqlite  **/*.db  **/*.sqlite3

# Generic build/dependency/tool output
**/.git/**  **/node_modules/**
**/dist/**  **/build/**  **/coverage/**
**/.next/**  **/.nuxt/**  **/out/**
**/cache/**  **/.cache/**  **/.parcel-cache/**
**/.venv/**  **/venv/**  **/__pycache__/**
**/.turbo/**
```

Workspace `blockedGlobs` and `.bridgeignore` patterns are added on top of these defaults, never replacing them.

## Safe Mode (write tools disabled by default)

By default MCP starts in **safe mode**:

- `apply_pending_change` and `revert_change` are hidden from `tools/list`.
- Direct `tools/call` for those names returns a clear error.
- Read-only tools (`list_workspaces`, `list_files`, `search_files`, `read_file`, `preview_change`, `list_pending_changes`, `recent_changes`, `reject_pending_change`) work normally.

This means a compromised MCP token cannot write files without an explicit operator decision.

## Running the MCP Server

### Safe mode (read-only, default)

```sh
pnpm dev:mcp
```

File modification and shell tools are disabled by default. Direct calls to disabled tools are rejected by the server.

### Enable writes locally

```sh
MCP_ENABLE_WRITES=true pnpm dev:mcp
```

Write tools are enabled. Only do this when you trust all callers.

### Expose MCP through a tunnel

> **Warning:** Only expose port 4779. Never expose 4777 or 4778.

```sh
# Start MCP on localhost (default — safe mode)
pnpm dev:mcp

# Optional Tailscale Funnel: health-checks MCP/API and exposes only 4779
pnpm tunnel:tailscale
pnpm token:mcp
pnpm tunnel:tailscale:status
pnpm tunnel:tailscale:off

# In a separate terminal, open a tunnel to port 4779 only
cloudflared tunnel --url http://localhost:4779

# Print the token to put in ChatGPT
pnpm token:mcp
```

Tailscale Funnel is a public HTTPS endpoint. The `tunnel:tailscale` script uses `http://127.0.0.1:4779` as its only target and leaves the OpenAI tunnel setup unchanged. Keep the complete `/mcp/<token>` URL secret, use a dummy workspace for initial testing, and run `pnpm tunnel:tailscale:off` when you are done. If you start it on a nondefault port, keep the same `TAILSCALE_HTTPS_PORT` value set when you stop it.

### Connecting ChatGPT

ChatGPT's custom MCP connector only supports "No Auth" or OAuth — it cannot set a `Bearer` header. Use path-token auth instead:

1. Get your token: `pnpm token:mcp`
2. In ChatGPT → Settings → Connectors → Add custom MCP:
   - **Authentication**: No Auth
   - **Server URL**: `https://your-tunnel-domain/mcp/<your-mcp-remote-token>`
3. The token is embedded in the URL, so keep the Server URL secret.

The internal bridge API token (`data/auth-token.txt`) is **never** sent to ChatGPT.

### Intentionally enable remote writes (high risk)

```sh
MCP_HOST=0.0.0.0 MCP_ENABLE_WRITES=true MCP_ALLOW_REMOTE_WRITES=true pnpm dev:mcp
# (run "pnpm token:mcp" to get the token to give ChatGPT)
```

> **Strong warning:** Do not do this unless you fully trust all traffic reaching the tunnel. Any caller with the MCP token can write files on your machine. Rotate the token immediately if it is ever exposed.

## Startup Safety Guards

At startup the MCP server checks:

1. If `MCP_HOST` is `0.0.0.0` or any non-localhost value: prints a warning.
2. If exposed **and** the MCP auth token could not be loaded/generated: exits with error.
3. If exposed **and** `MCP_ENABLE_WRITES=true` **without** `MCP_ALLOW_REMOTE_WRITES=true`: exits with error.
4. If exposed **and** writes are allowed: prints a loud warning.

## Targeted Edits (preview_replace_range, preview_insert_before, preview_insert_after)

Targeted edit tools operate identically to `preview_change` from a security standpoint:

- Path guards (`resolveAndGuard`) run before any file access.
- Default blocked globs and `.bridgeignore` patterns are checked — blocked files are rejected.
- Binary files (null-byte detection) are rejected before computing a diff.
- No file is written at preview time. The only write path is `apply_pending_change`, which re-validates path and hash before writing.
- Every apply creates a backup in `data/backups/` and appends to `data/audit-log.jsonl`.
- No shell execution is involved.

## Terminal Execution

`run_terminal_command` is available whenever the bridge starts.

Commands:

- require a registered workspace and a guarded initial working directory inside it
- receive a minimal environment without inherited token, password, secret, or credential variables
- receive no interactive stdin
- apply the synchronous timeout and output caps from `TERMINAL_EXECUTION_POLICY`
- are recorded in the existing local audit log

Long-running commands use `start_terminal_command`, `get_terminal_command`, `renew_terminal_command`, and `stop_terminal_command`. They keep the same workspace, cwd, command-length, environment, output, audit, and process-tree controls. The requested process deadline and renewable supervisor lease are separate policy values; an unrenewed lease becomes `timed_out`, while a renewed job retains its stable job/process identity. State and bounded output are persisted for restart recovery and retained according to `TERMINAL_EXECUTION_POLICY`.

This boundary limits accidental scope; it is not an OS sandbox. The shell runs with the bridge user's authority, so commands can still use absolute paths, network access, or child programs. The MCP token and ChatGPT permission prompt remain authorization boundaries.

## Spreadsheet Actions

Spreadsheet actions accept only workspace-relative `.xlsx` paths. They reuse `checkGlobAccess()` and `resolveAndGuard()`; an absolute path or a workspace glob denial is rejected before the workbook is opened. MCP marks spreadsheet mutations destructive, so they use the existing ChatGPT permission prompt/approval flow; no spreadsheet-specific permission system or absolute-path bypass is added. `.xls`, `.ods`, and `.csv` are not implemented.

Writes optionally require the SHA-256 `baseHash` returned by `inspect_spreadsheet` or a read. A changed hash returns `concurrent_modification` instead of overwriting the newer file. The transaction reads the current bytes, validates the requested operation, creates the generic backup, writes a same-directory temporary file, atomically replaces the workbook, reopens and validates it, verifies the structured mutation, and then appends one `spreadsheet` audit entry. ZIP entry names are normalized once at the provider boundary; separators and dot segments are canonicalized, while absolute-looking, traversal-like, and colliding names are rejected. The generic `revert_change` endpoint can restore its backup.

The shared limits are 50 MiB per workbook, 10,000 cells per read, 2,000 rows per mutation, 200 search matches, and 100,000 scanned search cells. Failure responses include a normalized `code` such as `sheet_not_found`, `invalid_range`, `duplicate_key`, `concurrent_modification`, or `verification_failed`; raw provider details are not the primary state. For generic apply/revert results and audit entries, `newHash: null` means the resulting file is absent; the SHA-256 hash of empty bytes means a present zero-byte file.

## What Is Not Implemented

- No token rotation through MCP
- No editing `.env` or secret files through file tools
- No wildcard workspace roots
- No file-tool symlink following outside the workspace root

## Backup Integrity

Every file write:

1. Reads the current file content
2. Creates `data/backups/<timestamp>-<nanoId>/` with `meta.json` plus file copy
3. Writes the new content
4. Appends an audit entry

If the write fails partway through, the backup already exists and can be used for manual recovery.

## Community edition hardening
Set MCP_ENABLE_WRITES=true to enable file modifications. Set both MCP_ENABLE_WRITES=true and MCP_ENABLE_TERMINAL=true to enable shell commands. Tool visibility and direct invocation enforce these checks. A tunnel can expose even a localhost listener; do not assume localhost binding alone means remote clients cannot reach it.
