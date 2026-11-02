# Connecting AI clients

PC File Bridge is an MCP server, not a ChatGPT-only extension. It can be used with Claude, ChatGPT, and other clients that support MCP over HTTP.

## Start locally

1. Install dependencies: `corepack pnpm install --frozen-lockfile`.
2. Start the local API, dashboard and MCP server: `corepack pnpm dev:mcp`.
3. Open the dashboard at http://127.0.0.1:4778.
4. Enter the bridge API token when prompted, then navigate to **Access Control**.
5. Copy the on-device administrator credential from `data/local-admin-token.txt` into the Access Control screen. Never share it with an AI client.
6. Enable **File modifications** and/or **Terminal commands**. Keep **Require local approval** enabled for untrusted clients.

The local HTTP endpoint is `http://127.0.0.1:4779/mcp`. Connectors hosted in the cloud cannot reach it directly.

## Claude (remote MCP connector)

Claude supports remote Streamable HTTP MCP. According to Anthropic's current guidance, in Claude choose **Customize > Connectors > Add custom connector** (the UI may vary), supply the publicly reachable HTTPS MCP URL, and configure its bearer token using the connector's **Request headers** settings. For a client unable to send a bearer header, the server also supports a token-in-URL compatibility path; protect that URL against logging and sharing.

If your bridge is on your own PC, expose **only** the MCP port via a TLS-protected tunnel. Never expose the dashboard or Bridge API.

Anthropic documentation:
- https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
- https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities

## ChatGPT and other MCP clients

Connect using a Streamable HTTP MCP endpoint with the remote token, or your client's supported authentication setup. The same server tools and access-control rules apply regardless of the model or client.

## Local approvals

An edit or terminal tool can return an `approvalRequired` response with an `approvalId`.

1. Review its **exact submitted payload** in the local Access Control dashboard.
2. Approve or reject. Approvals are one-use and expire after 10 minutes.
3. Ask the client to call `get_operation_approval` with that ID to retrieve final status and the execution result. Approvals can be lost on Bridge API restart.
4. If the feature is disabled, the API rejects the operation before execution.

Security notes: terminal execution is **not sandboxed**; it runs with the PC user's permissions. The administrator credential is distinct from the MCP token and is never needed by an AI client. The dashboard restricts policy changes and approval actions to the local browser and administrator credential.
