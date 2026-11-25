# Tunnel checklist

Work through this before you expose the MCP server for the first time.

## Before

- [ ] `pnpm bridge:start` is running and `pnpm preflight:mcp` shows only `PASS`.
- [ ] Only a throwaway folder is registered as a workspace.
- [ ] File modifications and terminal commands are **off** in Access Control.
- [ ] The bridge runs as your normal user, not as administrator.
- [ ] The tunnel points at `http://127.0.0.1:4779` and nothing else.

## Through the tunnel

- [ ] `https://YOUR_HOST/health` answers.
- [ ] `POST https://YOUR_HOST/mcp` without a token returns `401`.
- [ ] Your client connects and lists the tools.
- [ ] `list_workspaces` and `read_file` work on the throwaway folder.
- [ ] `apply_change` fails with `fileWrites is disabled`.
- [ ] Ports 4777 and 4778 are **not** reachable from outside.

## Then

- [ ] Turn on file modifications, and approval if you want it. Change a file, then revert it.
- [ ] Register your real project.
- [ ] Turn on the terminal only if you need it and trust the client.

Turn the tunnel off when you do not need it (`pnpm tunnel:tailscale:off`). If the token may have leaked, run `pnpm token:mcp:rotate` and restart the bridge.
