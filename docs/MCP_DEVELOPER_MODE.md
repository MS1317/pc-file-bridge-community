# MCP server reference

Setup steps for each client are in [CLIENT_CONNECTIONS.md](CLIENT_CONNECTIONS.md). This page covers how the MCP server behaves.

```
MCP client
  -> HTTPS tunnel (only for remote clients)
  -> apps/mcp-server   127.0.0.1:4779
  -> bridge-api        127.0.0.1:4777
  -> registered workspace folders
```

The MCP server is an adapter. It never touches workspace files. It forwards a fixed set of tools to the Bridge API, which enforces workspaces, path rules, permissions, approvals, backups and the audit log.

## Endpoints

| Request | Auth | Purpose |
|---|---|---|
| `POST /mcp` | `Authorization: Bearer <token>` | JSON-RPC |
| `POST /mcp/<token>` | Token in the path | JSON-RPC for clients that cannot set headers |
| `GET /health` | None | Status, and whether the Bridge API is reachable |

Supported methods: `initialize`, `ping`, `tools/list`, `tools/call`. Notifications get `202`. `GET /mcp` returns `405`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `MCP_HOST` | `127.0.0.1` | Listen address. Any other value prints a warning. Prefer a tunnel. |
| `MCP_PORT` | `4779` | Listen port. The preflight and tunnel scripts assume 4779. |
| `BRIDGE_API_URL` | `http://127.0.0.1:4777` | Where the Bridge API runs |
| `MCP_REMOTE_TOKEN` | from `data/mcp-remote-token.txt` | Overrides the stored token |

Permissions are **not** set with environment variables. Use **Dashboard → Access Control**.

## Tools

All 33 tools are always listed so that clients do not need to reconnect when you change a permission. The Bridge API rejects a disabled tool when it is called. The [README](../README.md#tools) lists every tool.

Not available through MCP: registering or removing workspaces, changing permissions, approving operations, and rotating tokens.

## Tailscale Funnel details

`pnpm tunnel:tailscale` refuses to start unless the MCP server and Bridge API are healthy and the port is not used by another Tailscale app, then runs `tailscale funnel` for `http://127.0.0.1:4779` only. It stays on until you run `pnpm tunnel:tailscale:off`. `TAILSCALE_HTTPS_PORT` accepts 443, 8443 or 10000, and must have the same value for `on` and `off`:

```powershell
$env:TAILSCALE_HTTPS_PORT = '10000'
pnpm tunnel:tailscale
pnpm tunnel:tailscale:off
```
