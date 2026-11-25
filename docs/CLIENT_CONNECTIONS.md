# Connecting AI clients

PC File Bridge is an MCP server over HTTP. Any client that supports it can connect. Before you start, follow the [quick start](../README.md#quick-start) so that `pnpm preflight:mcp` passes.

You need two things:

- **URL:** `http://127.0.0.1:4779/mcp` on the same PC, or `https://YOUR_HOST/mcp` through a tunnel
- **Token:** printed by `pnpm token:mcp`

Two ways to send the token:

| Method | Use it when |
|---|---|
| Header `Authorization: Bearer YOUR_MCP_TOKEN` on `/mcp` | The client can set headers. Preferred. |
| Token in the URL: `/mcp/YOUR_MCP_TOKEN` | The client cannot set headers. The whole URL is then a secret. |

Never give a client `data/auth-token.txt` or `data/local-admin-token.txt`.

## Claude Code

Same PC:

```bash
claude mcp add --transport http pc-file-bridge http://127.0.0.1:4779/mcp --header "Authorization: Bearer YOUR_MCP_TOKEN"
```

Another computer or a phone, after setting up [remote access](#remote-access):

```bash
claude mcp add --transport http pc-file-bridge https://YOUR_HOST/mcp --header "Authorization: Bearer YOUR_MCP_TOKEN"
```

Add `--scope user` to make it available in every project. Check it with `claude mcp list`, or `/mcp` inside Claude Code.

To keep the token out of your shell history, put it in a file that only you can read and substitute it:

```bash
claude mcp add --transport http pc-file-bridge https://YOUR_HOST/mcp --header "Authorization: Bearer $(cat ~/.pc-bridge-token)"
```

### Claude Code in Termux (Android)

Install Claude Code inside a Linux distribution in Termux (for example Ubuntu through `proot-distro`), then run the remote command above there. `pkg` works only in Termux itself, not inside the distribution. A phone always needs [remote access](#remote-access), because `127.0.0.1` on the phone is the phone.

## Claude (web, desktop and mobile)

Claude connects from Anthropic's servers, so it needs [remote access](#remote-access). Choose **Customize → Connectors → Add custom connector**, enter `https://YOUR_HOST/mcp`, and set the bearer token under **Request headers**. If your plan or app does not offer request headers, use the token-in-URL form. Menu names can change:

- https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
- https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities

## ChatGPT

ChatGPT also connects from the internet, so it needs [remote access](#remote-access). In developer mode, add a custom MCP connector with:

| Field | Value |
|---|---|
| Authentication | No Auth |
| Server URL | `https://YOUR_HOST/mcp/YOUR_MCP_TOKEN` |

Availability depends on your ChatGPT plan and region. More in [MCP_DEVELOPER_MODE.md](MCP_DEVELOPER_MODE.md).

## Other clients

Use the Streamable HTTP transport with the URL and header above. The server answers `POST` with JSON. It does not open a server-sent event stream, so `GET /mcp` returns 405, which the MCP specification allows.

## Remote access

Expose **only port 4779**, and only over HTTPS. Anyone who has the URL and the token can use every capability you enabled, so start with writes and terminal off.

### Tailscale Funnel

1. Install Tailscale on the PC and sign in. Enable Funnel, MagicDNS and HTTPS certificates for your tailnet. The client device does not need Tailscale.
2. With the bridge running:

   ```bash
   pnpm preflight:mcp
   pnpm tunnel:tailscale
   ```

3. Tailscale prints `https://YOUR_HOST`. Your MCP URL is that plus `/mcp`.
4. Stop publishing with `pnpm tunnel:tailscale:off`.

Funnel keeps its setting across restarts, but the bridge does not start by itself. See [Start at sign-in](../README.md#start-at-sign-in). The command refuses a port that Tailscale already uses for another app. If 443 is taken, set `TAILSCALE_HTTPS_PORT` to `8443` or `10000` for both `on` and `off`.

### Other tunnels

Any HTTPS tunnel works if it points at `http://127.0.0.1:4779`, for example `cloudflared tunnel --url http://127.0.0.1:4779`. The [tunnel checklist](TUNNEL_TEST_CHECKLIST.md) lists what to verify first.

## Approvals

If **Require local approval** is on, a write or command returns `approvalRequired` with an `approvalId`.

1. Review the exact payload under **Access Control** on the PC.
2. Approve or reject it within 10 minutes. Each approval works once.
3. Ask the client to call `get_operation_approval` with that ID to get the result.

Approval is off by default. Turn it on for clients you do not fully trust. Pending approvals are lost when the Bridge API restarts.
