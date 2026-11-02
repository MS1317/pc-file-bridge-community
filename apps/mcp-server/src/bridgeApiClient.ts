import { loadOrCreateToken } from '@bridge/core';
import type {
  ApiResponse,
  ApplyChangeResult,
  AuditEntry,
  ChangePreviewRequest,
  ChangePreviewResult,
  FileContent,
  FileEntry,
  PendingChange,
  SearchMatch,
  Workspace,
  TreeResult,
  FileRangeContent,
  FindFileResult,
  RepoOverview,
  ReplaceRangeRequest,
  InsertLineRequest,
  TerminalJobResult,
  TerminalRunRequest,
  TerminalRunResult,
  TerminalJobRenewRequest,
  SpreadsheetActionName,
  SpreadsheetActionRequest,
  SpreadsheetActionResult,
} from '@bridge/shared';
import { TERMINAL_EXECUTION_POLICY } from '@bridge/shared';

const DEFAULT_BRIDGE_API_URL = 'http://127.0.0.1:4777';
const REQUEST_TIMEOUT_MS = 15_000;

export type PublicWorkspace = Omit<Workspace, 'root'>;
export type PublicFileEntry = Omit<FileEntry, 'absolutePath'>;

export class BridgeApiError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'BridgeApiError';
  }
}

export interface BridgeApiClient {
  health(): Promise<{ status: string }>;
  approvalStatus(approvalId: string): Promise<{ approvalId: string; state: string; result?: unknown; error?: string }>;
  listWorkspaces(): Promise<PublicWorkspace[]>;
  listFiles(workspaceId: string): Promise<PublicFileEntry[]>;
  searchFiles(workspaceId: string, query: string, glob?: string): Promise<SearchMatch[]>;
  readFile(workspaceId: string, relativePath: string): Promise<FileContent>;
  listTree(workspaceId: string, relativePath?: string, maxDepth?: number, limit?: number): Promise<TreeResult>;
  readFileRange(workspaceId: string, relativePath: string, startLine: number, endLine: number): Promise<FileRangeContent>;
  findFile(workspaceId: string, query: string, limit?: number): Promise<FindFileResult>;
  repoOverview(workspaceId: string): Promise<RepoOverview>;
  previewReplaceRange(request: ReplaceRangeRequest): Promise<ChangePreviewResult>;
  previewInsertBefore(request: InsertLineRequest): Promise<ChangePreviewResult>;
  previewInsertAfter(request: InsertLineRequest): Promise<ChangePreviewResult>;
  previewChange(request: ChangePreviewRequest): Promise<ChangePreviewResult>;
  writeChange(request: ChangePreviewRequest): Promise<ApplyChangeResult>;
  listPendingChanges(): Promise<PendingChange[]>;
  applyPendingChange(workspaceId: string, pendingChangeId: string): Promise<ApplyChangeResult>;
  rejectPendingChange(pendingChangeId: string): Promise<{ rejected: boolean }>;
  recentChanges(limit?: number): Promise<AuditEntry[]>;
  revertChange(workspaceId: string, auditId: string): Promise<ApplyChangeResult>;
  runTerminal(request: TerminalRunRequest): Promise<TerminalRunResult>;
  startTerminal(request: TerminalRunRequest): Promise<TerminalJobResult>;
  getTerminal(workspaceId: string, jobId: string): Promise<TerminalJobResult>;
  renewTerminal(request: TerminalJobRenewRequest): Promise<TerminalJobResult>;
  stopTerminal(workspaceId: string, jobId: string): Promise<TerminalJobResult>;
  runSpreadsheet(action: SpreadsheetActionName, request: SpreadsheetActionRequest): Promise<SpreadsheetActionResult>;
}

export interface BridgeApiClientOptions {
  dataDir: string;
  baseUrl?: string;
  tokenProvider?: () => string;
  fetchImpl?: typeof fetch;
}

export function createBridgeApiClient(options: BridgeApiClientOptions): BridgeApiClient {
  const baseUrl = options.baseUrl ?? DEFAULT_BRIDGE_API_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const tokenProvider = options.tokenProvider ?? (() => loadOrCreateToken(options.dataDir));

  async function request<T>(
    method: string,
    route: string,
    body?: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const url = new URL(route, baseUrl).toString();

    try {
      const response = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${tokenProvider()}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const payload = (await response.json()) as ApiResponse<T>;
      if (!response.ok || !payload.ok) {
        const message = payload.ok ? `Bridge API request failed with HTTP ${response.status}` : payload.error;
        const code = !payload.ok && payload.code ? ` (${payload.code})` : '';
        throw new BridgeApiError(`${message}${code}`, !payload.ok ? payload.code : undefined);
      }

      return payload.data;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Bridge API request timed out after ${timeoutMs}ms: ${route}`);
      }
      if (error instanceof BridgeApiError) throw error;
      if (error instanceof Error) {
        throw new Error(`Bridge API request failed for ${route}: ${error.message}`);
      }
      throw new Error(`Bridge API request failed for ${route}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    health: () => request<{ status: string }>('GET', '/health'),
    approvalStatus: (approvalId: string) =>
      request<{ approvalId: string; state: string; result?: unknown; error?: string }>('GET', '/access/approvals/' + encodeURIComponent(approvalId)),
    listWorkspaces: async () => {
      const workspaces = await request<Workspace[]>('GET', '/workspaces');
      return workspaces.map(({ root: _root, ...workspace }) => workspace);
    },
    listFiles: async (workspaceId: string) => {
      const files = await request<FileEntry[]>('POST', '/files/list', { workspaceId });
      return files.map(({ absolutePath: _absolutePath, ...file }) => file);
    },
    searchFiles: (workspaceId: string, query: string, glob?: string) =>
      request<SearchMatch[]>('POST', '/files/search', { workspaceId, query, glob }),
    readFile: (workspaceId: string, relativePath: string) =>
      request<FileContent>('POST', '/files/read', { workspaceId, relativePath }),
    listTree: (workspaceId: string, relativePath?: string, maxDepth?: number, limit?: number) =>
      request<TreeResult>('POST', '/files/tree', { workspaceId, relativePath, maxDepth, limit }),
    readFileRange: (workspaceId: string, relativePath: string, startLine: number, endLine: number) =>
      request<FileRangeContent>('POST', '/files/range', { workspaceId, relativePath, startLine, endLine }),
    findFile: (workspaceId: string, query: string, limit?: number) =>
      request<FindFileResult>('POST', '/files/find', { workspaceId, query, limit }),
    repoOverview: (workspaceId: string) =>
      request<RepoOverview>('POST', '/files/overview', { workspaceId }),
    previewReplaceRange: (requestBody: ReplaceRangeRequest) =>
      request<ChangePreviewResult>('POST', '/changes/replace-range', requestBody),
    previewInsertBefore: (requestBody: InsertLineRequest) =>
      request<ChangePreviewResult>('POST', '/changes/insert-before', requestBody),
    previewInsertAfter: (requestBody: InsertLineRequest) =>
      request<ChangePreviewResult>('POST', '/changes/insert-after', requestBody),
    previewChange: (requestBody: ChangePreviewRequest) =>
      request<ChangePreviewResult>('POST', '/changes/preview', requestBody),
    writeChange: (requestBody: ChangePreviewRequest) =>
      request<ApplyChangeResult>('POST', '/changes/write', requestBody),
    listPendingChanges: () => request<PendingChange[]>('GET', '/changes/pending'),
    applyPendingChange: (workspaceId: string, pendingChangeId: string) =>
      request<ApplyChangeResult>('POST', '/changes/apply', { workspaceId, pendingChangeId }),
    rejectPendingChange: (pendingChangeId: string) =>
      request<{ rejected: boolean }>('POST', '/changes/reject', { pendingChangeId }),
    recentChanges: (limit?: number) =>
      request<AuditEntry[]>('GET', `/changes/recent${limit ? `?limit=${limit}` : ''}`),
    revertChange: (workspaceId: string, auditId: string) =>
      request<ApplyChangeResult>('POST', '/changes/revert', { workspaceId, auditId }),
    runTerminal: (requestBody: TerminalRunRequest) =>
      request<TerminalRunResult>(
        'POST',
        '/terminal/run',
        requestBody,
        (requestBody.timeoutMs ?? TERMINAL_EXECUTION_POLICY.synchronousDefaultTimeoutMs) + 5_000
      ),
    startTerminal: (requestBody: TerminalRunRequest) =>
      request<TerminalJobResult>('POST', '/terminal/start', requestBody),
    getTerminal: (workspaceId: string, jobId: string) =>
      request<TerminalJobResult>('POST', '/terminal/status', { workspaceId, jobId }),
    renewTerminal: (requestBody: TerminalJobRenewRequest) =>
      request<TerminalJobResult>('POST', '/terminal/renew', requestBody),
    stopTerminal: (workspaceId: string, jobId: string) =>
      request<TerminalJobResult>('POST', '/terminal/stop', { workspaceId, jobId }),
    runSpreadsheet: (action: SpreadsheetActionName, requestBody: SpreadsheetActionRequest) =>
      request<SpreadsheetActionResult>('POST', `/spreadsheets/${encodeURIComponent(action)}`, requestBody, 60_000),
  };
}
