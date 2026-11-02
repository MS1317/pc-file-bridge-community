# PC File Bridge

A local bridge for approved workspace files with two integration paths:

- MCP Developer Mode via `apps/mcp-server`
- OpenAPI / GPT Actions via the existing bridge-api + relay path

Both paths use the same safety layer: auth, path guards, glob filtering, pending-change preview, backups, audit log, and a local dashboard.

> Services listen locally by default. Tunneling the MCP endpoint exposes it to network clients; never expose the bridge API or dashboard.

## Community security defaults
**Read-only by default.** Use Dashboard → Access Control to enable file changes and terminal commands independently. Operations require local dashboard approval unless you explicitly disable approval. These policies are enforced by Bridge API, including direct requests from any MCP client.

The first time you configure local approvals, copy the separately generated credential from `data/local-admin-token.txt` into the dashboard. Do not share this credential with any MCP client. Operation requests expire after 10 minutes. Terminal commands are **not OS-sandboxed**, and run with your computer account privileges.

Compatible with **Claude, ChatGPT, and other clients supporting MCP over HTTP**. The client authenticates to the MCP server; approval is handled locally. When a tool returns `approvalRequired` and `approvalId`, approve it in the local dashboard and call `get_operation_approval` to fetch its result.

## Quick Start

### Prerequisites
- Node.js 18+
- pnpm (`npm install -g pnpm`)

### Install
```bash
cd pc-file-bridge-community
pnpm install
```

### Run the local UI path
```bash
pnpm dev
```

| Service | URL |
|---|---|
| Bridge API | http://127.0.0.1:4777 |
| Dashboard | http://127.0.0.1:4778 |

### Run the MCP path locally
```bash
pnpm dev:mcp
```

| Service | URL |
|---|---|
| MCP Server | http://127.0.0.1:4779/mcp |
| Bridge API | http://127.0.0.1:4777 |
| Dashboard | http://127.0.0.1:4778 |

### First run
1. The API generates a random auth token and saves it to `data/auth-token.txt`.
2. Open the dashboard at http://127.0.0.1:4778.
3. Paste the token when prompted.
4. Add a workspace on the Workspaces page.
5. Use the Files page to browse and read files.
6. Use Diff Preview to create a pending change before applying it.

For ChatGPT Developer Mode, keep `apps/mcp-server` in front of the same bridge-api. A public HTTPS tunnel or funnel is still required when ChatGPT needs to reach the MCP endpoint from outside your machine.

## Daily Usage

```bash
# Start the bridge (API + dashboard + MCP server)
corepack pnpm bridge:start

# Run preflight + typecheck + test + build (requires bridge:start servers running)
corepack pnpm bridge:check

# Kill any processes on bridge ports 4777 / 4778 / 4779
corepack pnpm bridge:stop

# Print the MCP remote token (used in ChatGPT server URL)
corepack pnpm token:mcp

# Rotate the MCP remote token (update ChatGPT config after)
corepack pnpm token:mcp:rotate
```

### ChatGPT setup

In ChatGPT → Developer Settings → MCP Servers:

| Field | Value |
|---|---|
| Authentication | No Auth |
| Server URL | `https://your-domain/mcp/<mcp-remote-token>` |

Get your token with `corepack pnpm token:mcp`.

### Normal edit flow

When you ask ChatGPT to edit a file:

1. ChatGPT calls `apply_change` → previews and writes in one step (one round trip over the tunnel). ChatGPT's own permission prompt fires.
2. You approve in the ChatGPT UI → change is written with backup + audit log

`apply_change` accepts an optional `baseHash` (from a prior `read_file`); the write is rejected if the file changed since, guarding against clobbering a concurrent edit.

Prefer `apply_change` for edits. The two-step `preview_change` → `apply_pending_change` flow still exists for when you want to inspect the diff before applying — both share the same backup, audit log, path guards, and glob filters. ChatGPT's permission prompt is the approval step either way; you do not need to type "apply" separately. Writes only happen inside registered workspaces.

### Spreadsheet actions

For `.xlsx` workbooks, use the spreadsheet tools instead of `run_terminal_command` or `read_file`:

- `inspect_spreadsheet` — sheets, used ranges, dimensions, named ranges, metadata, and current hash
- `read_spreadsheet_range` — structured raw/display values and formulas
- `search_spreadsheet` — typed exact/contains search, optionally limited to a header column
- `append_spreadsheet_rows` — dynamic append after the current used rows
- `update_spreadsheet_range` — dimension-checked range writes
- `update_spreadsheet_rows_by_key` — generic header/key update
- `upsert_spreadsheet_rows` — update unique matches and append missing keys
- `create_spreadsheet` and `create_spreadsheet_sheet`

Only `.xlsx` is supported. Spreadsheet writes use the registered workspace and its existing glob/path authorization, optional `baseHash` concurrency protection, the shared backup/audit/revert path, same-directory atomic replacement, and read-after-write verification. Limits are defined once in the shared contract: 50 MiB workbooks, 10,000 returned cells, 2,000 mutation rows, 200 search results, and 100,000 scanned search cells.

The XLSX provider edits only the required worksheet/workbook XML and carries all other ZIP package parts through unchanged, so unrelated formulas, styles, panes, drawings, relationships, metadata, and defined names are not rewritten by cell updates. ZIP entry names are canonicalized at the provider boundary (`/` is the internal separator); unsafe paths and canonical collisions fail as `workbook_invalid`. Unsupported formats such as `.xls`, `.ods`, and `.csv` fail with a normalized typed failure.

### Terminal commands

The `run_terminal_command` tool requires a registered `workspaceId`, starts in that workspace (or an existing `relativeCwd` inside it), ignores stdin, strips secret-bearing inherited environment variables, applies the synchronous limits in `TERMINAL_EXECUTION_POLICY`, caps output, and records the command and outcome in the audit log. For longer work, `start_terminal_command` returns stable `jobId`, `leaseId`, and eventual process identity; poll it with `get_terminal_command`, renew ownership with `renew_terminal_command`, and stop it with `stop_terminal_command`. The requested process lifetime is separate from the bounded renewable supervisor lease, and persisted job state survives API restarts.

The tool is controlled in Dashboard → Access Control, with a local approval queue. It is not an OS sandbox: commands run as your local user and can access anything that user can access. Only run the bridge while you trust the MCP client and every holder of the MCP URL token.

### Targeted edits (line-based)

For large files where replacing the whole content is imprecise, three targeted edit tools are available:

| Tool | What it does |
|---|---|
| `preview_replace_range` | Replace lines `startLine`–`endLine` (1-indexed, inclusive) with new content |
| `preview_insert_before` | Insert content before a specific line |
| `preview_insert_after` | Insert content after a specific line |

All three create a pending change (same as `preview_change`) — no file is touched until `apply_pending_change` is called. The same backup, audit log, and approval flow applies.

Workflow:
1. Use `read_file_range` to confirm exact line numbers
2. Call `preview_replace_range` / `preview_insert_before` / `preview_insert_after`
3. Call `apply_pending_change` with the returned `pendingChangeId`

## Scripts

| Command | Description |
|---|---|
| `pnpm bridge:start` | Start bridge (API + dashboard + MCP server) |
| `pnpm bridge:check` | Preflight + typecheck + test + build |
| `pnpm bridge:stop` | Kill processes on bridge ports 4777/4778/4779 |
| `pnpm token:mcp` | Print MCP remote token |
| `pnpm token:mcp:rotate` | Rotate MCP remote token |
| `pnpm dev` | Run API + dashboard |
| `pnpm dev:mcp` | Run API + dashboard + MCP server |
| `pnpm mcp` | Run MCP server only |
| `pnpm api` | Run API only |
| `pnpm ui` | Run dashboard only |
| `pnpm typecheck` | TypeScript check all packages |
| `pnpm test` | Run security unit tests |
| `pnpm build` | Build all packages |

## Workspace Ignore File (.bridgeignore)

Each workspace can have a `.bridgeignore` file at its root to exclude project-specific directories and files from all bridge operations (listing, searching, reading, tree navigation).

```
# .bridgeignore — placed in your workspace root
# One glob pattern per line. # comments and blank lines are ignored.

my-output-dir/**
generated/**
*.log
```

Rules in `.bridgeignore` are applied **in addition to** built-in security defaults — they cannot remove built-in protections like `.env`, `.git`, or `node_modules` blocking.

If a file is excluded by `.bridgeignore`, direct `read_file` and `read_file_range` calls will return `Access denied: Blocked by .bridgeignore`.

**Built-in generic skips** (no configuration needed):

| Directory | Reason |
|---|---|
| `node_modules`, `.git` | Dependencies / version control |
| `dist`, `build`, `out` | Generic build output |
| `coverage`, `.next`, `.nuxt` | Test/framework output |
| `cache`, `.cache`, `.parcel-cache` | Tool caches |
| `.venv`, `venv`, `__pycache__` | Python environments |
| `.turbo` | Turborepo cache |

Copy `.bridgeignore.example` from the project root to your workspace root as `.bridgeignore` for a commented starting point.

## Auth Token

On first run, `data/auth-token.txt` is created with a 64-char hex token.

- Include it in every bridge-api request as `Authorization: Bearer <token>`
- The dashboard stores it in browser localStorage
- The MCP server reads the same local token file when it calls bridge-api

## Workspace Registry

Workspaces live in `data/workspaces.json`.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the current architecture.
See [docs/MCP_DEVELOPER_MODE.md](docs/MCP_DEVELOPER_MODE.md) for the MCP-first path.
See [docs/GPT_ACTION_SETUP.md](docs/GPT_ACTION_SETUP.md) for the alternate OpenAPI / GPT Actions path.

## Security

See [docs/SECURITY.md](docs/SECURITY.md) for the threat model and security decisions.

## API Reference

See [docs/API.md](docs/API.md) for the bridge-api endpoints.
