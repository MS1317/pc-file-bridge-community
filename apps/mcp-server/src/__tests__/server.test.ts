import type { FastifyInstance } from 'fastify';
import { buildServer, createToolDefinitions } from '../server';
import { BridgeApiError, type BridgeApiClient } from '../bridgeApiClient';
import { TERMINAL_EXECUTION_POLICY } from '@bridge/shared';

process.env.MCP_ENABLE_WRITES = 'true';
process.env.MCP_ENABLE_TERMINAL = 'true';
const TEST_TOKEN = 'a'.repeat(64);

const mockBridgeApi: BridgeApiClient = {
  health: jest.fn().mockResolvedValue({ status: 'running' }),
  approvalStatus: jest.fn().mockResolvedValue({ approvalId: 'test', state: 'approved' }),
  listWorkspaces: jest.fn().mockResolvedValue([]),
  listFiles: jest.fn().mockResolvedValue([]),
  searchFiles: jest.fn().mockResolvedValue([]),
  readFile: jest.fn().mockResolvedValue({ content: '', hash: '' }),
  listTree: jest.fn().mockResolvedValue({ workspaceId: 'ws1', relativePath: '', tree: [], truncated: false, totalNodes: 0 }),
  readFileRange: jest.fn().mockResolvedValue({ relativePath: 'f.ts', startLine: 1, endLine: 1, totalLines: 1, lines: [] }),
  findFile: jest.fn().mockResolvedValue({ workspaceId: 'ws1', query: '', matches: [] }),
  repoOverview: jest.fn().mockResolvedValue({ workspaceId: 'ws1', packageManager: null, rootFiles: [], apps: [], packages: [], scripts: {} }),
  previewReplaceRange: jest.fn().mockResolvedValue({}),
  previewInsertBefore: jest.fn().mockResolvedValue({}),
  previewInsertAfter: jest.fn().mockResolvedValue({}),
  previewChange: jest.fn().mockResolvedValue({}),
  writeChange: jest.fn().mockResolvedValue({ success: true }),
  listPendingChanges: jest.fn().mockResolvedValue([]),
  applyPendingChange: jest.fn().mockResolvedValue({ ok: true }),
  rejectPendingChange: jest.fn().mockResolvedValue({ rejected: true }),
  recentChanges: jest.fn().mockResolvedValue([]),
  revertChange: jest.fn().mockResolvedValue({ ok: true }),
  runTerminal: jest.fn().mockResolvedValue({
    command: 'node --version',
    relativeCwd: '.',
    exitCode: 0,
    signal: null,
    stdout: 'v20.0.0\n',
    stderr: '',
    timedOut: false,
    truncated: false,
    durationMs: 10,
  }),
  startTerminal: jest.fn().mockResolvedValue({
    jobId: 'job1',
    leaseId: 'lease1',
    state: 'running',
    processId: 1001,
    processStartedAt: new Date(1).toISOString(),
    workerProcessId: 1002,
    leaseExpiresAt: new Date(300000).toISOString(),
    terminationReason: null,
    command: 'node --version',
    relativeCwd: '.',
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    truncated: false,
    durationMs: 1,
  }),
  getTerminal: jest.fn().mockResolvedValue({
    jobId: 'job1',
    leaseId: 'lease1',
    state: 'completed',
    processId: 1001,
    processStartedAt: new Date(1).toISOString(),
    workerProcessId: 1002,
    leaseExpiresAt: null,
    terminationReason: 'process_exit',
    command: 'node --version',
    relativeCwd: '.',
    exitCode: 0,
    signal: null,
    stdout: 'v20.0.0\n',
    stderr: '',
    timedOut: false,
    truncated: false,
    durationMs: 10,
  }),
  stopTerminal: jest.fn().mockResolvedValue({
    jobId: 'job1',
    leaseId: 'lease1',
    state: 'stopped',
    processId: 1001,
    processStartedAt: new Date(1).toISOString(),
    workerProcessId: 1002,
    leaseExpiresAt: null,
    terminationReason: 'explicit_stop',
    command: 'node --version',
    relativeCwd: '.',
    exitCode: null,
    signal: 'SIGTERM',
    stdout: '',
    stderr: '',
    timedOut: false,
    truncated: false,
    durationMs: 10,
  }),
  renewTerminal: jest.fn().mockResolvedValue({
    jobId: 'job1',
    leaseId: 'lease1',
    state: 'running',
    processId: 1001,
    processStartedAt: new Date(1).toISOString(),
    workerProcessId: 1002,
    leaseExpiresAt: new Date(600000).toISOString(),
    terminationReason: null,
    command: 'node --version',
    relativeCwd: '.',
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    truncated: false,
    durationMs: 10,
  }),
  runSpreadsheet: jest.fn().mockResolvedValue({
    workspaceId: 'ws1',
    relativePath: 'book.xlsx',
    format: 'xlsx',
    fileHash: 'a'.repeat(64),
    sizeBytes: 1,
    sheets: [],
    namedRanges: [],
    metadata: {},
    warnings: [],
  }),
};

async function mcpPost(app: FastifyInstance, body: unknown, token?: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    payload: JSON.stringify(body),
  });
  return res;
}

async function mcpPostPath(app: FastifyInstance, body: unknown, pathToken: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/mcp/${pathToken}`,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
  return res;
}

// ── Auth middleware ───────────────────────────────────────────────────────────

describe('MCP auth', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer({
      bridgeApi: mockBridgeApi,
      mcpTokenRef: { value: TEST_TOKEN },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /mcp without token returns 401', async () => {
    const res = await mcpPost(app, { jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(res.statusCode).toBe(401);
    const parsed = JSON.parse(res.body);
    expect(parsed.code).toBe('INVALID_TOKEN');
  });

  it('POST /mcp with wrong token returns 401', async () => {
    const res = await mcpPost(app, { jsonrpc: '2.0', id: 1, method: 'ping' }, 'wrong-token');
    expect(res.statusCode).toBe(401);
  });

  it('POST /mcp with valid token succeeds', async () => {
    const res = await mcpPost(app, { jsonrpc: '2.0', id: 1, method: 'ping' }, TEST_TOKEN);
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.result).toEqual({});
  });

  it('GET /health requires no token', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });
});

// ── Tool list (always all tools) ──────────────────────────────────────────────

describe('MCP tools/list', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer({
      bridgeApi: mockBridgeApi,
      mcpTokenRef: { value: TEST_TOKEN },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  const ALL_TOOLS = [
    'list_workspaces',
    'list_files',
    'search_files',
    'read_file',
    'list_tree',
    'read_file_range',
    'find_file',
    'repo_overview',
    'preview_replace_range',
    'preview_insert_before',
    'preview_insert_after',
    'preview_change',
    'apply_change',
    'list_pending_changes',
    'apply_pending_change',
    'reject_pending_change',
    'recent_changes',
    'revert_change',
    'run_terminal_command',
    'start_terminal_command',
    'get_terminal_command',
    'renew_terminal_command',
    'stop_terminal_command',
    'inspect_spreadsheet',
    'read_spreadsheet_range',
    'search_spreadsheet',
    'append_spreadsheet_rows',
    'update_spreadsheet_range',
    'update_spreadsheet_rows_by_key',
    'upsert_spreadsheet_rows',
    'create_spreadsheet',
    'create_spreadsheet_sheet',
    'get_operation_approval',
  ];

  it('tools/list includes all 33 tools', async () => {
    const res = await mcpPost(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, TEST_TOKEN);
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    const names: string[] = parsed.result.tools.map((t: { name: string }) => t.name);
    expect(names).toHaveLength(ALL_TOOLS.length);
    for (const name of ALL_TOOLS) {
      expect(names).toContain(name);
    }
    const inspect = parsed.result.tools.find((tool: { name: string }) => tool.name === 'inspect_spreadsheet');
    const update = parsed.result.tools.find((tool: { name: string }) => tool.name === 'update_spreadsheet_range');
    expect(inspect.annotations.readOnlyHint).toBe(true);
    expect(update.annotations.destructiveHint).toBe(true);
  });

  it('tools/list always includes apply_pending_change', async () => {
    const res = await mcpPost(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, TEST_TOKEN);
    const parsed = JSON.parse(res.body);
    const names: string[] = parsed.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('apply_pending_change');
  });

  it('tools/list always includes revert_change', async () => {
    const res = await mcpPost(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, TEST_TOKEN);
    const parsed = JSON.parse(res.body);
    const names: string[] = parsed.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('revert_change');
  });

  it('derives terminal schema and validation from the owning policy', async () => {
    const policy = {
      ...TERMINAL_EXECUTION_POLICY,
      minimumTimeoutMs: 77,
      synchronousMaxTimeoutMs: 1234,
      asynchronousDefaultTimeoutMs: 4321,
      commandMaxLength: 12,
    };
    const definitions = createToolDefinitions(policy);
    const run = definitions.find((tool) => tool.name === 'run_terminal_command')!;
    const start = definitions.find((tool) => tool.name === 'start_terminal_command')!;
    const runTimeout = (run.inputSchema.properties as Record<string, any>).timeoutMs;
    const startTimeout = (start.inputSchema.properties as Record<string, any>).timeoutMs;
    expect(runTimeout).toMatchObject({ minimum: 77, maximum: 1234 });
    expect(startTimeout).toMatchObject({ minimum: 77 });
    expect(startTimeout.maximum).toBeUndefined();
    expect((start.inputSchema.properties as Record<string, any>).command.maxLength).toBe(12);

    const customApp = await buildServer({
      bridgeApi: mockBridgeApi,
      mcpTokenRef: { value: TEST_TOKEN },
      terminalPolicy: policy,
    });
    (mockBridgeApi.startTerminal as jest.Mock).mockClear();
    const rejected = await mcpPost(
      customApp,
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'start_terminal_command',
          arguments: { workspaceId: 'ws1', command: 'node --version', timeoutMs: 76 },
        },
      },
      TEST_TOKEN
    );
    expect(JSON.parse(rejected.body).result.isError).toBe(true);
    expect(mockBridgeApi.startTerminal).not.toHaveBeenCalled();
    await customApp.close();
  });

  it('terminal tool is listed and callable by default', async () => {
    const listed = await mcpPost(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, TEST_TOKEN);
    expect(JSON.parse(listed.body).result.tools.map((t: { name: string }) => t.name))
      .toContain('run_terminal_command');

    const called = await mcpPost(
      app,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'run_terminal_command',
          arguments: { workspaceId: 'ws1', command: 'node --version', timeoutMs: 1000 },
        },
      },
      TEST_TOKEN
    );
    expect(JSON.parse(called.body).result.isError).toBeUndefined();
    expect(mockBridgeApi.runTerminal).toHaveBeenCalledWith({
      workspaceId: 'ws1',
      command: 'node --version',
      relativeCwd: undefined,
      timeoutMs: 1000,
    });
  });

  it('long-running terminal tools start, poll, and stop by job id', async () => {
    const started = await mcpPost(
      app,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'start_terminal_command',
          arguments: { workspaceId: 'ws1', command: 'node --version', timeoutMs: 300000 },
        },
      },
      TEST_TOKEN
    );
    expect(JSON.parse(started.body).result.isError).toBeUndefined();
    expect(mockBridgeApi.startTerminal).toHaveBeenCalledWith({
      workspaceId: 'ws1',
      command: 'node --version',
      relativeCwd: undefined,
      timeoutMs: 300000,
    });

    const polled = await mcpPost(
      app,
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'get_terminal_command', arguments: { workspaceId: 'ws1', jobId: 'job1' } },
      },
      TEST_TOKEN
    );
    expect(JSON.parse(polled.body).result.isError).toBeUndefined();
    expect(mockBridgeApi.getTerminal).toHaveBeenCalledWith('ws1', 'job1');

    const renewed = await mcpPost(
      app,
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'renew_terminal_command',
          arguments: { workspaceId: 'ws1', jobId: 'job1', leaseId: 'lease1' },
        },
      },
      TEST_TOKEN
    );
    expect(JSON.parse(renewed.body).result.isError).toBeUndefined();
    expect(mockBridgeApi.renewTerminal).toHaveBeenCalledWith({
      workspaceId: 'ws1',
      jobId: 'job1',
      leaseId: 'lease1',
    });

    const stopped = await mcpPost(
      app,
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'stop_terminal_command', arguments: { workspaceId: 'ws1', jobId: 'job1' } },
      },
      TEST_TOKEN
    );
    expect(JSON.parse(stopped.body).result.isError).toBeUndefined();
    expect(mockBridgeApi.stopTerminal).toHaveBeenCalledWith('ws1', 'job1');
  });

  it('spreadsheet tool is listed and uses the typed bridge action', async () => {
    const called = await mcpPost(
      app,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'inspect_spreadsheet',
          arguments: { workspaceId: 'ws1', relativePath: 'book.xlsx' },
        },
      },
      TEST_TOKEN
    );
    expect(JSON.parse(called.body).result.isError).toBeUndefined();
    expect(mockBridgeApi.runSpreadsheet).toHaveBeenCalledWith(
      'inspect_spreadsheet',
      { workspaceId: 'ws1', relativePath: 'book.xlsx' }
    );
  });

  it('preserves normalized spreadsheet failure kinds from the bridge API', async () => {
    (mockBridgeApi.runSpreadsheet as jest.Mock).mockRejectedValueOnce(
      new BridgeApiError('Spreadsheet sheet was not found', 'sheet_not_found')
    );
    const response = await mcpPost(
      app,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'inspect_spreadsheet', arguments: { workspaceId: 'ws1', relativePath: 'book.xlsx' } },
      },
      TEST_TOKEN
    );
    const parsed = JSON.parse(response.body);
    expect(parsed.result.isError).toBe(true);
    expect(parsed.result.structuredContent.failureKind).toBe('sheet_not_found');
  });

  it('tools/call list_workspaces works', async () => {
    const res = await mcpPost(
      app,
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_workspaces', arguments: {} } },
      TEST_TOKEN
    );
    const parsed = JSON.parse(res.body);
    expect(parsed.result.isError).toBeUndefined();
  });

  it('tools/call apply_pending_change is callable (not blocked)', async () => {
    const res = await mcpPost(
      app,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'apply_pending_change', arguments: { workspaceId: 'ws1', pendingChangeId: 'pc1' } },
      },
      TEST_TOKEN
    );
    const parsed = JSON.parse(res.body);
    expect(parsed.result.isError).toBeUndefined();
    expect(mockBridgeApi.applyPendingChange).toHaveBeenCalledWith('ws1', 'pc1');
  });

  it('tools/call revert_change is callable (not blocked)', async () => {
    const res = await mcpPost(
      app,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'revert_change', arguments: { workspaceId: 'ws1', auditId: 'a1' } },
      },
      TEST_TOKEN
    );
    const parsed = JSON.parse(res.body);
    expect(parsed.result.isError).toBeUndefined();
    expect(mockBridgeApi.revertChange).toHaveBeenCalledWith('ws1', 'a1');
  });

  it('serializes an absent resulting file as nullable state', async () => {
    (mockBridgeApi.revertChange as jest.Mock).mockResolvedValueOnce({
      success: true,
      backupId: 'backup-1',
      relativePath: 'created.txt',
      oldHash: 'a'.repeat(64),
      newHash: null,
      diff: '',
      auditId: 'audit-2',
    });
    const res = await mcpPost(
      app,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'revert_change', arguments: { workspaceId: 'ws1', auditId: 'a1' } },
      },
      TEST_TOKEN
    );
    const parsed = JSON.parse(res.body);
    expect(parsed.result.structuredContent.reverted.newHash).toBeNull();
    expect(parsed.result.content[0].text).toContain('"newHash": null');
  });
});

// ── Path-token auth (/mcp/:remoteToken) ─────────────────────────────────────

describe('MCP path-token auth (/mcp/:token)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer({
      bridgeApi: mockBridgeApi,
      mcpTokenRef: { value: TEST_TOKEN },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /mcp/<wrong-token> returns 401', async () => {
    const res = await mcpPostPath(app, { jsonrpc: '2.0', id: 1, method: 'ping' }, 'wrong-token');
    expect(res.statusCode).toBe(401);
    const parsed = JSON.parse(res.body);
    expect(parsed.code).toBe('INVALID_TOKEN');
  });

  it('POST /mcp/<correct-token> ping returns 200', async () => {
    const res = await mcpPostPath(app, { jsonrpc: '2.0', id: 1, method: 'ping' }, TEST_TOKEN);
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.result).toEqual({});
  });

  it('POST /mcp/<correct-token> initialize returns server info', async () => {
    const res = await mcpPostPath(
      app,
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      TEST_TOKEN
    );
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.result.serverInfo.name).toBe('pc-file-bridge-mcp');
  });

  it('POST /mcp/<correct-token> tools/list returns all tools', async () => {
    const res = await mcpPostPath(
      app,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      TEST_TOKEN
    );
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(Array.isArray(parsed.result.tools)).toBe(true);
    expect(parsed.result.tools.length).toBe(33);
  });

  it('GET /mcp/<correct-token> returns 405', async () => {
    const res = await app.inject({ method: 'GET', url: `/mcp/${TEST_TOKEN}` });
    expect(res.statusCode).toBe(405);
  });

  it('GET /mcp/<wrong-token> returns 401 not 405', async () => {
    const res = await app.inject({ method: 'GET', url: '/mcp/wrong-token' });
    expect(res.statusCode).toBe(401);
  });

  it('header auth (POST /mcp) still works alongside path auth', async () => {
    const res = await mcpPost(app, { jsonrpc: '2.0', id: 1, method: 'ping' }, TEST_TOKEN);
    expect(res.statusCode).toBe(200);
  });
});
