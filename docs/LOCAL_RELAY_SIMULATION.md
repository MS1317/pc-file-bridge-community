# Local relay simulation (experimental)

Runs the relay flow on localhost for development. Nothing is exposed to the internet, and MCP does not need it.

| Process | Address | Purpose |
|---|---|---|
| `bridge-api` | `127.0.0.1:4777` | File operations |
| `relay-server` | `127.0.0.1:4888` | Stands in for a future cloud relay |
| `bridge-agent` | No port | Connects out to the relay and forwards requests to `bridge-api` |

```
client -> POST /gpt/request -> relay-server <- WebSocket - bridge-agent -> bridge-api
```

The relay never receives the Bridge API token.

## Run it

Use three terminals. The examples are PowerShell. In bash, replace `$env:NAME = 'value'` with `export NAME=value`.

**1. Bridge API**

```powershell
pnpm api
```

**2. Agent.** Start it once so it creates `data/agent/device-credentials.json`. It prints connection errors until the relay is up, and reconnects by itself.

```powershell
$env:BRIDGE_TOKEN = (Get-Content data/auth-token.txt -Raw).Trim()
pnpm agent
```

**3. Relay**, with the credentials from that file:

```powershell
$device = Get-Content data/agent/device-credentials.json -Raw | ConvertFrom-Json
$env:AGENT_DEVICE_ID = $device.deviceId
$env:AGENT_DEVICE_SECRET = $device.deviceSecret
pnpm relay
```

The relay saves its client token in `data/relay-client-token.txt`. Set `RELAY_CLIENT_TOKEN` to use your own.

## Try it

```powershell
$token = (Get-Content data/relay-client-token.txt -Raw).Trim()
$headers = @{ Authorization = "Bearer $token" }

Invoke-RestMethod http://127.0.0.1:4888/health
Invoke-RestMethod http://127.0.0.1:4888/devices -Headers $headers
Invoke-RestMethod http://127.0.0.1:4888/gpt/request -Method Post -Headers $headers -ContentType application/json `
  -Body (@{ deviceId = $device.deviceId; operation = 'workspaces.list' } | ConvertTo-Json)
```

Only `/health` works without the client token.

## What it checks

| Property | How |
|---|---|
| Only known operations | Allowlist on the relay and again on the agent |
| Device identity | HMAC-SHA256 signature, with nonce replay protection |
| Stale or replayed requests | The agent rejects old requests and repeated request IDs |
| Device offline | Heartbeat |

## Troubleshooting

| Message | Cause |
|---|---|
| `auth_fail: Invalid signature` | The relay's `AGENT_DEVICE_ID` or `AGENT_DEVICE_SECRET` does not match `data/agent/device-credentials.json` |
| `DEVICE_OFFLINE` | The agent is not connected |
| `DEVICE_TIMEOUT` | `bridge-api` is down, or `BRIDGE_TOKEN` is wrong |
| `401 Unauthorized` | The client token does not match `data/relay-client-token.txt` |
