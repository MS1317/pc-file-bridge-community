import type {
  Workspace,
  WorkspaceInput,
  WorkspacePolicyUpdate,
  FileEntry,
  FileContent,
  SearchMatch,
  ChangePreviewResult,
  ApplyChangeResult,
  AuditEntry,
  PendingChange,
} from '@bridge/shared';

const BASE = '/api';

function getToken(): string {
  return localStorage.getItem('bridge_token') ?? '';
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getToken()}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

export const api = {
  health: () => request<{ status: string }>('GET', '/health'),

  // Workspaces
  listWorkspaces: () => request<Workspace[]>('GET', '/workspaces'),
  addWorkspace: (input: WorkspaceInput) => request<Workspace>('POST', '/workspaces', input),
  updateWorkspacePolicy: (id: string, input: WorkspacePolicyUpdate) =>
    request<Workspace>('PUT', `/workspaces/${id}/policy`, input),
  deleteWorkspace: (id: string) => request<{ removed: boolean }>('DELETE', `/workspaces/${id}`),
  getWorkspace: (id: string) => request<Workspace>('GET', `/workspaces/${id}`),

  // Files
  listFiles: (workspaceId: string) =>
    request<FileEntry[]>('POST', '/files/list', { workspaceId }),
  searchFiles: (workspaceId: string, query: string, glob?: string) =>
    request<SearchMatch[]>('POST', '/files/search', { workspaceId, query, glob }),
  readFile: (workspaceId: string, relativePath: string) =>
    request<FileContent>('POST', '/files/read', { workspaceId, relativePath }),

  // Changes — pending-change flow
  previewChange: (payload: {
    workspaceId: string;
    relativePath: string;
    newContent: string;
    baseHash?: string;
    reason?: string;
  }) => request<ChangePreviewResult>('POST', '/changes/preview', payload),

  listPending: () => request<PendingChange[]>('GET', '/changes/pending'),

  applyChange: (workspaceId: string, pendingChangeId: string) =>
    request<ApplyChangeResult>('POST', '/changes/apply', { workspaceId, pendingChangeId }),

  rejectChange: (pendingChangeId: string) =>
    request<{ rejected: boolean }>('POST', '/changes/reject', { pendingChangeId }),

  recentChanges: (limit?: number) =>
    request<AuditEntry[]>('GET', `/changes/recent${limit ? `?limit=${limit}` : ''}`),

  revertChange: (workspaceId: string, auditId: string) =>
    request<ApplyChangeResult>('POST', '/changes/revert', { workspaceId, auditId }),

  // Auth
  rotateToken: () =>
    request<{ rotated: boolean; newToken: string; message: string }>('POST', '/auth/rotate-token'),
};
