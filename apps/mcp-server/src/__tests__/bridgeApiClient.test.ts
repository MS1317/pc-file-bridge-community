import { BridgeApiError, createBridgeApiClient } from '../bridgeApiClient';

type ClientCallCase = {
  name: string;
  run: (client: ReturnType<typeof createBridgeApiClient>) => Promise<unknown>;
  method: string;
  path: string;
  body?: unknown;
  responseData?: unknown;
  result?: unknown;
};

const change = { workspaceId: 'ws-1', relativePath: 'src/app.ts', newContent: 'new text' };
const calls: ClientCallCase[] = [
  { name: 'health', run: (c) => c.health(), method: 'GET', path: '/health' },
  { name: 'list workspaces', run: (c) => c.listWorkspaces(), method: 'GET', path: '/workspaces', responseData: [{ id: 'ws-1', root: 'C:/private' }], result: [{ id: 'ws-1' }] },
  { name: 'list files', run: (c) => c.listFiles('ws-1'), method: 'POST', path: '/files/list', body: { workspaceId: 'ws-1' }, responseData: [{ relativePath: 'app.ts', absolutePath: 'C:/private/app.ts' }], result: [{ relativePath: 'app.ts' }] },
  { name: 'search files', run: (c) => c.searchFiles('ws-1', 'needle', '**/*.ts'), method: 'POST', path: '/files/search', body: { workspaceId: 'ws-1', query: 'needle', glob: '**/*.ts' } },
  { name: 'read file', run: (c) => c.readFile('ws-1', 'app.ts'), method: 'POST', path: '/files/read', body: { workspaceId: 'ws-1', relativePath: 'app.ts' } },
  { name: 'list tree', run: (c) => c.listTree('ws-1', 'src', 2, 10), method: 'POST', path: '/files/tree', body: { workspaceId: 'ws-1', relativePath: 'src', maxDepth: 2, limit: 10 } },
  { name: 'read range', run: (c) => c.readFileRange('ws-1', 'app.ts', 2, 4), method: 'POST', path: '/files/range', body: { workspaceId: 'ws-1', relativePath: 'app.ts', startLine: 2, endLine: 4 } },
  { name: 'find file', run: (c) => c.findFile('ws-1', 'app', 5), method: 'POST', path: '/files/find', body: { workspaceId: 'ws-1', query: 'app', limit: 5 } },
  { name: 'repo overview', run: (c) => c.repoOverview('ws-1'), method: 'POST', path: '/files/overview', body: { workspaceId: 'ws-1' } },
  { name: 'preview replace range', run: (c) => c.previewReplaceRange({ ...change, startLine: 1, endLine: 1 }), method: 'POST', path: '/changes/replace-range', body: { ...change, startLine: 1, endLine: 1 } },
  { name: 'preview insert before', run: (c) => c.previewInsertBefore({ ...change, line: 1, content: 'before' }), method: 'POST', path: '/changes/insert-before', body: { ...change, line: 1, content: 'before' } },
  { name: 'preview insert after', run: (c) => c.previewInsertAfter({ ...change, line: 1, content: 'after' }), method: 'POST', path: '/changes/insert-after', body: { ...change, line: 1, content: 'after' } },
  { name: 'preview change', run: (c) => c.previewChange(change), method: 'POST', path: '/changes/preview', body: change },
  { name: 'write change', run: (c) => c.writeChange(change), method: 'POST', path: '/changes/write', body: change },
  { name: 'list pending changes', run: (c) => c.listPendingChanges(), method: 'GET', path: '/changes/pending' },
  { name: 'apply pending change', run: (c) => c.applyPendingChange('ws-1', 'pending-1'), method: 'POST', path: '/changes/apply', body: { workspaceId: 'ws-1', pendingChangeId: 'pending-1' } },
  { name: 'reject pending change', run: (c) => c.rejectPendingChange('pending-1'), method: 'POST', path: '/changes/reject', body: { pendingChangeId: 'pending-1' } },
  { name: 'recent changes', run: (c) => c.recentChanges(15), method: 'GET', path: '/changes/recent?limit=15' },
  { name: 'revert change', run: (c) => c.revertChange('ws-1', 'audit-1'), method: 'POST', path: '/changes/revert', body: { workspaceId: 'ws-1', auditId: 'audit-1' } },
  { name: 'run terminal', run: (c) => c.runTerminal({ workspaceId: 'ws-1', command: 'node --version', timeoutMs: 1000 }), method: 'POST', path: '/terminal/run', body: { workspaceId: 'ws-1', command: 'node --version', timeoutMs: 1000 } },
  { name: 'start terminal job', run: (c) => c.startTerminal({ workspaceId: 'ws-1', command: 'node --version' }), method: 'POST', path: '/terminal/start', body: { workspaceId: 'ws-1', command: 'node --version' } },
  { name: 'get terminal job', run: (c) => c.getTerminal('ws-1', 'job-1'), method: 'POST', path: '/terminal/status', body: { workspaceId: 'ws-1', jobId: 'job-1' } },
  { name: 'renew terminal job', run: (c) => c.renewTerminal({ workspaceId: 'ws-1', jobId: 'job-1', leaseId: 'lease-1' }), method: 'POST', path: '/terminal/renew', body: { workspaceId: 'ws-1', jobId: 'job-1', leaseId: 'lease-1' } },
  { name: 'stop terminal job', run: (c) => c.stopTerminal('ws-1', 'job-1'), method: 'POST', path: '/terminal/stop', body: { workspaceId: 'ws-1', jobId: 'job-1' } },
  { name: 'spreadsheet action', run: (c) => c.runSpreadsheet('inspect_spreadsheet', { workspaceId: 'ws-1', relativePath: 'book.xlsx' }), method: 'POST', path: '/spreadsheets/inspect_spreadsheet', body: { workspaceId: 'ws-1', relativePath: 'book.xlsx' } },
];

describe('BridgeApiClient HTTP adapter', () => {
  const baseUrl = 'http://127.0.0.1:4777';
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
  });

  it.each(calls)('maps $name to the expected authenticated API request', async (testCase) => {
    const data = testCase.responseData ?? { result: 'fixture' };
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, data }) });
    const client = createBridgeApiClient({
      dataDir: 'unused-with-token-provider',
      baseUrl,
      tokenProvider: () => 'internal-bridge-token',
      fetchImpl: fetchMock as typeof fetch,
    });

    const result = await testCase.run(client);
    expect(result).toEqual(testCase.result ?? data);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`${baseUrl}${testCase.path}`);
    expect(options).toMatchObject({
      method: testCase.method,
      headers: { Authorization: 'Bearer internal-bridge-token', 'Content-Type': 'application/json' },
      body: testCase.body === undefined ? undefined : JSON.stringify(testCase.body),
      signal: expect.any(AbortSignal),
    });
  });

  it('turns structured API failures into BridgeApiError with the server code', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ ok: false, code: 'concurrent_modification', error: 'File changed since it was read' }),
    });
    const client = createBridgeApiClient({ dataDir: 'unused', tokenProvider: () => 'token', fetchImpl: fetchMock as typeof fetch });
    await expect(client.readFile('ws-1', 'app.ts')).rejects.toMatchObject({
      name: 'BridgeApiError',
      code: 'concurrent_modification',
      message: 'File changed since it was read (concurrent_modification)',
    });
  });

  it('reports aborts as route-specific timeout errors and wraps network errors', async () => {
    const client = createBridgeApiClient({ dataDir: 'unused', tokenProvider: () => 'token', fetchImpl: fetchMock as typeof fetch });
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(client.health()).rejects.toThrow('Bridge API request timed out after 15000ms: /health');
    fetchMock.mockRejectedValueOnce(new Error('connection refused'));
    await expect(client.health()).rejects.toThrow('Bridge API request failed for /health: connection refused');
  });
});
