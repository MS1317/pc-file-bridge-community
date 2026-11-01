# OpenAPI / GPT Actions Path (Alternate Route)

This is the alternate integration path. For DevSpace-style workflow replication, use the MCP Developer Mode path in `docs/MCP_DEVELOPER_MODE.md` first.

## What this path is for

`docs/openapi.json` describes the API that a custom ChatGPT Action can call to read and edit files on your PC.

The OpenAPI route still works with the existing bridge-api, relay simulation, pending-change flow, backups, and audit log.

## Important boundaries

- Do not publish the localhost URL.
- Do not point the GPT Action at localhost directly.
- Keep bridge-api bound to `127.0.0.1`.
- Keep the dashboard local-only.
- Do not remove the existing relay simulation while MCP support is added.

## How the relay-based path works

```
ChatGPT
  -> Custom GPT Action
  -> HTTPS relay or tunnel
  -> local relay/client layer
  -> bridge-api on 127.0.0.1:4777
  -> approved workspace files
```

The relay is only an alternate transport. It does not change the safety logic inside `@bridge/core`.

## What this path can do

- Read workspace lists and file listings
- Read file content
- Search file contents
- Create a pending change preview
- Apply or reject a pending change
- View recent audit entries
- Revert a change

## What this path must not do

- Shell command execution
- Workspace creation or deletion from remote
- Raw filesystem access outside registered workspaces
- Token rotation from remote
- Direct file writes without a preview step

## Security reminder

- Every write goes through `preview -> apply`.
- The relay or tunnel should add its own auth layer.
- Rotate the bridge token before sharing any remote endpoint.
- Monitor `data/audit-log.jsonl` for unexpected activity.
