# Architecture

## Preferred: MCP Developer Mode

```
ChatGPT Developer Mode
  -> public HTTPS tunnel or funnel
  -> apps/mcp-server (local adapter only)
  -> bridge-api on 127.0.0.1:4777
  -> approved workspace files
```

The MCP server is an adapter. It does not bypass bridge-api, and it does not touch workspace files directly.
Only the MCP endpoint is eligible for tunneling later; bridge-api and the dashboard stay localhost-only.

## Alternate: OpenAPI / GPT Actions

The existing relay simulation and OpenAPI docs remain available for the non-MCP path:

- `docs/GPT_ACTION_SETUP.md`
- `docs/LOCAL_RELAY_SIMULATION.md`

## Current: Localhost MVP

```
┌─────────────────────────────────────────────────────────┐
│                    Your PC (localhost)                   │
│                                                          │
│  ┌──────────────┐    HTTP     ┌───────────────────────┐  │
│  │   Dashboard  │ ──────────► │    Bridge API         │  │
│  │  (React/Vite)│             │  (Fastify :4777)      │  │
│  │   :4778      │ ◄────────── │                       │  │
│  └──────────────┘    JSON     │  ┌─────────────────┐  │  │
│                               │  │  @bridge/core   │  │  │
│                               │  │  - pathGuard    │  │  │
│                               │  │  - globFilter   │  │  │
│                               │  │  - changeService│  │  │
│                               │  │  - auditLog     │  │  │
│                               │  └────────┬────────┘  │  │
│                               └───────────┼───────────┘  │
│                                           │              │
│                    ┌──────────────────────▼──────────┐   │
│                    │          data/                  │   │
│                    │  workspaces.json                │   │
│                    │  audit-log.jsonl                │   │
│                    │  auth-token.txt                 │   │
│                    │  backups/<id>/                  │   │
│                    └─────────────────────────────────┘   │
│                                                          │
│  ┌──────────────────────────────────────────────────┐    │
│  │               Workspace Files                    │    │
│  │  C:\Users\developer\Desktop\Dev\Weehzi\...           │    │
│  │  C:\Users\developer\Desktop\Dev\OtherProject\...     │    │
│  └──────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

## Future: Cloud Relay + ChatGPT Mobile

When you're ready to connect ChatGPT mobile, the architecture extends like this:

```
┌─────────────────────────────────────────────────────────┐
│  ChatGPT Mobile App                                      │
│  (Custom GPT with Actions)                              │
└────────────────────────┬────────────────────────────────┘
                         │ HTTPS
                         ▼
┌─────────────────────────────────────────────────────────┐
│  Cloud Relay Server  (e.g. Cloudflare Worker / Railway) │
│                                                          │
│  - Authenticates the ChatGPT request                    │
│  - Forwards to your PC via WebSocket tunnel             │
│  - Does NOT store file contents                         │
│  - Rate-limits to prevent abuse                         │
└────────────────────────┬────────────────────────────────┘
                         │ WebSocket (outbound from your PC)
                         ▼
┌─────────────────────────────────────────────────────────┐
│  Your PC                                                │
│                                                          │
│  Bridge API (same code as today)                        │
│  + WebSocket client that connects OUT to cloud relay    │
│    (no inbound ports needed)                            │
└─────────────────────────────────────────────────────────┘
```

### Key design principle
Your PC always initiates the outbound WebSocket connection to the cloud relay.
This means:
- No open inbound firewall ports
- No port forwarding
- The cloud relay cannot initiate requests — it only forwards what your PC subscribes to receive

### What does NOT change when adding cloud relay
- All security logic stays in `@bridge/core` — path guard, glob filter, backups, audit log
- Workspace registry stays on your PC
- File contents never pass through the cloud relay unencrypted
- Auth token stays local; a separate relay token is used for cloud auth

## Package Structure

```
packages/shared   → TypeScript types shared by all packages
packages/core     → Security logic, file operations, workspace registry
apps/bridge-api   → Fastify HTTP server (current entry point)
apps/mcp-server   → MCP adapter that forwards to bridge-api
apps/dashboard    → React/Vite local dashboard
```

Spreadsheet flow:

```
MCP spreadsheet tool
  -> shared spreadsheet request/schema contract
  -> bridge-api /spreadsheets/:action
  -> SpreadsheetService (workspace guard, hash, backup, atomic write, audit, verify)
  -> XlsxSpreadsheetProvider (minimal ZIP/OpenXML mutation)
```

The shared contract owns the `.xlsx` format list, range parser, cell/row values, limits, failure kinds, and MCP tool schemas. The provider canonicalizes ZIP package entry names once at ingestion, rejects unsafe/colliding names, and preserves untouched OpenXML package parts; adding another format requires a provider rather than another tool policy or path system.

Future additions (not yet implemented):
```
apps/relay-client → WebSocket client that bridges local API to cloud relay
apps/relay-server → Cloud relay server (deploy separately)
```
