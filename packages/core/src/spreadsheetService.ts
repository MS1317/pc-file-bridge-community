import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import type {
  AppendSpreadsheetRowsRequest,
  CreateSpreadsheetRequest,
  CreateSpreadsheetSheetRequest,
  InspectSpreadsheetRequest,
  ReadSpreadsheetRangeRequest,
  SearchSpreadsheetRequest,
  SpreadsheetActionName,
  SpreadsheetActionRequest,
  SpreadsheetActionResult,
  SpreadsheetFailureKind,
  SpreadsheetFormat,
  SpreadsheetInspection,
  SpreadsheetWriteResult,
  UpdateSpreadsheetRangeRequest,
  UpdateSpreadsheetRowsByKeyRequest,
  UpsertSpreadsheetRowsRequest,
  Workspace,
} from '@bridge/shared';
import {
  isSpreadsheetActionName,
  spreadsheetFormatForPath,
  SpreadsheetContractError,
  SPREADSHEET_LIMITS,
} from '@bridge/shared';
import { checkGlobAccess } from './globFilter';
import { loadBridgeIgnore } from './bridgeIgnore';
import { PathGuardError, resolveAndGuard } from './pathGuard';
import { hashBuffer } from './fileHash';
import type { AuditLog } from './auditLog';
import { BackupStore, writeFileAtomically } from './backupStore';
import { XlsxSpreadsheetProvider, type SpreadsheetProvider, type SpreadsheetProviderMutation } from './xlsxProvider';

export class SpreadsheetError extends Error {
  constructor(
    public readonly kind: SpreadsheetFailureKind,
    message: string,
    public readonly diagnostics?: string
  ) {
    super(message);
    this.name = 'SpreadsheetError';
  }
}

interface TargetFile {
  absolutePath: string;
  format: SpreadsheetFormat;
}

interface LoadedFile extends TargetFile {
  buffer: Buffer;
  hash: string;
}

interface MutationOptions {
  baseHash?: string;
  reason?: string;
  mustExist: boolean;
}

// ponytail: process-local lock; baseHash plus atomic replace protects separate bridge processes.
let pathLocks = new Map<string, Promise<void>>();

async function withPathLock<T>(absolutePath: string, task: () => Promise<T>): Promise<T> {
  const previous = pathLocks.get(absolutePath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  pathLocks.set(absolutePath, current);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (pathLocks.get(absolutePath) === current) pathLocks.delete(absolutePath);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asSpreadsheetError(error: unknown, fallback: SpreadsheetFailureKind): SpreadsheetError {
  if (error instanceof SpreadsheetError) return error;
  if (error instanceof SpreadsheetContractError) return new SpreadsheetError(error.kind, error.message, error.message);
  if (error instanceof PathGuardError) return new SpreadsheetError('permission_denied', error.message);
  const message = error instanceof Error ? error.message : 'Spreadsheet operation failed';
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
  const kind: SpreadsheetFailureKind = code === 'ENOENT'
    ? 'spreadsheet_file_not_found'
    : ['EACCES', 'EPERM', 'EBUSY', 'ETXTBSY'].includes(code)
      ? 'workbook_locked'
      : fallback;
  return new SpreadsheetError(kind, message, message);
}

export class SpreadsheetService {
  private readonly backups: BackupStore;

  constructor(
    dataDir: string,
    private readonly auditLog: AuditLog,
    private readonly provider: SpreadsheetProvider = new XlsxSpreadsheetProvider()
  ) {
    this.backups = new BackupStore(dataDir);
  }

  async execute(workspace: Workspace, action: SpreadsheetActionName, request: SpreadsheetActionRequest): Promise<SpreadsheetActionResult> {
    if (!isSpreadsheetActionName(action)) throw new SpreadsheetError('invalid_request', `Unsupported spreadsheet action: ${action}`);
    if (request.workspaceId !== workspace.id) throw new SpreadsheetError('permission_denied', 'Spreadsheet workspace does not match the registered workspace');
    switch (action) {
      case 'inspect_spreadsheet': return this.inspect(workspace, request as InspectSpreadsheetRequest);
      case 'read_spreadsheet_range': return this.readRange(workspace, request as ReadSpreadsheetRangeRequest);
      case 'search_spreadsheet': return this.search(workspace, request as SearchSpreadsheetRequest);
      case 'append_spreadsheet_rows': return this.appendRows(workspace, request as AppendSpreadsheetRowsRequest);
      case 'update_spreadsheet_range': return this.updateRange(workspace, request as UpdateSpreadsheetRangeRequest);
      case 'update_spreadsheet_rows_by_key': return this.updateRowsByKey(workspace, request as UpdateSpreadsheetRowsByKeyRequest);
      case 'upsert_spreadsheet_rows': return this.upsertRows(workspace, request as UpsertSpreadsheetRowsRequest);
      case 'create_spreadsheet': return this.createWorkbook(workspace, request as CreateSpreadsheetRequest);
      case 'create_spreadsheet_sheet': return this.createSheet(workspace, request as CreateSpreadsheetSheetRequest);
    }
  }

  private target(workspace: Workspace, relativePath: string): TargetFile {
    const format = spreadsheetFormatForPath(relativePath);
    if (!format) throw new SpreadsheetError('unsupported_spreadsheet_format', `Only .xlsx workbooks are supported: ${relativePath}`);

    const check = checkGlobAccess(relativePath, workspace, loadBridgeIgnore(workspace.root));
    if (!check.allowed) throw new SpreadsheetError('permission_denied', `Access denied: ${check.reason}`);
    let absolutePath: string;
    try {
      absolutePath = resolveAndGuard(workspace.root, relativePath);
    } catch (error) {
      throw asSpreadsheetError(error, 'permission_denied');
    }
    return { absolutePath, format };
  }

  private load(workspace: Workspace, relativePath: string): LoadedFile {
    const target = this.target(workspace, relativePath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(target.absolutePath);
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') throw new SpreadsheetError('spreadsheet_file_not_found', `Spreadsheet file was not found: ${relativePath}`);
      throw asSpreadsheetError(error, 'permission_denied');
    }
    if (!stat.isFile()) throw new SpreadsheetError('spreadsheet_file_not_found', `Spreadsheet path is not a file: ${relativePath}`);
    if (stat.size > SPREADSHEET_LIMITS.maxWorkbookBytes) {
      throw new SpreadsheetError('workbook_too_large', `Workbook is ${stat.size} bytes; max is ${SPREADSHEET_LIMITS.maxWorkbookBytes}`);
    }
    try {
      const buffer = fs.readFileSync(target.absolutePath);
      if (buffer.length > SPREADSHEET_LIMITS.maxWorkbookBytes) {
        throw new SpreadsheetError('workbook_too_large', `Workbook exceeds ${SPREADSHEET_LIMITS.maxWorkbookBytes} bytes`);
      }
      return { ...target, buffer, hash: hashBuffer(buffer) };
    } catch (error) {
      throw asSpreadsheetError(error, 'permission_denied');
    }
  }

  private providerCall<T>(call: () => T, fallback: SpreadsheetFailureKind = 'workbook_invalid'): T {
    try {
      return call();
    } catch (error) {
      throw asSpreadsheetError(error, fallback);
    }
  }

  private inspect(workspace: Workspace, request: InspectSpreadsheetRequest): SpreadsheetInspection {
    const file = this.load(workspace, request.relativePath);
    return this.providerCall(() => this.provider.inspect(file.buffer, workspace.id, request.relativePath, file.hash));
  }

  private readRange(workspace: Workspace, request: ReadSpreadsheetRangeRequest) {
    const file = this.load(workspace, request.relativePath);
    return this.providerCall(() => this.provider.readRange(file.buffer, request, file.hash));
  }

  private search(workspace: Workspace, request: SearchSpreadsheetRequest) {
    const file = this.load(workspace, request.relativePath);
    return this.providerCall(() => this.provider.search(file.buffer, request, file.hash));
  }

  private appendRows(workspace: Workspace, request: AppendSpreadsheetRowsRequest): Promise<SpreadsheetWriteResult> {
    return this.mutate(workspace, request.relativePath, 'append_rows', request.reason, { baseHash: request.baseHash, mustExist: true }, (buffer) => this.provider.appendRows(buffer, request));
  }

  private updateRange(workspace: Workspace, request: UpdateSpreadsheetRangeRequest): Promise<SpreadsheetWriteResult> {
    return this.mutate(workspace, request.relativePath, 'update_range', request.reason, { baseHash: request.baseHash, mustExist: true }, (buffer) => this.provider.updateRange(buffer, request));
  }

  private updateRowsByKey(workspace: Workspace, request: UpdateSpreadsheetRowsByKeyRequest): Promise<SpreadsheetWriteResult> {
    return this.mutate(workspace, request.relativePath, 'update_rows_by_key', request.reason, { baseHash: request.baseHash, mustExist: true }, (buffer) => this.provider.updateRowsByKey(buffer, request));
  }

  private upsertRows(workspace: Workspace, request: UpsertSpreadsheetRowsRequest): Promise<SpreadsheetWriteResult> {
    return this.mutate(workspace, request.relativePath, 'upsert_rows', request.reason, { baseHash: request.baseHash, mustExist: true }, (buffer) => this.provider.upsertRows(buffer, request));
  }

  private createWorkbook(workspace: Workspace, request: CreateSpreadsheetRequest): Promise<SpreadsheetWriteResult> {
    return this.mutate(workspace, request.relativePath, 'create', request.reason, { mustExist: false }, () => this.provider.createWorkbook(request));
  }

  private createSheet(workspace: Workspace, request: CreateSpreadsheetSheetRequest): Promise<SpreadsheetWriteResult> {
    return this.mutate(workspace, request.relativePath, 'create_sheet', request.reason, { baseHash: request.baseHash, mustExist: true }, (buffer) => this.provider.createSheet(buffer, request));
  }

  private async mutate(
    workspace: Workspace,
    relativePath: string,
    operation: SpreadsheetWriteResult['operation'],
    reason: string | undefined,
    options: MutationOptions,
    mutation: (buffer: Buffer) => SpreadsheetProviderMutation
  ): Promise<SpreadsheetWriteResult> {
    const target = this.target(workspace, relativePath);
    return withPathLock(target.absolutePath, async () => {
      let exists: boolean;
      let before = Buffer.alloc(0);
      try {
        exists = fs.existsSync(target.absolutePath);
        if (options.mustExist && !exists) throw new SpreadsheetError('spreadsheet_file_not_found', `Spreadsheet file was not found: ${relativePath}`);
        if (!options.mustExist && exists) throw new SpreadsheetError('file_exists', `Spreadsheet file already exists: ${relativePath}`);
        if (exists && !fs.statSync(target.absolutePath).isFile()) throw new SpreadsheetError('spreadsheet_file_not_found', `Spreadsheet path is not a file: ${relativePath}`);
        if (exists) {
          before = fs.readFileSync(target.absolutePath);
          if (before.length > SPREADSHEET_LIMITS.maxWorkbookBytes) throw new SpreadsheetError('workbook_too_large', `Workbook exceeds ${SPREADSHEET_LIMITS.maxWorkbookBytes} bytes`);
        }
      } catch (error) {
        throw asSpreadsheetError(error, 'permission_denied');
      }
      const beforeHash = exists ? hashBuffer(before) : null;
      if (options.baseHash !== undefined && options.baseHash !== beforeHash) {
        throw new SpreadsheetError('concurrent_modification', 'Workbook changed since the supplied baseHash; re-read it and retry');
      }

      let plan: SpreadsheetProviderMutation;
      try {
        plan = this.providerCall(() => mutation(before), 'invalid_request');
        if (plan.buffer.length > SPREADSHEET_LIMITS.maxWorkbookBytes) throw new SpreadsheetError('workbook_too_large', `Generated workbook exceeds ${SPREADSHEET_LIMITS.maxWorkbookBytes} bytes`);
      } catch (error) {
        throw asSpreadsheetError(error, 'invalid_request');
      }

      let backupId: string;
      try {
        backupId = this.backups.create(workspace.id, relativePath, exists ? before : null);
      } catch (error) {
        throw asSpreadsheetError(error, 'write_failed');
      }
      let replaced = false;
      try {
        writeFileAtomically(target.absolutePath, plan.buffer, (tempPath) => {
          const candidate = fs.readFileSync(tempPath);
          this.providerCall(() => this.provider.validate(candidate));
          this.providerCall(() => plan.verify(candidate), 'verification_failed');
        });
        replaced = true;
        const readBack = fs.readFileSync(target.absolutePath);
        const afterHash = hashBuffer(readBack);
        this.providerCall(() => this.provider.validate(readBack));
        this.providerCall(() => plan.verify(readBack), 'verification_failed');

        const auditId = nanoid(12);
        this.auditLog.append({
          id: auditId,
          timestamp: new Date().toISOString(),
          action: 'spreadsheet',
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          relativePath,
          oldHash: beforeHash,
          newHash: afterHash,
          backupId,
          reason,
          operation,
          operationSummary: {
            affectedRange: plan.affectedRange,
            rowCount: plan.rowCount,
            cellCount: plan.cellCount,
            insertedRows: plan.insertedRows,
            updatedRows: plan.updatedRows,
          },
        });

        return {
          success: true,
          workspaceId: workspace.id,
          relativePath,
          format: target.format,
          operation,
          beforeHash,
          afterHash,
          backupId,
          auditId,
          writeStatus: { requested: true, validated: true, written: true, verified: true },
          verificationStatus: 'verified',
          affectedRange: plan.affectedRange,
          rowCount: plan.rowCount,
          cellCount: plan.cellCount,
          insertedRows: plan.insertedRows,
          updatedRows: plan.updatedRows,
          warnings: plan.warnings,
        };
      } catch (error) {
        let rollback = replaced ? 'required' : 'not_required';
        if (replaced) {
          try {
            if (exists) writeFileAtomically(target.absolutePath, before);
            else if (fs.existsSync(target.absolutePath)) fs.unlinkSync(target.absolutePath);
            rollback = 'succeeded';
          } catch (restoreError) {
            throw new SpreadsheetError(
              'write_failed',
              'Spreadsheet write failed and the original could not be restored',
              'relativePath=' + relativePath + '; destinationReplaced=true; rollback=failed; ' + String(restoreError),
            );
          }
        }
        const failure = asSpreadsheetError(error, 'write_failed');
        throw new SpreadsheetError(
          failure.kind,
          failure.message,
          [failure.diagnostics ?? failure.message, 'relativePath=' + relativePath, 'destinationReplaced=' + replaced, 'rollback=' + rollback, 'backupId=' + backupId].join('; '),
        );
      }
    });
  }
}
