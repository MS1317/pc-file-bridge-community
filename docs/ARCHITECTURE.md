# Architecture

```
 MCP client (Claude, ChatGPT, ...)
        |  HTTP, or HTTPS through a tunnel
        v
 +---------------------------- your PC -----------------------------+
 |  mcp-server :4779                        dashboard :4778         |
 |  adapter, fixed tool list                React / Vite            |
 |        |  bearer token                        |                  |
 |        +------------------+-------------------+                  |
 |                           v                                      |
 |                    bridge-api :4777                              |
 |         auth, permissions, approvals, rate limit                 |
 |                           |                                      |
 |                     @bridge/core                                 |
 |   path guard, file rules, changes, terminal, spreadsheets        |
 |               |                          |                       |
 |               v                          v                       |
 |     registered workspaces        data/ (tokens, policy,          |
 |     C:\path\to\MyProject          backups, audit log)            |
 +------------------------------------------------------------------+
```

The Bridge API is the only process that touches workspace files. The MCP server and the dashboard are both its clients.

## Packages

| Path | Role |
|---|---|
| `packages/shared` | Types, spreadsheet contract, relay protocol, limits |
| `packages/core` | File rules, changes, backups, audit log, terminal jobs, spreadsheets |
| `apps/bridge-api` | Fastify API, permissions and approvals |
| `apps/mcp-server` | MCP adapter over HTTP |
| `apps/dashboard` | Local React dashboard |
| `apps/relay-server`, `apps/bridge-agent` | Experimental relay, localhost only |

The apps import `@bridge/shared` and `@bridge/core` from their compiled `dist/`. The root start, test and typecheck scripts run `build:packages` first.

## How a path is checked

`resolveWorkspacePath()` in `packages/core/src/workspaceAccess.ts` is the single entry point for file tools. It applies the rules to the requested path, resolves and guards it, then applies the rules again to the canonical path on disk. `WorkspaceRegistry.get()` adds the bridge's own `data/` directory to the blocked patterns.

## How a write is gated

A Fastify hook in `apps/bridge-api/src/server.ts` looks at the **matched route**. Write and terminal routes go through `AccessControl.submit()`, which rejects them, runs them, or queues them for approval. Approved operations are re-sent internally with a key that exists only in that process.

## Terminal jobs

`start_terminal_command` launches a detached worker. The worker is the only writer of the job's `state.json` while it runs. The API writes `control.json` (lease, stop request, worker PID). If the worker disappears without saving a result, the API marks the job `worker_lost`.

## Spreadsheets

```
MCP tool -> shared contract -> POST /spreadsheets/:action
  -> SpreadsheetService (rules, hash, backup, atomic write, audit, verify)
  -> XlsxSpreadsheetProvider (minimal ZIP/OpenXML changes)
```

## Experimental relay

The relay would let a PC dial out instead of using a tunnel. Today it runs on localhost only. See [LOCAL_RELAY_SIMULATION.md](LOCAL_RELAY_SIMULATION.md) and the design notes in [RELAY_PLAN.md](RELAY_PLAN.md).
