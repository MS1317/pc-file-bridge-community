# API Reference

Base URL: `http://127.0.0.1:4777`

All endpoints (except `/health`) require:
```
Authorization: Bearer <token>
Content-Type: application/json
```

All responses are `{ ok: true, data: ... }` or `{ ok: false, error: "..." }`.

---

## GET /health

No auth required.

```json
// Response
{ "ok": true, "data": { "status": "running", "version": "0.1.0", "timestamp": "..." } }
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
      "root": "C:\Users\developer\Desktop\Dev\MyProject",
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
{ "name": "My Project", "root": "C:\Users\developer\Desktop\Dev\MyProject" }

// Optional fields
{
  "name": "My Project",
  "root": "C:\...",
  "allowedGlobs": ["**/*.ts"],
  "blockedGlobs": ["**/.env"],
  "writeMode": "approval_required"
}

// Response 201
{ "ok": true, "data": { "id": "abc12345", ... } }
```

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
      "absolutePath": "C:\...",
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

The MCP adapter marks inspect/read/search as read-only and spreadsheet mutations as destructive, so they use the existing ChatGPT permission prompt/approval flow. No spreadsheet-specific approval or absolute-path bypass is added.

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

Preview a proposed change without writing anything.

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
    "workspaceId": "abc12345",
    "relativePath": "src/index.ts",
    "oldHash": "sha256hex or null if new file",
    "newHash": "sha256hex",
    "diff": "--- original\n+++ modified\n@@ ... @@\n...",
    "warnings": [],
    "safe": true,
    "fileExists": true
  }
}
```

If `baseHash` doesn't match the current file's hash, a warning is added but the preview still returns (so you can see the conflict). The apply endpoint will reject mismatched hashes.

---

## POST /changes/apply

Apply a change. Always creates a backup first.

```json
// Request (same shape as preview)
{
  "workspaceId": "abc12345",
  "relativePath": "src/index.ts",
  "newContent": "const x = 2;\n",
  "baseHash": "optional-sha256",
  "reason": "Fix typo"
}

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
