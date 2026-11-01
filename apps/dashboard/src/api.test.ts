import { api } from './api';

type ApiCallCase = {
  name: string;
  run: () => Promise<unknown>;
  method: string;
  path: string;
  body?: unknown;
};

const workspaceInput = { name: 'Fixture', root: 'C:/fixture' };
const policy = { allowedGlobs: ['**/*.ts'], blockedGlobs: ['private/**'] };
const change = {
  workspaceId: 'ws-1',
  relativePath: 'src/app.ts',
  newContent: 'export {}',
  baseHash: 'a'.repeat(64),
  reason: 'test edit',
};

const calls: ApiCallCase[] = [
  { name: 'health', run: () => api.health(), method: 'GET', path: '/api/health' },
  { name: 'list workspaces', run: () => api.listWorkspaces(), method: 'GET', path: '/api/workspaces' },
  { name: 'add workspace', run: () => api.addWorkspace(workspaceInput), method: 'POST', path: '/api/workspaces', body: workspaceInput },
  { name: 'update workspace policy', run: () => api.updateWorkspacePolicy('ws-1', policy), method: 'PUT', path: '/api/workspaces/ws-1/policy', body: policy },
  { name: 'delete workspace', run: () => api.deleteWorkspace('ws-1'), method: 'DELETE', path: '/api/workspaces/ws-1' },
  { name: 'get workspace', run: () => api.getWorkspace('ws-1'), method: 'GET', path: '/api/workspaces/ws-1' },
  { name: 'list files', run: () => api.listFiles('ws-1'), method: 'POST', path: '/api/files/list', body: { workspaceId: 'ws-1' } },
  { name: 'search files', run: () => api.searchFiles('ws-1', 'needle', '**/*.ts'), method: 'POST', path: '/api/files/search', body: { workspaceId: 'ws-1', query: 'needle', glob: '**/*.ts' } },
  { name: 'read file', run: () => api.readFile('ws-1', 'src/app.ts'), method: 'POST', path: '/api/files/read', body: { workspaceId: 'ws-1', relativePath: 'src/app.ts' } },
  { name: 'preview change', run: () => api.previewChange(change), method: 'POST', path: '/api/changes/preview', body: change },
  { name: 'list pending changes', run: () => api.listPending(), method: 'GET', path: '/api/changes/pending' },
  { name: 'apply change', run: () => api.applyChange('ws-1', 'pending-1'), method: 'POST', path: '/api/changes/apply', body: { workspaceId: 'ws-1', pendingChangeId: 'pending-1' } },
  { name: 'reject change', run: () => api.rejectChange('pending-1'), method: 'POST', path: '/api/changes/reject', body: { pendingChangeId: 'pending-1' } },
  { name: 'recent changes with limit', run: () => api.recentChanges(25), method: 'GET', path: '/api/changes/recent?limit=25' },
  { name: 'recent changes default', run: () => api.recentChanges(), method: 'GET', path: '/api/changes/recent' },
  { name: 'revert change', run: () => api.revertChange('ws-1', 'audit-1'), method: 'POST', path: '/api/changes/revert', body: { workspaceId: 'ws-1', auditId: 'audit-1' } },
  { name: 'rotate token', run: () => api.rotateToken(), method: 'POST', path: '/api/auth/rotate-token' },
];

describe('dashboard API client', () => {
  let fetchMock: jest.Mock;
  let storedToken: string | null;

  beforeEach(() => {
    storedToken = 'dashboard-test-token';
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: jest.fn(() => storedToken) },
    });
    fetchMock = jest.fn().mockResolvedValue({
      json: async () => ({ ok: true, data: { result: 'fixture' } }),
    });
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock });
  });

  it.each(calls)('sends the expected authenticated request for $name', async ({ run, method, path, body }) => {
    await expect(run()).resolves.toEqual({ ok: true, data: { result: 'fixture' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer dashboard-test-token',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  });

  it('sends an empty bearer token when the dashboard has no saved token', async () => {
    storedToken = null;
    await api.health();
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ Authorization: 'Bearer ' });
  });

  it('returns API error payloads for the UI to display', async () => {
    fetchMock.mockResolvedValueOnce({ json: async () => ({ ok: false, error: 'Unauthorized' }) });
    await expect(api.listWorkspaces()).resolves.toEqual({ ok: false, error: 'Unauthorized' });
  });
});
