# Tunnel Test Checklist

This checklist is for tunnel-test readiness only.

- Do not set up a tunnel from this checklist alone.
- Do not expose anything publicly until you explicitly choose a tunnel provider.
- Do not test against a real project first.
- The MCP token grants terminal-command authority; keep the tunnel private and use the dummy workspace first.

## Local Startup

Start local services in separate terminals:

```bash
corepack pnpm api
corepack pnpm mcp
```

Before any tunnel test, run:

```bash
corepack pnpm preflight:mcp
```

If local build verification has not already been run, also run:

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

## Safest Tunnel Order

Use this order when you are ready to test an external MCP endpoint:

1. OpenAI Secure MCP Tunnel first, if available.
2. Tailscale Funnel second.
3. Cloudflare Quick Tunnel only for temporary testing.

## Exact Safety Rules

- Never expose `4777` `bridge-api`.
- Never expose `4778` `dashboard`.
- Only expose `4779` `mcp-server`.
- Test only with the dummy workspace first: `C:\Users\developer\Desktop\Dev\bridge-test-project`.
- Do not apply edits to a real project during tunnel testing.
- Keep `bridge-api` bound to `127.0.0.1`.
- Keep the dashboard local-only.

## Preflight Expectations

`corepack pnpm preflight:mcp` checks:

- `bridge-api` health on `http://127.0.0.1:4777/health`
- `mcp-server` health on `http://127.0.0.1:4779/health`
- MCP `initialize`
- MCP `tools/list`
- Dummy workspace registration for first-pass testing

The preflight script does not create a tunnel and does not expose any port publicly.

## First Tunnel Test Scope

When you do move to tunnel testing later, keep scope narrow:

1. Expose only `http://127.0.0.1:4779/mcp`.
2. Use the dummy workspace first.
3. Confirm `initialize` and `tools/list`.
4. Confirm read-only tools before any preview-change flow.
5. Confirm `preview_change` creates only a pending change.
6. Do not apply pending changes to a real project during first tunnel tests.

For the Tailscale option, the explicit controls are `corepack pnpm tunnel:tailscale`, `corepack pnpm tunnel:tailscale:status`, and `corepack pnpm tunnel:tailscale:off`. The start command checks local MCP and bridge-api health first and only targets port 4779. Funnel is public HTTPS, so continue to treat the path token as a secret.
