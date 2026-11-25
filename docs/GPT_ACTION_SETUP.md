# OpenAPI / GPT Actions (experimental)

> This path is unfinished. There is no hosted relay, so a GPT Action cannot reach your PC today. Use [MCP](CLIENT_CONNECTIONS.md) instead.

What exists:

- `docs/openapi.json` describes part of the Bridge API.
- `docs/openapi-relay.json` describes the relay.
- `apps/relay-server` and `apps/bridge-agent` run the flow on localhost. See [LOCAL_RELAY_SIMULATION.md](LOCAL_RELAY_SIMULATION.md).

```
GPT Action -> HTTPS relay (not provided) -> bridge-agent -> bridge-api 127.0.0.1:4777
```

Do not point a GPT Action or a tunnel at the Bridge API. Keep 4777 and 4778 local.

The relay allows only these operations: list workspaces; list, search and read files; preview, list, apply and reject changes; view and revert history. Terminal, spreadsheets, workspace management and token rotation are not available through it. Writes follow the permissions in **Dashboard → Access Control**.
