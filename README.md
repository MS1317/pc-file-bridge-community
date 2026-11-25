# PC File Bridge

Give Claude, ChatGPT and other MCP clients controlled access to folders you choose on your own PC. Clients can read, search and edit files in those folders, and run commands if you allow it.

- **Off by default.** File changes and terminal commands stay disabled until you enable them in a local dashboard.
- **Only the folders you register.** Path, link and secret-file rules apply to every file tool.
- **Undo.** Every file change is backed up and logged, and can be reverted.

[Connect a client](docs/CLIENT_CONNECTIONS.md) · [Security model](docs/SECURITY.md) · [API reference](docs/API.md) · [Architecture](docs/ARCHITECTURE.md) · [Changelog](CHANGELOG.md)

> [!WARNING]
> Terminal commands run as your user account and are **not sandboxed**. Enable them only for clients you trust. Never expose ports 4777 or 4778 to a network.

## Requirements

| | |
|---|---|
| Node.js | 20.19 or newer, or 22.12 or newer |
| pnpm | 9 (`npm install -g pnpm@9`) |
| OS | Developed and tested on Windows 10/11. Linux and macOS are expected to work but get less testing. |

## Quick start

```bash
git clone https://github.com/MS1317/pc-file-bridge-community.git
cd pc-file-bridge-community
pnpm install
pnpm bridge:start
```

The first start compiles the shared packages and creates a `data/` folder with your tokens. Leave the terminal open.

| Service | Address | Expose to the internet? |
|---|---|---|
| Dashboard | http://127.0.0.1:4778 | Never |
| Bridge API | http://127.0.0.1:4777 | Never |
| MCP server | http://127.0.0.1:4779/mcp | Only through a TLS tunnel, if you need remote access |

### Set it up

1. Open http://127.0.0.1:4778 and paste the contents of `data/auth-token.txt`.
2. On **Workspaces**, add a folder you want clients to reach. Start with a throwaway folder.
3. Optional: to allow edits or commands, open **Access Control**, paste `data/local-admin-token.txt`, and turn on what you need.
4. In a second terminal, run `pnpm preflight:mcp`. Every line should say `PASS`.
5. [Connect your client](docs/CLIENT_CONNECTIONS.md).

Claude Code on the same PC, for example. Run `pnpm token:mcp` to print the token:

```bash
claude mcp add --transport http pc-file-bridge http://127.0.0.1:4779/mcp --header "Authorization: Bearer YOUR_MCP_TOKEN"
```

To use the bridge from a phone or another computer, see [Remote access](docs/CLIENT_CONNECTIONS.md#remote-access).

## The three tokens

All are generated on first run and stored in `data/`, which Git ignores.

| File | Who uses it | Give it to an AI client? |
|---|---|---|
| `mcp-remote-token.txt` | MCP clients | Yes, this is the only one |
| `auth-token.txt` | You, to sign in to the dashboard | No |
| `local-admin-token.txt` | You, to change permissions and approve operations | Never |

File tools cannot read or change `data/`, even if you register a folder that contains the bridge.

## Permissions and approvals

| Setting in **Access Control** | Default | Effect |
|---|---|---|
| Allow file and spreadsheet modifications | Off | Write tools work inside registered workspaces |
| Allow terminal commands | Off | Command tools work |
| Require local approval for each sensitive operation | Off | Each write or command waits for you to approve it in the dashboard |

With approval off, an enabled capability runs without another prompt from the bridge. Turn approval on for clients you do not fully trust.

With approval on, a tool returns `approvalRequired` and an `approvalId`. Approve it in the dashboard within 10 minutes, then ask the client to call `get_operation_approval`. Waiting approvals are lost when the API restarts.

## Which files clients can see

A new workspace allows common source, text and config files (`.ts`, `.js`, `.py`, `.go`, `.rs`, `.java`, `.cs`, `.md`, `.json`, `.yaml` and others) plus `.xlsx`. To add a type, open **Workspaces → Edit Policy** and add a pattern such as `**/*.vue`. Workspaces registered before an upgrade keep the list they already had.

These are always blocked and cannot be allowed: `.env` files, keys and certificates, `.ssh`, `.aws`, `credentials`, `secrets/`, databases, `.git`, `node_modules`, and common build and cache folders. The [full list](docs/SECURITY.md#always-blocked) is in the security docs.

To hide more, copy `.bridgeignore.example` to your workspace root as `.bridgeignore`:

```
# One pattern per line, relative to the workspace root
my-output-dir
generated/**
*.log
```

`.bridgeignore` only adds restrictions. It cannot unblock anything.

## Tools

| Group | Tools |
|---|---|
| Browse | `list_workspaces` `list_files` `list_tree` `find_file` `search_files` `repo_overview` |
| Read | `read_file` `read_file_range` |
| Edit in one step | `apply_change` |
| Preview, then apply | `preview_change` `preview_replace_range` `preview_insert_before` `preview_insert_after` `list_pending_changes` `apply_pending_change` `reject_pending_change` |
| History | `recent_changes` `revert_change` |
| Terminal | `run_terminal_command` `start_terminal_command` `get_terminal_command` `renew_terminal_command` `stop_terminal_command` |
| Spreadsheets | `inspect_spreadsheet` `read_spreadsheet_range` `search_spreadsheet` `append_spreadsheet_rows` `update_spreadsheet_range` `update_spreadsheet_rows_by_key` `upsert_spreadsheet_rows` `create_spreadsheet` `create_spreadsheet_sheet` |
| Approvals | `get_operation_approval` |

All tools are always listed. A disabled tool returns an error that says which setting to turn on.

- **Edits:** pass `baseHash` from an earlier read to reject the write if the file changed since. Previews last 30 minutes and touch nothing until applied. One request can be up to 1 MB, or 128 KB with approval on. Line edits need a UTF-8 file.
- **Terminal:** commands start in a registered workspace, get no stdin, and do not inherit secret environment variables. `run_terminal_command` is limited to 120 seconds. Use `start_terminal_command` for longer work, and renew its 5-minute lease while it runs.
- **Spreadsheets:** `.xlsx` only, up to 50 MiB. Cell updates leave unrelated formulas, styles and drawings unchanged.

## Commands

| Command | What it does |
|---|---|
| `pnpm bridge:start` | Start the API, dashboard and MCP server |
| `pnpm bridge:stop` | Stop whatever is using ports 4777, 4778 and 4779 |
| `pnpm preflight:mcp` | Check that a running bridge is healthy |
| `pnpm token:mcp` | Print the MCP token |
| `pnpm token:mcp:rotate` | Replace the MCP token. Restart the bridge and update every client afterwards |
| `pnpm tunnel:tailscale` | Publish the MCP server with Tailscale Funnel (`:status` and `:off` also exist) |
| `pnpm dev` | API and dashboard only |
| `pnpm api` / `pnpm ui` / `pnpm mcp` | One service at a time |
| `pnpm build` / `pnpm typecheck` / `pnpm test` | Developer checks |
| `pnpm bridge:check` | Preflight, typecheck, test and build against a running bridge |
| `pnpm bridge:smoke` | Start the bridge, run the preflight, stop it again |

## Start at sign-in

On Windows, `scripts/bridge-autostart.ps1` starts the bridge in the background and waits until it is healthy. Press Win+R, open `shell:startup`, and create a shortcut with this target, using your own path:

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\path\to\pc-file-bridge-community\scripts\bridge-autostart.ps1"
```

Output goes to `data/bridge.log`. Run the bridge as your normal user. Running it as administrator gives every allowed command administrator rights.

## Updating

```bash
pnpm bridge:stop
git pull
pnpm install
pnpm bridge:start
```

Your `data/` folder is kept. Read the [changelog](CHANGELOG.md) first. To uninstall, run `pnpm bridge:stop` and `pnpm tunnel:tailscale:off`, then delete the folder.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot find module ...@bridge/core/dist/index.js` | Start with the `pnpm` commands above, which compile it. Run `pnpm build:packages` to do it by hand. |
| `EADDRINUSE` or `Port 4778 is already in use` | Another copy is running. `pnpm bridge:stop` |
| `This project is configured to use pnpm` or a lockfile error | Install pnpm 9: `npm install -g pnpm@9` |
| Dashboard says the token was rejected | Paste `data/auth-token.txt`, not the MCP or admin token. |
| `fileWrites is disabled` or `terminal is disabled` | Turn it on in **Access Control**. |
| `Local administrator token required` | Paste `data/local-admin-token.txt` on the **Access Control** page. |
| A file is missing, or `Not matched by workspace allowedGlobs` | Add its type in **Workspaces → Edit Policy**. |
| `Blocked by default security rules` | The file is on the always-blocked list. This cannot be overridden. |
| Client gets `401` | Wrong MCP token, or it was rotated without restarting the bridge. `pnpm token:mcp` |
| MCP health says `degraded` | The Bridge API is down. Check the terminal, or `data/bridge.log` if you use autostart. |
| `Tailscale already publishes another app on HTTPS port` | Set `TAILSCALE_HTTPS_PORT` to `8443` or `10000` for both `on` and `off`. |
| Funnel URL does not answer | `pnpm tunnel:tailscale:status`. Funnel must be enabled for your tailnet and the bridge must be running. |

## Experimental: relay and GPT Actions

The repository also contains an unfinished relay for OpenAPI / GPT Actions. It runs on localhost only and is not needed for MCP. See [GPT_ACTION_SETUP.md](docs/GPT_ACTION_SETUP.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

Licensed under the [MIT License](LICENSE).
