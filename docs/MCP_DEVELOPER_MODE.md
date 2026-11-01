# MCP Developer Mode Path

This repo supports a ChatGPT Developer Mode integration path through a local MCP adapter.

## Target flow

ChatGPT Developer Mode
-> public HTTPS tunnel or funnel
-> local `apps/mcp-server`
-> local `bridge-api` on `127.0.0.1:4777`
-> approved workspace files

The MCP server is adapter-only. It does not read or write workspace files directly. It forwards only allowlisted tool calls to bridge-api, which keeps the existing path guards, glob filters, pending-change flow, backups, and audit log.
When a tunnel is enabled, it must point only at the MCP server. Bridge-api and the dashboard stay localhost-only.

## Local ports

- `bridge-api`: `127.0.0.1:4777`
- `dashboard`: `127.0.0.1:4778`
- `mcp-server`: `127.0.0.1:4779`

No tunnel starts automatically. Choose and start one only when you intend to expose the MCP endpoint.

## Optional Tailscale HTTPS tunnel

The existing OpenAI Secure MCP Tunnel path can stay as the first choice when it is available. Tailscale Funnel is an opt-in HTTPS alternative; it sends the PC-side tunnel traffic through Tailscale instead of the OpenAI tunnel client.

Before using it, sign in to Tailscale on the PC and make sure Funnel, MagicDNS, and HTTPS certificates are enabled for the tailnet. The CLI may ask an administrator to enable Funnel in the tailnet policy.

Start the bridge services in separate terminals and confirm the local preflight before exposing anything:

```sh
corepack pnpm api
corepack pnpm mcp
corepack pnpm preflight:mcp
```

Then use these explicit controls:

```sh
corepack pnpm tunnel:tailscale
corepack pnpm tunnel:tailscale:status
corepack pnpm tunnel:tailscale:off
corepack pnpm token:mcp
```

The `on` command checks that both MCP and bridge-api are healthy, then asks Tailscale Funnel to serve `http://127.0.0.1:4779` over HTTPS on port 443. It never points Funnel at ports 4777 or 4778. Tailscale prints the public HTTPS hostname; use it with `/mcp/<MCP remote token>` in the ChatGPT connector. The token comes from this bridge (`pnpm token:mcp`), not from OpenAI.

The default HTTPS port is 443. If it is already in use, set `TAILSCALE_HTTPS_PORT` to an unused supported Funnel port. Tailscale allows HTTPS ports 443, 8443, and 10000, so check `tailscale funnel status` first and keep the same port selected when running `off`. For example, in PowerShell:

```powershell
$env:TAILSCALE_HTTPS_PORT = '10000'
corepack pnpm tunnel:tailscale
corepack pnpm tunnel:tailscale:status
corepack pnpm tunnel:tailscale:off
```

The tunnel runs in Tailscale's background mode and remains configured until you run the `off` command. Funnel URLs are public: anyone who gets the complete URL can reach the MCP endpoint, so use the existing MCP token and test with a dummy workspace first. The tunnel changes only the network route; it does not make ChatGPT features available in regions where they are otherwise unavailable, and Tailscale connectivity from a particular cloud region still needs to be confirmed.

## Allowed MCP tools

- `list_workspaces`
- `list_files`
- `search_files`
- `read_file`
- `preview_change`
- `list_pending_changes`
- `apply_pending_change`
- `reject_pending_change`
- `recent_changes`
- `revert_change`
- `run_terminal_command`
- `start_terminal_command`
- `get_terminal_command`
- `renew_terminal_command`
- `stop_terminal_command`

## Blocked in v1

- File-tool access outside registered workspaces
- Token rotation through MCP
- File-tool editing of `.env` or secrets

Terminal commands start in a registered workspace, but run as the local user and are not an OS sandbox. Only run the bridge while you trust the MCP client and token holders.

## Safety notes

- `preview_change` only creates a pending change first.
- `apply_pending_change` is a separate write step.
- All writes still go through backups and audit logging in bridge-api.
- The MCP adapter uses the local bridge token from `data/auth-token.txt` and refreshes it locally.
- The adapter strips sensitive absolute paths from tool responses where the ChatGPT side does not need them.

## What you do not need

- No OpenAI API key
- No OpenAI API billing
- No direct localhost access from ChatGPT

If OpenAI gates Developer Mode behind a paid ChatGPT plan on your account, that is a ChatGPT requirement rather than an OpenAI API requirement.

## Manual control only

Termux and Tailscale SSH stay available for manual control. They are not ChatGPT server-access paths.

## Alternate route

The existing OpenAPI / GPT Actions path still exists for the relay-based flow. See [docs/GPT_ACTION_SETUP.md](GPT_ACTION_SETUP.md) and [docs/LOCAL_RELAY_SIMULATION.md](LOCAL_RELAY_SIMULATION.md).
