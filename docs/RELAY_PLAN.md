# Relay Plan — Stage 2 Architecture

> Stage 1.5 is localhost-only hardening. This document describes Stage 2: making the bridge reachable from ChatGPT mobile without exposing inbound ports.

---

## Full Architecture

```
ChatGPT Mobile / Web
    │  HTTPS
    ▼
Custom GPT Action
    │  HTTPS (Bearer token)
    ▼
Cloud Relay
(e.g. Cloudflare Worker, Railway, Fly.io)
    │  WebSocket (outbound from PC)
    ▼
PC Bridge Agent (new small process)
    │  localhost HTTP
    ▼
Bridge API  http://127.0.0.1:4777
    │  filesystem
    ▼
Registered workspace files
```

---

## Why outbound-only is safer

Your PC dials **out** to the relay over WebSocket or SSE. The relay never dials in. This means:

- No inbound firewall rules needed
- No open ports on the home router
- If the relay is taken down or compromised, the PC is unreachable
- The PC can disconnect at any time and ChatGPT simply gets "device unavailable"

---

## What the relay is allowed to do

- Accept authenticated requests from the GPT Action
- Forward the request JSON to the PC over the outbound connection
- Return the PC's response to ChatGPT
- Track active device connections (heartbeat)
- Enforce per-user rate limiting

## What the relay must never do

- Store file content or workspace data
- Modify requests in transit
- Accept requests without a valid session token
- Allow connections from unidentified PCs
- Execute commands on the PC beyond what the bridge API supports
- Forward requests if the PC hasn't sent a heartbeat recently

---

## Session pairing concept

1. The user opens the PC Bridge Agent (a small CLI or tray app)
2. The agent generates a session token and connects to the relay via WebSocket
3. The relay issues a short-lived session URL or code
4. The user pastes the session code into the Custom GPT configuration (or into the chat)
5. ChatGPT's GPT Action uses that session to route requests to the correct PC

Session codes expire after a configurable TTL (e.g. 24 hours). The agent reconnects automatically.

---

## Device heartbeat

The PC bridge agent sends a heartbeat to the relay every 30 seconds.

If the relay does not receive a heartbeat for 90 seconds:
- New requests from ChatGPT get `{ "ok": false, "error": "Device offline" }` immediately
- No requests are queued — the user must re-open the bridge agent

This ensures ChatGPT never hangs waiting for a disconnected PC.

---

## Device unavailable behavior

When the PC is offline, the relay returns:

```json
{ "ok": false, "error": "PC bridge is offline. Open the bridge agent on your PC.", "code": "DEVICE_OFFLINE" }
```

ChatGPT should surface this to the user naturally, e.g.:
> "Your PC bridge is not connected right now. Please open the bridge agent and try again."

---

## Request signing (Stage 2 hardening)

Each request from the relay to the PC bridge should include:

- `X-Relay-Request-Id`: unique per-request nonce
- `X-Relay-Timestamp`: Unix epoch seconds
- `X-Relay-Signature`: HMAC-SHA256 of `requestId + timestamp + body`, signed with a shared relay↔PC secret

The PC bridge verifies the signature before processing. This prevents:
- Replay attacks (reject if timestamp is >60s old)
- Forged requests from a compromised relay transport layer

---

## Replay protection

The bridge keeps a short-lived set of seen `requestId` values (60-second window). Any request with a duplicate `requestId` is rejected with `409 Conflict`.

---

## Audit logging

Every request that results in a file write is already appended to `data/audit-log.jsonl`. For Stage 2, add:

- `relayRequestId` field on each audit entry
- `sessionId` field linking to the device session
- Alert if more than N writes occur in a 5-minute window (configurable threshold)

---

## Approval requirements in Stage 2

The `writeMode: "approval_required"` workspace setting is mandatory for remote access. Auto-apply should be disabled for any workspace accessible via the relay. The bridge should enforce this:

```
if (source === 'relay' && workspace.writeMode === 'auto_apply') {
  throw new Error('auto_apply workspaces are not accessible via relay');
}
```

The dashboard shows a visual warning if a workspace is set to `auto_apply` while relay mode is enabled.

---

## Implementation checklist for Stage 2

- [ ] Build relay service (Cloudflare Worker or Railway)
- [ ] Build PC bridge agent (small process that maintains outbound WS to relay)
- [ ] Add session pairing flow
- [ ] Add device heartbeat
- [ ] Add HMAC request signing
- [ ] Add replay protection (nonce window)
- [ ] Add `relayRequestId` to audit entries
- [ ] Disable `auto_apply` for relay-connected workspaces
- [ ] Publish finalized OpenAPI schema to relay
- [ ] Configure Custom GPT Action on chatgpt.com
- [ ] Test end-to-end: mobile ChatGPT → relay → PC → file write
