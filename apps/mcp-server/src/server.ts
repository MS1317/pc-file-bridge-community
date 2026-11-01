import crypto from 'crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type {
  ApplyChangeResult,
  AuditEntry,
  ChangePreviewRequest,
  ChangePreviewResult,
  FileContent,
  PendingChange,
  TerminalExecutionPolicy,
  TerminalJobRenewRequest,
  SearchMatch,
  TerminalJobResult,
  TerminalRunResult,
  SpreadsheetActionResult,
} from '@bridge/shared';
import {
  SpreadsheetContractError,
  SPREADSHEET_TOOL_DEFINITIONS,
  TERMINAL_EXECUTION_POLICY,
  isSpreadsheetActionName,
  parseSpreadsheetRequest,
} from '@bridge/shared';
import type { BridgeApiClient, PublicFileEntry, PublicWorkspace } from './bridgeApiClient';
import { BridgeApiError } from './bridgeApiClient';

const MCP_PROTOCOL_VERSION = '2025-11-25';
const MCP_SERVER_NAME = 'chatgpt-pc-file-bridge-mcp';
const MCP_SERVER_VERSION = '0.1.0';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

interface ToolContent {
  type: 'text';
  text: string;
}

interface ToolResult {
  content: ToolContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface ServerOptions {
  bridgeApi: BridgeApiClient;
  mcpTokenRef: { value: string };
  terminalPolicy?: TerminalExecutionPolicy;
}

function validateMcpToken(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  try {
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeJsonRpcId(value: unknown): string | number | null {
  if (typeof value === 'string' || typeof value === 'number' || value === null) {
    return value;
  }
  return null;
}

function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function textResult<T>(value: T): ToolResult {
  return {
    content: [{ type: 'text', text: stringify(value) }],
    structuredContent: value,
  };
}

function errorResult(message: string, data?: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: data ?? { error: message },
    isError: true,
  };
}

function jsonRpcError(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

function jsonRpcSuccess(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function getString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required and must be a non-empty string`);
  }
  return value;
}

function getOptionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error('Optional string fields must be strings');
  }
  return value;
}

function getOptionalLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 200) {
    throw new Error('limit must be an integer between 1 and 200');
  }
  return value;
}

function getOptionalInt(value: unknown, field: string, min: number, max?: number): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    (max !== undefined && value > max)
  ) {
    throw new Error(max === undefined
      ? `${field} must be a safe integer at least ${min}`
      : `${field} must be a safe integer between ${min} and ${max}`);
  }
  return value;
}

function getRequiredInt(value: unknown, field: string, min: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new Error(`${field} must be an integer >= ${min}`);
  }
  return value;
}

function parseToolArgs(name: string, params: unknown): Record<string, unknown> {
  if (params === undefined) return {};
  if (!isRecord(params)) {
    throw new Error(`Arguments for ${name} must be a JSON object`);
  }
  return params;
}

function sanitizeWorkspaces(workspaces: PublicWorkspace[]): { workspaces: PublicWorkspace[] } {
  return { workspaces };
}

function sanitizeFiles(workspaceId: string, files: PublicFileEntry[]): { workspaceId: string; files: PublicFileEntry[] } {
  return { workspaceId, files };
}

function sanitizePending(pendingChanges: PendingChange[]): { pendingChanges: PendingChange[] } {
  return { pendingChanges };
}

function sanitizeRecentChanges(entries: AuditEntry[]): { recentChanges: AuditEntry[] } {
  return { recentChanges: entries };
}

function sanitizePreview(preview: ChangePreviewResult): { preview: ChangePreviewResult } {
  return { preview };
}

function sanitizeFile(file: FileContent): { file: FileContent } {
  return { file };
}

function sanitizeSearchResults(workspaceId: string, matches: SearchMatch[]): { workspaceId: string; matches: SearchMatch[] } {
  return { workspaceId, matches };
}

function sanitizeAppliedChange(result: ApplyChangeResult): { applied: ApplyChangeResult } {
  return { applied: result };
}

function sanitizeRevertedChange(result: ApplyChangeResult): { reverted: ApplyChangeResult } {
  return { reverted: result };
}

function sanitizeTerminalResult(result: TerminalRunResult): { terminal: TerminalRunResult } {
  return { terminal: result };
}

function sanitizeTerminalJobResult(result: TerminalJobResult): { terminalJob: TerminalJobResult } {
  return { terminalJob: result };
}

export function createToolDefinitions(policy: TerminalExecutionPolicy = TERMINAL_EXECUTION_POLICY): ToolDefinition[] {
  return [
  {
    name: 'list_workspaces',
    title: 'List Workspaces',
    description: 'List registered workspaces. Workspace root paths are intentionally omitted.',
    inputSchema: { type: 'object', additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_files',
    title: 'List Files',
    description: 'List approved files for a workspace using bridge-api safety rules.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
      },
      required: ['workspaceId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'search_files',
    title: 'Search Files',
    description: 'Search approved workspace files using bridge-api safety rules.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        query: { type: 'string' },
        glob: { type: 'string' },
      },
      required: ['workspaceId', 'query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'read_file',
    title: 'Read File',
    description: 'Read an approved file. The bridge-api enforces glob and path guards.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        relativePath: { type: 'string' },
      },
      required: ['workspaceId', 'relativePath'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_tree',
    title: 'List Tree',
    description:
      'Show the directory tree of a workspace (or a subdirectory) up to a given depth. ' +
      'Respects workspace glob and path guards. Never includes .git, node_modules, dist, build, ' +
      'coverage, .next, out, or cache folders. Use this to navigate large repos without reading every file. ' +
      'Results are paginated via the limit parameter (default 500, max 2000). ' +
      'Check the truncated field — if true, reduce maxDepth or target a subdirectory with relativePath.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        relativePath: { type: 'string', description: 'Subdirectory to start from (optional, defaults to workspace root)' },
        maxDepth: { type: 'integer', minimum: 1, maximum: 10, description: 'Max depth to traverse (default 4)' },
        limit: { type: 'integer', minimum: 1, maximum: 2000, description: 'Max nodes to return (default 500)' },
      },
      required: ['workspaceId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'read_file_range',
    title: 'Read File Range',
    description:
      'Read a specific line range from a file, with line numbers included in the response. ' +
      'Respects workspace glob and path guards. Use this to inspect large files without reading ' +
      'the entire content. Lines are 1-indexed and inclusive. ' +
      'Use read_file for small files; use read_file_range for targeted inspection of large ones.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        relativePath: { type: 'string' },
        startLine: { type: 'integer', minimum: 1, description: 'First line to read (1-indexed, inclusive)' },
        endLine: { type: 'integer', minimum: 1, description: 'Last line to read (1-indexed, inclusive)' },
      },
      required: ['workspaceId', 'relativePath', 'startLine', 'endLine'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'find_file',
    title: 'Find File',
    description:
      'Find files by name within a workspace. Matches files whose basename contains the query ' +
      '(case-insensitive). Respects workspace glob and path guards — only approved files are ' +
      'returned. Use this to locate a specific file quickly in a large repo.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        query: { type: 'string', description: 'Filename substring to search for (case-insensitive)' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max results to return (default 50)' },
      },
      required: ['workspaceId', 'query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'repo_overview',
    title: 'Repo Overview',
    description:
      'Get a high-level summary of a workspace: package manager, root-level files, ' +
      'apps/ and packages/ subdirectories, and scripts from package.json. ' +
      'Use this as the first call when exploring an unfamiliar repo.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
      },
      required: ['workspaceId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'preview_replace_range',
    title: 'Preview Replace Range',
    description:
      'Replace a specific line range in a file with new content. Creates a pending change — no file is touched yet. ' +
      'Call apply_pending_change immediately after using the returned pendingChangeId when the user explicitly requested the edit. ' +
      'Lines are 1-indexed and the range is inclusive. Use read_file_range first to confirm line numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        relativePath: { type: 'string' },
        startLine: { type: 'integer', minimum: 1, description: 'First line of the range to replace (1-indexed, inclusive)' },
        endLine: { type: 'integer', minimum: 1, description: 'Last line of the range to replace (1-indexed, inclusive)' },
        newContent: { type: 'string', description: 'Replacement content (may span multiple lines)' },
        reason: { type: 'string' },
      },
      required: ['workspaceId', 'relativePath', 'startLine', 'endLine', 'newContent'],
      additionalProperties: false,
    },
  },
  {
    name: 'preview_insert_before',
    title: 'Preview Insert Before',
    description:
      'Insert content before a specific line in a file. Creates a pending change — no file is touched yet. ' +
      'Call apply_pending_change immediately after using the returned pendingChangeId when the user explicitly requested the edit. ' +
      'Line is 1-indexed.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        relativePath: { type: 'string' },
        line: { type: 'integer', minimum: 1, description: 'Line number to insert before (1-indexed)' },
        content: { type: 'string', description: 'Content to insert (may span multiple lines)' },
        reason: { type: 'string' },
      },
      required: ['workspaceId', 'relativePath', 'line', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'preview_insert_after',
    title: 'Preview Insert After',
    description:
      'Insert content after a specific line in a file. Creates a pending change — no file is touched yet. ' +
      'Call apply_pending_change immediately after using the returned pendingChangeId when the user explicitly requested the edit. ' +
      'Line is 1-indexed.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        relativePath: { type: 'string' },
        line: { type: 'integer', minimum: 1, description: 'Line number to insert after (1-indexed)' },
        content: { type: 'string', description: 'Content to insert (may span multiple lines)' },
        reason: { type: 'string' },
      },
      required: ['workspaceId', 'relativePath', 'line', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'preview_change',
    title: 'Preview Change',
    description:
      'Create a pending change preview. When the user explicitly asked to edit/change/replace content, call apply_pending_change immediately after using the pendingChangeId from the response — do not pause to ask for confirmation. ChatGPT\'s own permission prompt is the approval step. Only stop after preview if the user asked for preview only.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        relativePath: { type: 'string' },
        newContent: { type: 'string' },
        baseHash: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['workspaceId', 'relativePath', 'newContent'],
      additionalProperties: false,
    },
  },
  {
    name: 'apply_change',
    title: 'Apply Change',
    description:
      'Write new file content in a single step — previews and applies atomically. ' +
      'Prefer this over preview_change + apply_pending_change when the user explicitly asked to edit/change/replace content: it is one round trip instead of two, so it is noticeably faster over the remote bridge. ' +
      "ChatGPT's permission prompt is the approval step. Pass baseHash (from a prior read_file) to guard against overwriting concurrent edits — the write is rejected if the file changed. Use preview_change only when the user wants to see a diff without applying it.",
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        relativePath: { type: 'string' },
        newContent: { type: 'string' },
        baseHash: { type: 'string', description: 'Hash from a prior read_file; write is rejected if the file changed since' },
        reason: { type: 'string' },
      },
      required: ['workspaceId', 'relativePath', 'newContent'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_pending_changes',
    title: 'List Pending Changes',
    description: 'List pending changes created by preview_change.',
    inputSchema: { type: 'object', additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'apply_pending_change',
    title: 'Apply Pending Change',
    description:
      'Apply a pending preview after ChatGPT permission approval. Call this immediately after preview_change when the user explicitly requested the edit. Use the pendingChangeId returned by preview_change. ChatGPT\'s permission prompt is the approval step — do not ask the user to confirm again.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        pendingChangeId: { type: 'string' },
      },
      required: ['workspaceId', 'pendingChangeId'],
      additionalProperties: false,
    },
  },
  {
    name: 'reject_pending_change',
    title: 'Reject Pending Change',
    description: 'Reject a pending change without applying it.',
    inputSchema: {
      type: 'object',
      properties: {
        pendingChangeId: { type: 'string' },
      },
      required: ['pendingChangeId'],
      additionalProperties: false,
    },
  },
  {
    name: 'recent_changes',
    title: 'Recent Changes',
    description: 'Read the recent audit log entries.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'revert_change',
    title: 'Revert Change',
    description: 'Revert a previously applied change. This is a write action with backups.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        auditId: { type: 'string' },
      },
      required: ['workspaceId', 'auditId'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_terminal_command',
    title: 'Run Terminal Command',
    description:
      'Run a non-interactive terminal command with its initial working directory inside a registered workspace. ' +
      `Execution is limited to ${policy.synchronousMaxTimeoutMs}ms; use start_terminal_command for longer work. ` +
      `Output is limited to ${policy.outputMaxBytes} bytes per stream and audited. ` +
      'The command runs with the local user account and may access resources that account can access.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        command: { type: 'string', maxLength: policy.commandMaxLength },
        relativeCwd: {
          type: 'string',
          description: 'Existing directory relative to the workspace root (default ".")',
        },
        timeoutMs: {
          type: 'integer',
          minimum: policy.minimumTimeoutMs,
          maximum: policy.synchronousMaxTimeoutMs,
          description: `Execution timeout in milliseconds (default ${policy.synchronousDefaultTimeoutMs})`,
        },
      },
      required: ['workspaceId', 'command'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'start_terminal_command',
    title: 'Start Long-Running Terminal Command',
    description:
      'Start a non-interactive terminal command and return immediately with a jobId and leaseId. ' +
      'Use get_terminal_command to poll, renew_terminal_command to renew ownership, and stop_terminal_command to request termination. ' +
      `The requested process lifetime defaults to ${policy.asynchronousDefaultTimeoutMs}ms and is separate from the bounded renewable supervisor lease. ` +
      `Output is limited to ${policy.outputMaxBytes} bytes per stream and audited.`,
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        command: { type: 'string', maxLength: policy.commandMaxLength },
        relativeCwd: {
          type: 'string',
          description: 'Existing directory relative to the workspace root (default ".")',
        },
        timeoutMs: {
          type: 'integer',
          minimum: policy.minimumTimeoutMs,
          description: `Requested process runtime in milliseconds (default ${policy.asynchronousDefaultTimeoutMs}); supervisor ownership must be renewed before its lease expires`,
        },
      },
      required: ['workspaceId', 'command'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'renew_terminal_command',
    title: 'Renew Terminal Command Lease',
    description: 'Renew ownership of a running terminal job without changing its job or process identity. Poll the job after renewal to confirm its structured state.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        jobId: { type: 'string' },
        leaseId: { type: 'string' },
      },
      required: ['workspaceId', 'jobId', 'leaseId'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_terminal_command',
    title: 'Get Terminal Command Status',
    description: 'Poll a previously started terminal job by workspaceId and opaque jobId. Returns bounded output and final exit details when complete.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        jobId: { type: 'string' },
      },
      required: ['workspaceId', 'jobId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'stop_terminal_command',
    title: 'Stop Terminal Command',
    description: 'Request termination of a previously started terminal job by workspaceId and opaque jobId. Poll get_terminal_command until the state is stopped.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        jobId: { type: 'string' },
      },
      required: ['workspaceId', 'jobId'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
  },
  ...SPREADSHEET_TOOL_DEFINITIONS,
  ];
}

async function handleMcpRequest(
  req: FastifyRequest,
  reply: FastifyReply,
  bridgeApi: BridgeApiClient,
  toolDefinitions: ToolDefinition[],
  terminalPolicy: TerminalExecutionPolicy
): Promise<unknown> {
  const body = req.body as JsonRpcRequest | undefined;
  if (!isRecord(body) || typeof body.method !== 'string' || body.jsonrpc !== '2.0') {
    return reply.code(200).send(jsonRpcError(null, -32600, 'Invalid Request'));
  }

  if (typeof body.id === 'undefined') {
    return reply.code(202).send();
  }

  const id = normalizeJsonRpcId(body.id);

  try {
    if (body.method === 'initialize') {
      return reply.code(200).send(
        jsonRpcSuccess(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          serverInfo: {
            name: MCP_SERVER_NAME,
            version: MCP_SERVER_VERSION,
          },
          capabilities: {
            tools: {
              listChanged: false,
            },
          },
        })
      );
    }

    if (body.method === 'tools/list') {
      return reply.code(200).send(jsonRpcSuccess(id, { tools: toolDefinitions }));
    }

    if (body.method === 'tools/call') {
      const params = parseToolArgs('tools/call', body.params);
      const name = getString(params.name, 'name');
      const rawArgs = params.arguments;
      const args = parseToolArgs(name, rawArgs);
      if (!toolDefinitions.some((t) => t.name === name)) throw new Error('Tool disabled by server policy');
      const result = await callTool(bridgeApi, name, args, terminalPolicy);
      return reply.code(200).send(jsonRpcSuccess(id, result));
    }

    if (body.method === 'ping') {
      return reply.code(200).send(jsonRpcSuccess(id, {}));
    }

    return reply.code(200).send(jsonRpcError(id, -32601, `Method not found: ${body.method}`));
  } catch (error) {
    if (error instanceof Error) {
      return reply.code(200).send(jsonRpcError(id, -32602, error.message));
    }
    return reply.code(200).send(jsonRpcError(id, -32603, 'Internal error'));
  }
}

export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  const {
    bridgeApi,
    mcpTokenRef,
    terminalPolicy = TERMINAL_EXECUTION_POLICY,
  } = opts;
  const allowWrites = process.env.MCP_ENABLE_WRITES === 'true';
  const allowTerminal = allowWrites && process.env.MCP_ENABLE_TERMINAL === 'true';
  const writeTools = new Set(['apply_change', 'apply_pending_change', 'revert_change', 'append_spreadsheet_rows', 'update_spreadsheet_range', 'update_spreadsheet_rows_by_key', 'upsert_spreadsheet_rows', 'create_spreadsheet', 'create_spreadsheet_sheet']);
  const terminalTools = new Set(['run_terminal_command', 'start_terminal_command', 'get_terminal_command', 'renew_terminal_command', 'stop_terminal_command']);
  const toolDefinitions = createToolDefinitions(terminalPolicy).filter((t) => (allowWrites || !writeTools.has(t.name)) && (allowTerminal || !terminalTools.has(t.name)));
  const app = Fastify({ logger: false });

  app.get('/health', async () => {
    let bridgeApiHealthy = false;
    try {
      await bridgeApi.health();
      bridgeApiHealthy = true;
    } catch {
      bridgeApiHealthy = false;
    }

    return {
      ok: true,
      data: {
        status: bridgeApiHealthy ? 'running' : 'degraded',
        bridgeApiHealthy,
        protocolVersion: MCP_PROTOCOL_VERSION,
        timestamp: new Date().toISOString(),
      },
    };
  });

  // ── Header-auth routes (/mcp) ───────────────────────────────────────────────

  app.get('/mcp', async (_req, reply) => {
    reply.header('Allow', 'POST');
    return reply.status(405).send({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Use POST /mcp for MCP requests.' },
    });
  });

  app.post('/mcp', async (req: FastifyRequest, reply: FastifyReply) => {
    const authHeader = (req.headers['authorization'] as string) ?? '';
    const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!validateMcpToken(provided, mcpTokenRef.value)) {
      return reply.status(401).send({ ok: false, error: 'Unauthorized', code: 'INVALID_TOKEN' });
    }
    return handleMcpRequest(req, reply, bridgeApi, toolDefinitions, terminalPolicy);
  });

  // ── Path-token routes (/mcp/:remoteToken) ──────────────────────────────────
  // Used by ChatGPT: Authentication = No Auth, Server URL = .../mcp/<token>

  app.get('/mcp/:remoteToken', async (req: FastifyRequest, reply: FastifyReply) => {
    const { remoteToken } = req.params as { remoteToken: string };
    if (!validateMcpToken(remoteToken, mcpTokenRef.value)) {
      return reply.status(401).send({ ok: false, error: 'Unauthorized', code: 'INVALID_TOKEN' });
    }
    reply.header('Allow', 'POST');
    return reply.status(405).send({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Use POST /mcp/<token> for MCP requests.' },
    });
  });

  app.post('/mcp/:remoteToken', async (req: FastifyRequest, reply: FastifyReply) => {
    const { remoteToken } = req.params as { remoteToken: string };
    if (!validateMcpToken(remoteToken, mcpTokenRef.value)) {
      return reply.status(401).send({ ok: false, error: 'Unauthorized', code: 'INVALID_TOKEN' });
    }
    return handleMcpRequest(req, reply, bridgeApi, toolDefinitions, terminalPolicy);
  });

  return app;
}

async function callTool(
  bridgeApi: BridgeApiClient,
  name: string,
  args: Record<string, unknown>,
  terminalPolicy: TerminalExecutionPolicy
): Promise<ToolResult> {
  try {
    if (isSpreadsheetActionName(name)) {
      const request = parseSpreadsheetRequest(name, args);
      const result: SpreadsheetActionResult = await bridgeApi.runSpreadsheet(name, request);
      return textResult(result);
    }
    switch (name) {
      case 'list_workspaces': {
        const workspaces = await bridgeApi.listWorkspaces();
        return textResult(sanitizeWorkspaces(workspaces));
      }
      case 'list_files': {
        const workspaceId = getString(args.workspaceId, 'workspaceId');
        const files = await bridgeApi.listFiles(workspaceId);
        return textResult(sanitizeFiles(workspaceId, files));
      }
      case 'search_files': {
        const workspaceId = getString(args.workspaceId, 'workspaceId');
        const query = getString(args.query, 'query');
        const glob = getOptionalString(args.glob);
        const matches = await bridgeApi.searchFiles(workspaceId, query, glob);
        return textResult(sanitizeSearchResults(workspaceId, matches));
      }
      case 'read_file': {
        const workspaceId = getString(args.workspaceId, 'workspaceId');
        const relativePath = getString(args.relativePath, 'relativePath');
        const file = await bridgeApi.readFile(workspaceId, relativePath);
        return textResult(sanitizeFile(file));
      }
      case 'list_tree': {
        const workspaceId = getString(args.workspaceId, 'workspaceId');
        const relativePath = getOptionalString(args.relativePath);
        const maxDepth = getOptionalInt(args.maxDepth, 'maxDepth', 1, 10);
        const limit = getOptionalInt(args.limit, 'limit', 1, 2000);
        const tree = await bridgeApi.listTree(workspaceId, relativePath, maxDepth, limit);
        return textResult(tree);
      }
      case 'read_file_range': {
        const workspaceId = getString(args.workspaceId, 'workspaceId');
        const relativePath = getString(args.relativePath, 'relativePath');
        const startLine = getRequiredInt(args.startLine, 'startLine', 1);
        const endLine = getRequiredInt(args.endLine, 'endLine', 1);
        const range = await bridgeApi.readFileRange(workspaceId, relativePath, startLine, endLine);
        return textResult(range);
      }
      case 'find_file': {
        const workspaceId = getString(args.workspaceId, 'workspaceId');
        const query = getString(args.query, 'query');
        const limit = getOptionalInt(args.limit, 'limit', 1, 200);
        const found = await bridgeApi.findFile(workspaceId, query, limit);
        return textResult(found);
      }
      case 'repo_overview': {
        const workspaceId = getString(args.workspaceId, 'workspaceId');
        const overview = await bridgeApi.repoOverview(workspaceId);
        return textResult(overview);
      }
      case 'preview_replace_range': {
        const workspaceId = getString(args.workspaceId, 'workspaceId');
        const relativePath = getString(args.relativePath, 'relativePath');
        const startLine = getRequiredInt(args.startLine, 'startLine', 1);
        const endLine = getRequiredInt(args.endLine, 'endLine', 1);
        const newContent = getString(args.newContent, 'newContent');
        const reason = getOptionalString(args.reason);
        const preview = await bridgeApi.previewReplaceRange({ workspaceId, relativePath, startLine, endLine, newContent, reason });
        return textResult(sanitizePreview(preview));
      }
      case 'preview_insert_before': {
        const workspaceId = getString(args.workspaceId, 'workspaceId');
        const relativePath = getString(args.relativePath, 'relativePath');
        const line = getRequiredInt(args.line, 'line', 1);
        const content = getString(args.content, 'content');
        const reason = getOptionalString(args.reason);
        const preview = await bridgeApi.previewInsertBefore({ workspaceId, relativePath, line, content, reason });
        return textResult(sanitizePreview(preview));
      }
      case 'preview_insert_after': {
        const workspaceId = getString(args.workspaceId, 'workspaceId');
        const relativePath = getString(args.relativePath, 'relativePath');
        const line = getRequiredInt(args.line, 'line', 1);
        const content = getString(args.content, 'content');
        const reason = getOptionalString(args.reason);
        const preview = await bridgeApi.previewInsertAfter({ workspaceId, relativePath, line, content, reason });
        return textResult(sanitizePreview(preview));
      }
      case 'preview_change': {
        const workspaceId = getString(args.workspaceId, 'workspaceId');
        const relativePath = getString(args.relativePath, 'relativePath');
        const newContent = getString(args.newContent, 'newContent');
        const baseHash = getOptionalString(args.baseHash);
        const reason = getOptionalString(args.reason);
        const request: ChangePreviewRequest = {
          workspaceId,
          relativePath,
          newContent,
          baseHash,
          reason,
        };
        const preview = await bridgeApi.previewChange(request);
        return textResult(sanitizePreview(preview));
      }
      case 'apply_change': {
        const workspaceId = getString(args.workspaceId, 'workspaceId');
        const relativePath = getString(args.relativePath, 'relativePath');
        const newContent = getString(args.newContent, 'newContent');
        const baseHash = getOptionalString(args.baseHash);
        const reason = getOptionalString(args.reason);
        const request: ChangePreviewRequest = { workspaceId, relativePath, newContent, baseHash, reason };
        const applied = await bridgeApi.writeChange(request);
        return textResult(sanitizeAppliedChange(applied));
      }
      case 'list_pending_changes': {
        const pendingChanges = await bridgeApi.listPendingChanges();
        return textResult(sanitizePending(pendingChanges));
      }
      case 'apply_pending_change': {
        const workspaceId = getString(args.workspaceId, 'workspaceId');
        const pendingChangeId = getString(args.pendingChangeId, 'pendingChangeId');
        const applied = await bridgeApi.applyPendingChange(workspaceId, pendingChangeId);
        return textResult(sanitizeAppliedChange(applied));
      }
      case 'reject_pending_change': {
        const pendingChangeId = getString(args.pendingChangeId, 'pendingChangeId');
        const rejected = await bridgeApi.rejectPendingChange(pendingChangeId);
        return textResult(rejected);
      }
      case 'recent_changes': {
        const limit = getOptionalLimit(args.limit);
        const changes = await bridgeApi.recentChanges(limit);
        return textResult(sanitizeRecentChanges(changes));
      }
      case 'revert_change': {
        const workspaceId = getString(args.workspaceId, 'workspaceId');
        const auditId = getString(args.auditId, 'auditId');
        const reverted = await bridgeApi.revertChange(workspaceId, auditId);
        return textResult(sanitizeRevertedChange(reverted));
      }
      case 'run_terminal_command': {
        const workspaceId = getString(args.workspaceId, 'workspaceId');
        const command = getString(args.command, 'command');
        const relativeCwd = getOptionalString(args.relativeCwd);
        const timeoutMs = getOptionalInt(
          args.timeoutMs,
          'timeoutMs',
          terminalPolicy.minimumTimeoutMs,
          terminalPolicy.synchronousMaxTimeoutMs
        );
        const result = await bridgeApi.runTerminal({ workspaceId, command, relativeCwd, timeoutMs });
        return textResult(sanitizeTerminalResult(result));
      }
      case 'start_terminal_command': {
        const workspaceId = getString(args.workspaceId, 'workspaceId');
        const command = getString(args.command, 'command');
        const relativeCwd = getOptionalString(args.relativeCwd);
        const timeoutMs = getOptionalInt(args.timeoutMs, 'timeoutMs', terminalPolicy.minimumTimeoutMs);
        const result = await bridgeApi.startTerminal({ workspaceId, command, relativeCwd, timeoutMs });
        return textResult(sanitizeTerminalJobResult(result));
      }
      case 'renew_terminal_command': {
        const request: TerminalJobRenewRequest = {
          workspaceId: getString(args.workspaceId, 'workspaceId'),
          jobId: getString(args.jobId, 'jobId'),
          leaseId: getString(args.leaseId, 'leaseId'),
        };
        const result = await bridgeApi.renewTerminal(request);
        return textResult(sanitizeTerminalJobResult(result));
      }
      case 'get_terminal_command': {
        const workspaceId = getString(args.workspaceId, 'workspaceId');
        const jobId = getString(args.jobId, 'jobId');
        const result = await bridgeApi.getTerminal(workspaceId, jobId);
        return textResult(sanitizeTerminalJobResult(result));
      }
      case 'stop_terminal_command': {
        const workspaceId = getString(args.workspaceId, 'workspaceId');
        const jobId = getString(args.jobId, 'jobId');
        const result = await bridgeApi.stopTerminal(workspaceId, jobId);
        return textResult(sanitizeTerminalJobResult(result));
      }
      default:
        return errorResult(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const failureKind = error instanceof BridgeApiError
      ? error.code
      : error instanceof SpreadsheetContractError
        ? error.kind
        : undefined;
    if (error instanceof Error) {
      return errorResult(
        `Bridge API error while running ${name}: ${error.message}`,
        failureKind ? { failureKind, error: error.message } : undefined
      );
    }
    return errorResult(`Bridge API error while running ${name}`);
  }
}
