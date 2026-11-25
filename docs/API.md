# API Reference

Base URL: `http://127.0.0.1:4777`

All endpoints except `/health` require the token from `data/auth-token.txt`:
```
Authorization: Bearer <token>
```

Send `Content-Type: application/json` only when the request has a body. An empty body with that header is rejected.

Responses are `{ "ok": true, "data": ... }` or `{ "ok": false, "error": "..." }`. Errors raised by the web framework itself, such as an unknown route or an oversized body, have `message` instead of `ok`.

| Status | Meaning |
|---|---|
| `202` | Waiting for local approval. `data` has `approvalRequired` and `approvalId`. |
| `400` | Invalid input, or the file rules denied access |
| `401` | Missing or wrong token |
| `403` | Capability disabled, or the local admin check failed |
| `404` | Unknown workspace or route |
| `413` | With approval on, payload and diff above 128 KiB. Always, body above 1 MiB |
| `429` | More than 120 requests per minute. See `Retry-After`. |

**Gated routes:** `/changes/write`, `/changes/apply`, `/changes/revert`, spreadsheet writes, and `/terminal/run`, `/start`, `/renew` and `/stop` follow the [access policy](#access-policy-and-approvals).

---

## GET /health

No auth required.

```json
// Response
{ "ok": true, "data": { "status": "running", "version": "0.2.0", "timestamp": "..." } }
```

---

## GET /workspaces

List all registered workspaces.

```json
// Response
{
  "ok": true,
  "data": [
    {
      "id": "abc12345",
      "name": "My Project",
      "root": "C:\\path\\to\\MyProject",
      "allowedGlobs": ["**/*.ts", "**/*.tsx"],
      "blockedGlobs": ["**/.env"],
      "writeMode": "approval_required",
      "createdAt": "2025-01-01T00:00:00.000Z"
    }
  ]
}
```

---

## POST /workspaces

Add a workspace.

```json
// Request
{ "name": "My Project", "root": "C:\\path\\to\\MyProject" }

// Optional fields
{
  "name": "My Project",
  "root": "C:\\path\\to\\MyProject",
  "allowedGlobs": ["**/*.ts"],
  "blockedGlobs": ["**/.env"],
  "writeMode": "approval_required"
}

// Response 201
{ "ok": true, "data": { "id": "abc12345", ... } }
```

---

`writeMode` is stored but not enforced. Approvals are controlled by the [access policy](#access-policy-and-approvals).

---

## GET /workspaces/:id

Get a single workspace.

---

## DELETE /workspaces/:id

Remove a workspace from the registry. Does NOT delete files.

```json
// Response
{ "ok": true, "data": { "removed": true } }
```

---

## POST /files/list

List all accessible files in a workspace (respects allowedGlobs/blockedGlobs).

```json
// Request
{ "workspaceId": "abc12345" }

// Response
{
  "ok": true,
  "data": [
    {
      "relativePath": "src/index.ts",
      "absolutePath": "C:\\path\\to\\MyProject\\src\\index.ts",
      "sizeBytes": 1234,
      "modifiedAt": "2025-01-01T00:00:00.000Z"
    }
  ]
}
```

## PUT /workspaces/:id/policy

Replace the explicit file-access policy for one existing workspace. This updates the same persisted workspace record used by all bridge file operations; it does not change the workspace root, name, or write mode.

```json
{
  "allowedGlobs": ["**/*.ts", "**/*.log"],
  "blockedGlobs": ["**/private/**"]
}
```

Blocked patterns continue to take precedence over allowed patterns. Built-in secret and database protections remain enforced even when they are absent from `blockedGlobs`.

---

## POST /files/search

Search file contents in a workspace.

```json
// Request
{ "workspaceId": "abc12345", "query": "useState", "glob": "**/*.tsx" }

// Response
{
  "ok": true,
  "data": [
    { "relativePath": "src/App.tsx", "line": 5, "column": 10, "preview": "const [x, setX] = useState('');" }
  ]
}
```

---

## POST /files/read

Read a file's content and hash.

```json
// Request
{ "workspaceId": "abc12345", "relativePath": "src/index.ts" }

// Response
{
  "ok": true,
  "data": {
    "relativePath": "src/index.ts",
    "content": "...",
    "hash": "sha256hex",
    "sizeBytes": 1234,
    "encoding": "utf8"
  }
}
```

---

## File navigation

| Route | Body | Returns |
|---|---|---|
| `POST /files/tree` | `workspaceId`, optional `relativePath`, `maxDepth` (1-10, default 4), `limit` (1-2000, default 500) | Directory tree |
| `POST /files/range` | `workspaceId`, `relativePath`, `startLine`, `endLine` (1-based, inclusive) | Those lines |
| `POST /files/find` | `workspaceId`, `query`, optional `limit` (1-200, default 50) | Files whose path matches |
| `POST /files/overview` | `workspaceId` | Summary of the workspace |

---

## POST /terminal/run

```json
// Request
{
  "workspaceId": "abc12345",
  "command": "corepack pnpm test",
  "relativeCwd": "."
}

// Response
{
  "ok": true,
  "data": {
    "command": "corepack pnpm test",
    "relativeCwd": ".",
    "exitCode": 0,
    "signal": null,
    "stdout": "...",
    "stderr": "",
    "timedOut": false,
    "truncated": false,
    "durationMs": 1234
  }
}
```

`relativeCwd` defaults to the workspace root. Synchronous timeout, command-length, and output limits come from the shared `TERMINAL_EXECUTION_POLICY`.

For commands that may exceed the synchronous tunnel request window, use the asynchronous terminal job endpoints instead:

## POST /terminal/start

Accepts the same request as `/terminal/run`, but returns immediately with a stable `jobId` and `leaseId`. `timeoutMs` is the requested process deadline and defaults from `TERMINAL_EXECUTION_POLICY`; it is not the supervisor lease. The worker persists process identity, bounded output, and structured terminal state.

## POST /terminal/status

```json
{ "workspaceId": "abc12345", "jobId": "job-id-from-start" }
```

Returns the current job state (`running`, `stopping`, `completed`, `failed`, `timed_out`, or `stopped`) and bounded output.

## POST /terminal/renew

```json
{ "workspaceId": "abc12345", "jobId": "job-id-from-start", "leaseId": "lease-id-from-start" }
```

Renews the bounded supervisor lease without creating a new job or process. The requested process deadline is unchanged.

## POST /terminal/stop

Accepts the same `{ "workspaceId", "jobId" }` body and requests process-tree termination. Poll `/terminal/status` until the state is terminal.

---

## POST /spreadsheets/:action

Spreadsheet actions are the preferred boundary for `.xlsx` workbook structure, cells, rows, sheets, and ranges. Do not construct PowerShell, Excel, ZIP, or XML commands for these operations.

Supported `:action` values:

| Action | Purpose |
|---|---|
| `inspect_spreadsheet` | List sheets, IDs, used ranges, dimensions, names, metadata, and the current SHA-256 |
| `read_spreadsheet_range` | Return structured raw values, display values, and formulas for an A1 range |
| `search_spreadsheet` | Search a workbook/sheet by typed value, exact/contains, and optional header column |
| `append_spreadsheet_rows` | Append after the current used rows and return the inserted range |
| `update_spreadsheet_range` | Replace a dimension-checked range with a two-dimensional value array |
| `update_spreadsheet_rows_by_key` | Update one row selected by generic header/key values |
| `upsert_spreadsheet_rows` | Update unique key matches and append missing rows |
| `create_spreadsheet` | Create a new `.xlsx` workbook with sheets, headers, rows, and optional bold headers |
| `create_spreadsheet_sheet` | Add a worksheet while preserving the existing workbook |

Only `.xlsx` is implemented. The shared contract owns the request shapes, cell values (`string`, `number`, `boolean`, blank, date, and formula), A1 range parser, limits, schemas, and normalized failure codes. The provider accepts `/` and `\\` ZIP entry separators, canonicalizes them once, and rejects traversal-like, absolute-looking, or colliding package names as `workbook_invalid`.

The MCP adapter marks inspect/read/search as read-only and spreadsheet mutations as destructive, and the same access policy and approvals apply as for other writes.

Example inspection request:

```json
{ "workspaceId": "abc12345", "relativePath": "reports/ledger.xlsx" }
```

Example key-based upsert:

```json
{
  "workspaceId": "abc12345",
  "relativePath": "reports/ledger.xlsx",
  "sheetName": "Findings",
  "keyColumns": ["Finding ID"],
  "rows": [
    { "Finding ID": "QA-014", "Status": "verified", "Count": 2 },
    { "Finding ID": "QA-015", "Status": "new" }
  ],
  "baseHash": "optional-sha256-from-inspect-or-read"
}
```

Every write response includes `beforeHash`, `afterHash`, `backupId`, `auditId`, `writeStatus` (`requested`, `validated`, `written`, `verified`), `verificationStatus`, `affectedRange`, row/cell counts, and inserted/updated row numbers. The bridge creates a generic backup before atomic replacement, reopens the workbook, and returns success only after structured verification. `revert_change` restores the returned `backupId` through the existing audit path.

Limits: 50 MiB workbook, 10,000 returned cells, 2,000 mutation rows, 200 search matches, 100,000 scanned search cells. Current format support is intentionally `.xlsx` only; `.xls`, `.ods`, and `.csv` return `unsupported_spreadsheet_format`.

---

## POST /changes/preview

Create a pending change and return its diff. Nothing is written. The pending change expires after 30 minutes.

```json
// Request
{
  "workspaceId": "abc12345",
  "relativePath": "src/index.ts",
  "newContent": "const x = 2;\n",
  "baseHash": "optional-sha256-of-current-file",
  "reason": "Fix typo"
}

// Response
{
  "ok": true,
  "data": {
    "pendingChangeId": "p1a2b3c4",
    "workspaceId": "abc12345",
    "relativePath": "src/index.ts",
    "oldHash": "sha256hex or null if new file",
    "newHash": "sha256hex",
    "diff": "--- original\n+++ modified\n@@ ... @@\n...",
    "warnings": [],
    "safe": true,
    "fileExists": true,
    "expiresAt": "2026-01-01T00:30:00.000Z"
  }
}
```

If `baseHash` doesn't match the current file, the preview returns a warning and `safe: false`, and applying it is rejected. Applying is also rejected if the file was changed, created or deleted after the preview.

---

## POST /changes/apply

Apply a pending change. Always creates a backup first.

```json
// Request
{ "workspaceId": "abc12345", "pendingChangeId": "p1a2b3c4" }

// Response
{
  "ok": true,
  "data": {
    "success": true,
    "backupId": "1735000000000-abc123",
    "relativePath": "src/index.ts",
    "oldHash": "sha256hex",
    "newHash": "sha256hex",
    "diff": "...",
    "auditId": "xyz789abcdef"
  }
}
```

---

## POST /changes/write

Preview and apply in one request. Takes the same body as `/changes/preview` and returns the same data as `/changes/apply`. A `baseHash` that does not match rejects the write.

## Line-based previews

Each creates a pending change and returns the same data as `/changes/preview`.

| Route | Body |
|---|---|
| `POST /changes/replace-range` | `workspaceId`, `relativePath`, `startLine`, `endLine`, `newContent`, optional `reason` |
| `POST /changes/insert-before` | `workspaceId`, `relativePath`, `line`, `content`, optional `reason` |
| `POST /changes/insert-after` | `workspaceId`, `relativePath`, `line`, `content`, optional `reason` |

## GET /changes/pending

List pending changes.

## POST /changes/reject

```json
{ "pendingChangeId": "p1a2b3c4" }
```

---

## GET /changes/recent?limit=50

Get the most recent audit log entries (newest first).

```json
// Response
{
  "ok": true,
  "data": [
    {
      "id": "xyz789abcdef",
      "timestamp": "2025-01-01T00:00:00.000Z",
      "action": "apply",
      "workspaceId": "abc12345",
      "workspaceName": "My Project",
      "relativePath": "src/index.ts",
      "oldHash": "sha256hex",
      "newHash": "sha256hex",
      "backupId": "1735000000000-abc123",
      "reason": "Fix typo"
    }
  ]
}
```

---

## POST /changes/revert

Revert a previous apply by its audit ID. Restores the file to pre-apply state.

```json
// Request
{ "workspaceId": "abc12345", "auditId": "xyz789abcdef" }

// Response — same shape as apply
{ "ok": true, "data": { "success": true, "backupId": "...", "auditId": "...", ... } }
```

A revert itself is logged as a new `action: "revert"` entry in the audit log. In apply/revert results and audit entries, `newHash: null` means the resulting file is absent; the SHA-256 empty-file hash means a zero-byte file genuinely exists.

---

## Access policy and approvals

Routes marked *admin* also need `X-Local-Admin-Token` from `data/local-admin-token.txt`, must come from this computer, and must be same-origin when sent by a browser.

| Route | Admin | Purpose |
|---|---|---|
| `GET /access/policy` | | Current policy |
| `PUT /access/policy` | Yes | Replace it. All three booleans are required. |
| `GET /access/approvals` | Yes | List approval requests |
| `GET /access/approvals/:id` | | Status and result of one request |
| `POST /access/approvals/:id/approve` | Yes | Run the operation once. `409` if it is no longer pending. |
| `POST /access/approvals/:id/reject` | Yes | Reject it |

```json
// PUT /access/policy
{ "fileWrites": true, "terminal": false, "requireApproval": false }
```

---

## POST /auth/rotate-token

Replaces the API token and returns the new one as `data.newToken`. The old token stops working immediately.
