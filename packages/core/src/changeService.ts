import fs from 'fs';
import { nanoid } from 'nanoid';
import type {
  Workspace,
  ChangePreviewRequest,
  ChangePreviewResult,
  ApplyChangeResult,
  PendingChange,
  ReplaceRangeRequest,
  InsertLineRequest,
} from '@bridge/shared';
import { resolveAndGuard } from './pathGuard';
import { checkGlobAccess } from './globFilter';
import { loadBridgeIgnore } from './bridgeIgnore';
import { hashBuffer, hashContent } from './fileHash';
import { createUnifiedDiff } from './diffUtil';
import type { AuditLog } from './auditLog';
import type { PendingStore } from './pendingStore';
import { BackupStore, writeFileAtomically } from './backupStore';

export class ChangeService {
  private readonly backups: BackupStore;

  constructor(
    dataDir: string,
    private readonly auditLog: AuditLog,
    private readonly pendingStore: PendingStore
  ) {
    this.backups = new BackupStore(dataDir);
  }

  /** Create a pending change record and return the preview. No files are touched. */
  preview(workspace: Workspace, request: ChangePreviewRequest): ChangePreviewResult {
    const { relativePath, newContent, baseHash } = request;
    const warnings: string[] = [];

    const ignorePatterns = loadBridgeIgnore(workspace.root);
    const check = checkGlobAccess(relativePath, workspace, ignorePatterns);
    if (!check.allowed) {
      throw new Error(`Access denied: ${check.reason}`);
    }

    const absPath = resolveAndGuard(workspace.root, relativePath);
    const fileExists = fs.existsSync(absPath);

    let oldContent = '';
    let oldHash: string | null = null;

    if (fileExists) {
      oldContent = fs.readFileSync(absPath, 'utf8');
      oldHash = hashContent(oldContent);

      if (baseHash && oldHash !== baseHash) {
        warnings.push(
          `Hash mismatch: file has changed since base hash was captured. ` +
            `Provided: ${baseHash.slice(0, 8)}… Current: ${oldHash.slice(0, 8)}…`
        );
      }
    }

    const newHash = hashContent(newContent);
    const diff = createUnifiedDiff(relativePath, oldContent, newContent);

    const pending = this.pendingStore.create(
      { workspaceId: workspace.id, relativePath, baseHash: oldHash, newHash, diff, reason: request.reason, warnings },
      newContent
    );

    return {
      pendingChangeId: pending.pendingChangeId,
      workspaceId: workspace.id,
      relativePath,
      oldHash,
      newHash,
      diff,
      warnings,
      safe: true,
      fileExists,
      expiresAt: pending.expiresAt,
    };
  }

  previewReplaceRange(workspace: Workspace, req: ReplaceRangeRequest): ChangePreviewResult {
    const { relativePath, startLine, endLine, newContent, reason } = req;
    const { oldContent } = this._readForEdit(workspace, relativePath);
    const lines = oldContent.split('\n');
    const totalLines = lines.length;
    if (startLine < 1 || endLine < 1 || startLine > endLine || endLine > totalLines) {
      throw new Error(
        `Line range ${startLine}–${endLine} is invalid for file with ${totalLines} lines (1-indexed, inclusive)`
      );
    }
    const resultContent = [
      ...lines.slice(0, startLine - 1),
      ...newContent.split('\n'),
      ...lines.slice(endLine),
    ].join('\n');
    return this._createPendingPreview(workspace, relativePath, oldContent, resultContent, reason);
  }

  previewInsertBefore(workspace: Workspace, req: InsertLineRequest): ChangePreviewResult {
    const { relativePath, line, content, reason } = req;
    const { oldContent } = this._readForEdit(workspace, relativePath);
    const lines = oldContent.split('\n');
    const totalLines = lines.length;
    if (line < 1 || line > totalLines) {
      throw new Error(`line ${line} is out of range for file with ${totalLines} lines (1-indexed)`);
    }
    const resultContent = [
      ...lines.slice(0, line - 1),
      ...content.split('\n'),
      ...lines.slice(line - 1),
    ].join('\n');
    return this._createPendingPreview(workspace, relativePath, oldContent, resultContent, reason);
  }

  previewInsertAfter(workspace: Workspace, req: InsertLineRequest): ChangePreviewResult {
    const { relativePath, line, content, reason } = req;
    const { oldContent } = this._readForEdit(workspace, relativePath);
    const lines = oldContent.split('\n');
    const totalLines = lines.length;
    if (line < 1 || line > totalLines) {
      throw new Error(`line ${line} is out of range for file with ${totalLines} lines (1-indexed)`);
    }
    const resultContent = [
      ...lines.slice(0, line),
      ...content.split('\n'),
      ...lines.slice(line),
    ].join('\n');
    return this._createPendingPreview(workspace, relativePath, oldContent, resultContent, reason);
  }

  // Shared read + access-check for targeted edit methods.
  private _readForEdit(workspace: Workspace, relativePath: string): { oldContent: string } {
    const ignorePatterns = loadBridgeIgnore(workspace.root);
    const check = checkGlobAccess(relativePath, workspace, ignorePatterns);
    if (!check.allowed) throw new Error(`Access denied: ${check.reason}`);

    const absPath = resolveAndGuard(workspace.root, relativePath);
    if (!fs.existsSync(absPath)) throw new Error(`File not found: ${relativePath}`);

    const stat = fs.statSync(absPath);
    if (!stat.isFile()) throw new Error(`Not a file: ${relativePath}`);

    const oldContent = fs.readFileSync(absPath, 'utf8');
    if (oldContent.includes('\0')) throw new Error(`Binary files cannot be edited: ${relativePath}`);

    return { oldContent };
  }

  // Creates a PendingChange entry without touching the file on disk.
  private _createPendingPreview(
    workspace: Workspace,
    relativePath: string,
    oldContent: string,
    newContent: string,
    reason?: string
  ): ChangePreviewResult {
    const oldHash = hashContent(oldContent);
    const newHash = hashContent(newContent);
    const diff = createUnifiedDiff(relativePath, oldContent, newContent);
    const pending = this.pendingStore.create(
      { workspaceId: workspace.id, relativePath, baseHash: oldHash, newHash, diff, reason, warnings: [] },
      newContent
    );
    return {
      pendingChangeId: pending.pendingChangeId,
      workspaceId: workspace.id,
      relativePath,
      oldHash,
      newHash,
      diff,
      warnings: [],
      safe: true,
      fileExists: true,
      expiresAt: pending.expiresAt,
    };
  }

  /**
   * Preview + apply in a single call. Same glob/path/hash/backup/audit guards as
   * the two-step flow — it just composes preview() and applyPending() so a remote
   * caller (ChatGPT over the tunnel) spends one round trip instead of two.
   * Throws on stale baseHash via applyPending, same as the two-step path.
   */
  applyImmediate(workspace: Workspace, request: ChangePreviewRequest): ApplyChangeResult {
    const preview = this.preview(workspace, request);
    // preview() only *warns* on a stale caller-supplied baseHash (the pending
    // record captures the live hash). For a one-shot write there is no manual
    // review step to notice that warning, so enforce baseHash here — otherwise
    // it would silently clobber a concurrent edit.
    if (request.baseHash && preview.warnings.some((w) => w.startsWith('Hash mismatch'))) {
      throw new Error(
        'Hash mismatch: file changed since baseHash was captured. Re-read the file and retry.'
      );
    }
    return this.applyPending(workspace, preview.pendingChangeId);
  }

  /** Apply a pending change by its ID. Re-validates path and hash before writing. */
  applyPending(workspace: Workspace, pendingChangeId: string): ApplyChangeResult {
    const pending = this.pendingStore.get(pendingChangeId);
    if (!pending) throw new Error(`Pending change not found: ${pendingChangeId}`);
    if (pending.status === 'expired') throw new Error(`Pending change has expired: ${pendingChangeId}`);
    if (pending.status === 'applied') throw new Error(`Pending change already applied: ${pendingChangeId}`);
    if (pending.status === 'rejected') throw new Error(`Pending change was rejected: ${pendingChangeId}`);
    if (pending.workspaceId !== workspace.id) {
      throw new Error(`Pending change does not belong to workspace ${workspace.id}`);
    }

    const newContent = this.pendingStore.getContent(pendingChangeId);
    if (newContent === null) throw new Error(`Content missing for pending change: ${pendingChangeId}`);

    const { relativePath, reason } = pending;

    // Re-validate access (workspace config may have changed)
    const check = checkGlobAccess(relativePath, workspace);
    if (!check.allowed) throw new Error(`Access denied: ${check.reason}`);

    // Re-run path guard (apply time, not just preview time)
    const absPath = resolveAndGuard(workspace.root, relativePath);
    const fileExists = fs.existsSync(absPath);

    let oldContent = '';
    let oldHash: string | null = null;

    if (fileExists) {
      oldContent = fs.readFileSync(absPath, 'utf8');
      oldHash = hashContent(oldContent);

      // Re-check hash — file may have changed between preview and apply
      if (pending.baseHash && oldHash !== pending.baseHash) {
        throw new Error(
          `Hash mismatch: file changed between preview and apply. ` +
            `Create a new preview to see the current diff.`
        );
      }
    }

    const backupId = this.backups.create(
      workspace.id,
      relativePath,
      fileExists ? Buffer.from(oldContent, 'utf8') : null
    );

    writeFileAtomically(absPath, Buffer.from(newContent, 'utf8'));

    const newHash = hashContent(newContent);
    const diff = createUnifiedDiff(relativePath, oldContent, newContent);
    const auditId = nanoid(12);

    this.auditLog.append({
      id: auditId,
      timestamp: new Date().toISOString(),
      action: 'apply',
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      relativePath,
      oldHash,
      newHash,
      backupId,
      reason,
    });

    this.pendingStore.setStatus(pendingChangeId, 'applied');

    return { success: true, backupId, relativePath, oldHash, newHash, diff, auditId };
  }

  rejectPending(pendingChangeId: string): void {
    const pending = this.pendingStore.get(pendingChangeId);
    if (!pending) throw new Error(`Pending change not found: ${pendingChangeId}`);
    if (pending.status !== 'pending') {
      throw new Error(`Cannot reject a change with status "${pending.status}"`);
    }
    this.pendingStore.setStatus(pendingChangeId, 'rejected');
  }

  listPending(): PendingChange[] {
    return this.pendingStore.listPending();
  }

  revert(workspace: Workspace, auditId: string): ApplyChangeResult {
    const entry = this.auditLog.getById(auditId);
    if (!entry) throw new Error(`Audit entry not found: ${auditId}`);
    if (entry.workspaceId !== workspace.id) {
      throw new Error(`Audit entry ${auditId} does not belong to workspace ${workspace.id}`);
    }

    const backup = this.backups.read(entry.backupId, entry.relativePath);
    const backupContent = backup.content;
    const absPath = resolveAndGuard(workspace.root, entry.relativePath);

    let currentBuffer = Buffer.alloc(0);
    let currentHash: string | null = null;
    if (fs.existsSync(absPath)) {
      currentBuffer = fs.readFileSync(absPath);
      currentHash = hashBuffer(currentBuffer);
    }

    const newBackupId = this.backups.create(
      workspace.id,
      entry.relativePath,
      fs.existsSync(absPath) ? currentBuffer : null
    );

    if (!backup.existed) {
      if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
    } else {
      if (backupContent === null) throw new Error(`Backup content missing: ${entry.backupId}`);
      writeFileAtomically(absPath, backupContent);
    }

    const restoredContent = backup.existed ? backupContent!.toString('utf8') : '';
    const newHash = backup.existed ? hashBuffer(backupContent!) : null;
    const diff = entry.action === 'spreadsheet'
      ? 'Spreadsheet binary restored from backup.'
      : createUnifiedDiff(entry.relativePath, currentBuffer.toString('utf8'), restoredContent);
    const newAuditId = nanoid(12);

    this.auditLog.append({
      id: newAuditId,
      timestamp: new Date().toISOString(),
      action: 'revert',
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      relativePath: entry.relativePath,
      oldHash: currentHash,
      newHash,
      backupId: newBackupId,
      revertedFromId: auditId,
    });

    return {
      success: true,
      backupId: newBackupId,
      relativePath: entry.relativePath,
      oldHash: currentHash,
      newHash,
      diff,
      auditId: newAuditId,
    };
  }

}
