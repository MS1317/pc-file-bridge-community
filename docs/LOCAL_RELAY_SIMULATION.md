# Local Relay Simulation (Stage 2A)

This document explains how to run the full ChatGPT→relay→PC flow **entirely on localhost** for development and testing. Nothing is exposed to the internet.

---

## What's running

| Process | Port | Purpose |
|---------|------|---------|
| `bridge-api` | `127.0.0.1:4777` | Actual file operations on registered workspaces |
| `relay-server` | `127.0.0.1:4888` | Simulates the future cloud relay |
| `bridge-agent` | (no port) | Outbound WS to relay; forwards requests to bridge-api |

---

## Architecture (localhost simulation)

```
[Test client / curl / future GPT Action]
         │  POST /gpt/request  (Bearer: relay client token)
         ▼
  relay-server  127.0.0.1:4888
         │  WebSocket ws://127.0.0.1:4888/device
         ▼
  bridge-agent  (no inbound port)
         │  HTTP  127.0.0.1:4777  (Bearer: local bridge token — NEVER sent to relay)
         ▼
  bridge-api  127.0.0.1:4777
         │  filesystem
         ▼
  Registered workspace files
```

Three auth layers:

1. **GPT→relay**: `Authorization: Bearer <relay-client-token>` (relay knows this)
2. **agent→relay**: HMAC-SHA256 device auth (relay knows `deviceId` + `deviceSecret`)
3. **agent→bridge-api**: `Authorization: Bearer <local-bridge-token>` (**relay never sees this**)

---

## Quick start

### Terminal 1 — bridge-api
```sh
pnpm api
# Note the token printed at startup (or read data/auth-token.txt)
```

### Terminal 2 — relay-server
```sh
# First run: let it generate a relay-client-token, then register your agent device
AGENT_DEVICE_ID=<from agent startup> \
AGENT_DEVICE_SECRET=<from data/agent/device-credentials.json> \
pnpm relay
```

### Terminal 3 — bridge-agent
```sh
BRIDGE_TOKEN=<from bridge-api startup or data/auth-token.txt> \
pnpm agent
```

### Startup order
Start bridge-api first so the agent can immediately check health. Start relay-server before the agent so the WebSocket is available.

---

## One-command dev mode

```sh
# Requires BRIDGE_TOKEN env var set first
BRIDGE_TOKEN=<token> \
AGENT_DEVICE_ID=<id> \
AGENT_DEVICE_SECRET=<secret> \
pnpm dev:relay-local
```

---

## Testing the relay

Check relay health:
```sh
curl http://127.0.0.1:4888/health
```

Check connected devices:
```sh
curl http://127.0.0.1:4888/devices
```

Send a request through the relay (simulates GPT Action):
```sh
curl -X POST http://127.0.0.1:4888/gpt/request \
  -H "Authorization: Bearer <relay-client-token>" \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"<your-device-id>","operation":"workspaces.list"}'
```

Preview a file change:
```sh
curl -X POST http://127.0.0.1:4888/gpt/request \
  -H "Authorization: Bearer <relay-client-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "deviceId":"<your-device-id>",
    "operation":"changes.preview",
    "body":{
      "workspaceId":"<workspace-id>",
      "relativePath":"README.md",
      "newContent":"# New content\n",
      "reason":"Test change via relay"
    }
  }'
```

---

## Security properties verified in this simulation

| Property | How |
|----------|-----|
| Local bridge token never sent to relay | Agent reads `BRIDGE_TOKEN` env var; relay never receives it |
| Operations allowlisted at both relay and agent | `ALLOWED_OPERATIONS` checked twice |
| Replay attacks blocked | Agent tracks seen `requestId` values for 2 minutes |
| Method/path tampering caught | Agent validates `operation` spec matches `method`+`path` |
| Stale requests rejected | Agent rejects requests >30s old |
| Device heartbeat | Agent pings relay every 15s; relay marks device offline after 90s |
| HMAC device auth | Relay verifies HMAC-SHA256 signature on connect |
| Nonce replay on WS auth | Relay tracks seen nonces for 2 minutes |

---

## What Stage 2B will add

- Deploy relay-server to a cloud host (Cloudflare Worker, Railway, Fly.io)
- Configure a Custom GPT Action pointing at the cloud relay URL
- TLS everywhere (HTTPS/WSS)
- Per-user session pairing (device code flow)
- Persistent device registration (database instead of env vars)

None of those changes affect the bridge-api or bridge-agent security model.

---

## Troubleshooting

**Agent says `auth_fail: Invalid signature`**
- Check `AGENT_DEVICE_ID` and `AGENT_DEVICE_SECRET` match the values in `data/agent/device-credentials.json`
- The relay-server must have those values set via `AGENT_DEVICE_ID`/`AGENT_DEVICE_SECRET` env vars

**Relay returns `DEVICE_OFFLINE`**
- The agent is not connected or its heartbeat timed out (>90s since last heartbeat)
- Check `curl http://127.0.0.1:4888/devices` to see device status

**`504 Device timed out`**
- The bridge-api is not responding; check `pnpm api` terminal
- Verify `BRIDGE_TOKEN` is correct

**`401 Unauthorized` on `/gpt/request`**
- The relay client token in your curl request doesn't match `RELAY_CLIENT_TOKEN`
- Copy the full token printed at relay-server startup
