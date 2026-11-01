// ─── Workspace ───────────────────────────────────────────────────────────────

export type WriteMode = 'approval_required' | 'auto_apply';

export interface Workspace {
  id: string;
  name: string;
  root: string;
  allowedGlobs: string[];
  blockedGlobs: string[];
  writeMode: WriteMode;
  createdAt: string;
}

export interface WorkspaceInput {
  name: string;
  root: string;
  allowedGlobs?: string[];
  blockedGlobs?: string[];
  writeMode?: WriteMode;
}

/**
 * Complete, per-workspace file-access policy replacement. The workspace
 * identity and root are intentionally not editable through this contract.
 */
export interface WorkspacePolicyUpdate {
  allowedGlobs: string[];
  blockedGlobs: string[];
}

// ─── Files ───────────────────────────────────────────────────────────────────

export interface FileEntry {
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface FileContent {
  relativePath: string;
  content: string;
  hash: string;
  sizeBytes: number;
  encoding: 'utf8';
}

export interface SearchMatch {
  relativePath: string;
  line: number;
  column: number;
  preview: string;
}

// ─── Changes ─────────────────────────────────────────────────────────────────

export interface ChangePreviewRequest {
  workspaceId: string;
  relativePath: string;
  newContent: string;
  baseHash?: string;
  reason?: string;
}

export type PendingChangeStatus = 'pending' | 'applied' | 'rejected' | 'expired';

export interface PendingChange {
  pendingChangeId: string;
  workspaceId: string;
  relativePath: string;
  baseHash: string | null;
  newHash: string;
  diff: string;
  reason?: string;
  warnings: string[];
  createdAt: string;
  expiresAt: string;
  status: PendingChangeStatus;
}

export interface ChangePreviewResult {
  pendingChangeId: string;
  workspaceId: string;
  relativePath: string;
  oldHash: string | null;
  newHash: string;
  diff: string;
  warnings: string[];
  safe: boolean;
  fileExists: boolean;
  expiresAt: string;
}

export interface ApplyChangeRequest {
  pendingChangeId: string;
}

export interface ApplyChangeResult {
  success: boolean;
  backupId: string;
  relativePath: string;
  oldHash: string | null;
  /** SHA-256 of the resulting file, or null when the resulting state is absent. */
  newHash: string | null;
  diff: string;
  auditId: string;
}

// ─── Audit ───────────────────────────────────────────────────────────────────

export type AuditAction = 'apply' | 'revert' | 'token_rotation' | 'terminal_command' | 'spreadsheet';

export interface AuditEntry {
  id: string;
  timestamp: string;
  action: AuditAction;
  workspaceId: string;
  workspaceName: string;
  relativePath: string;
  oldHash: string | null;
  /** SHA-256 of the resulting file, or null when the resulting state is absent. */
  newHash: string | null;
  backupId: string;
  reason?: string;
  revertedFromId?: string;
  command?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  durationMs?: number;
  operation?: string;
  operationSummary?: {
    affectedRange?: string | null;
    rowCount?: number;
    cellCount?: number;
    insertedRows?: number[];
    updatedRows?: number[];
  };
}

// ─── Navigation ──────────────────────────────────────────────────────────────

export interface TreeEntry {
  name: string;
  relativePath: string;
  type: 'file' | 'dir';
  sizeBytes?: number;
  children?: TreeEntry[];
}

export interface TreeResult {
  workspaceId: string;
  relativePath: string;
  tree: TreeEntry[];
  truncated: boolean;
  totalNodes: number;
}

export interface FileRangeContent {
  relativePath: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  lines: Array<{ lineNumber: number; content: string }>;
}

export interface FindFileMatch {
  relativePath: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface FindFileResult {
  workspaceId: string;
  query: string;
  matches: FindFileMatch[];
}

export interface RepoOverview {
  workspaceId: string;
  packageManager: string | null;
  rootFiles: string[];
  apps: string[];
  packages: string[];
  scripts: Record<string, string>;
}

export interface TerminalExecutionPolicy {
  commandMaxLength: number;
  outputMaxBytes: number;
  minimumTimeoutMs: number;
  synchronousDefaultTimeoutMs: number;
  synchronousMaxTimeoutMs: number;
  asynchronousDefaultTimeoutMs: number;
  supervisorLeaseMs: number;
  supervisorPollIntervalMs: number;
  completedRetentionMs: number;
}

/** Shared runtime policy consumed by core execution and derived API/MCP contracts. */
export const TERMINAL_EXECUTION_POLICY: Readonly<TerminalExecutionPolicy> = Object.freeze({
  commandMaxLength: 4_096,
  outputMaxBytes: 64 * 1024,
  minimumTimeoutMs: 100,
  synchronousDefaultTimeoutMs: 30_000,
  synchronousMaxTimeoutMs: 120_000,
  asynchronousDefaultTimeoutMs: 10 * 60_000,
  supervisorLeaseMs: 5 * 60_000,
  supervisorPollIntervalMs: 250,
  completedRetentionMs: 10 * 60_000,
});

export interface TerminalRunRequest {
  workspaceId: string;
  command: string;
  relativeCwd?: string;
  timeoutMs?: number;
}

export interface TerminalRunResult {
  command: string;
  relativeCwd: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

export type TerminalJobState = 'running' | 'stopping' | 'completed' | 'failed' | 'timed_out' | 'stopped';

export type TerminalJobTerminationReason =
  | 'explicit_stop'
  | 'lease_expired'
  | 'runtime_expired'
  | 'process_exit'
  | 'process_error'
  | 'worker_lost';

export interface TerminalJobResult extends TerminalRunResult {
  jobId: string;
  leaseId: string;
  state: TerminalJobState;
  processId: number | null;
  processStartedAt: string | null;
  workerProcessId: number | null;
  leaseExpiresAt: string | null;
  terminationReason: TerminalJobTerminationReason | null;
}

export interface TerminalJobRequest {
  workspaceId: string;
  jobId: string;
}

export interface TerminalJobRenewRequest extends TerminalJobRequest {
  leaseId: string;
}

// ─── Targeted Edits ──────────────────────────────────────────────────────────

export interface ReplaceRangeRequest {
  workspaceId: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  newContent: string;
  reason?: string;
}

export interface InsertLineRequest {
  workspaceId: string;
  relativePath: string;
  line: number;
  content: string;
  reason?: string;
}

// ─── API Responses ───────────────────────────────────────────────────────────

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiError {
  ok: false;
  error: string;
  code?: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;
