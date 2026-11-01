import fs from 'fs';
import os from 'os';
import path from 'path';
import type { SpreadsheetWriteResult, Workspace } from '@bridge/shared';
import { parseSpreadsheetRequest } from '@bridge/shared';
import { AuditLog } from '../auditLog';
import { ChangeService } from '../changeService';
import { hashBuffer } from '../fileHash';
import { PendingStore } from '../pendingStore';
import { SpreadsheetService } from '../spreadsheetService';
import { XlsxSpreadsheetProvider } from '../xlsxProvider';

describe('generic file mutation state and revert', () => {
  let root: string;
  let dataDir: string;
  let workspace: Workspace;
  let auditLog: AuditLog;
  let changes: ChangeService;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-change-workspace-'));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-change-data-'));
    workspace = {
      id: 'generic-change-ws',
      name: 'Generic Change Fixture',
      root,
      allowedGlobs: ['**/*.txt', '**/*.xlsx'],
      blockedGlobs: [],
      writeMode: 'approval_required',
      createdAt: new Date().toISOString(),
    };
    auditLog = new AuditLog(dataDir);
    changes = new ChangeService(dataDir, auditLog, new PendingStore());
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('reports absence after reverting a newly created text file and supports revert-of-revert', () => {
    const applied = changes.applyImmediate(workspace, {
      workspaceId: workspace.id,
      relativePath: 'created.txt',
      newContent: 'created',
    });
    const filePath = path.join(root, 'created.txt');
    expect(fs.existsSync(filePath)).toBe(true);

    const reverted = changes.revert(workspace, applied.auditId);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(reverted.newHash).toBeNull();
    expect(JSON.parse(JSON.stringify(reverted)).newHash).toBeNull();
    expect(auditLog.getById(reverted.auditId)?.newHash).toBeNull();

    const restored = changes.revert(workspace, reverted.auditId);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(restored.newHash).toBe(applied.newHash);
    expect(hashBuffer(fs.readFileSync(filePath))).toBe(applied.newHash);
  });

  it('distinguishes a present zero-byte file from an absent file', () => {
    const filePath = path.join(root, 'empty.txt');
    fs.writeFileSync(filePath, Buffer.alloc(0));

    const applied = changes.applyImmediate(workspace, {
      workspaceId: workspace.id,
      relativePath: 'empty.txt',
      newContent: 'temporary content',
    });
    const reverted = changes.revert(workspace, applied.auditId);

    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.statSync(filePath).size).toBe(0);
    expect(reverted.newHash).toBe(hashBuffer(Buffer.alloc(0)));
    expect(reverted.newHash).not.toBeNull();
  });

  it('restores the exact prior hash for an existing non-empty file', () => {
    const filePath = path.join(root, 'existing.txt');
    const before = Buffer.from('before\n');
    fs.writeFileSync(filePath, before);

    const applied = changes.applyImmediate(workspace, {
      workspaceId: workspace.id,
      relativePath: 'existing.txt',
      newContent: 'after\n',
    });
    const reverted = changes.revert(workspace, applied.auditId);

    expect(fs.readFileSync(filePath)).toEqual(before);
    expect(reverted.newHash).toBe(hashBuffer(before));
  });

  it('uses the same generic revert/audit path for a created binary workbook', async () => {
    const spreadsheets = new SpreadsheetService(dataDir, auditLog);
    const created = await spreadsheets.execute(workspace, 'create_spreadsheet', parseSpreadsheetRequest('create_spreadsheet', {
      workspaceId: workspace.id,
      relativePath: 'created.xlsx',
      sheets: [{ name: 'Sheet1', headers: ['Value'], rows: [[1]] }],
    })) as SpreadsheetWriteResult;
    const filePath = path.join(root, 'created.xlsx');

    const reverted = changes.revert(workspace, created.auditId);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(reverted.newHash).toBeNull();

    const restored = changes.revert(workspace, reverted.auditId);
    expect(fs.existsSync(filePath)).toBe(true);
    new XlsxSpreadsheetProvider().validate(fs.readFileSync(filePath));
    expect(restored.newHash).toBe(hashBuffer(fs.readFileSync(filePath)));
  });
});
