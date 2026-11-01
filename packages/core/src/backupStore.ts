import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';

export interface BackupReadResult {
  existed: boolean;
  content: Buffer | null;
}

/** Shared backup boundary for text and binary workspace mutations. */
export class BackupStore {
  constructor(private readonly dataDir: string) {}

  create(workspaceId: string, relativePath: string, content: Buffer | null): string {
    const backupId = `${Date.now()}-${nanoid(6)}`;
    const backupDir = path.join(this.dataDir, 'backups', backupId);
    fs.mkdirSync(backupDir, { recursive: true });

    fs.writeFileSync(
      path.join(backupDir, 'meta.json'),
      JSON.stringify({
        workspaceId,
        relativePath,
        existed: content !== null,
        timestamp: new Date().toISOString(),
      }, null, 2),
      'utf8'
    );

    if (content !== null) {
      const safeFileName = relativePath.replace(/[/\\]/g, '__');
      fs.writeFileSync(path.join(backupDir, safeFileName), content);
    }

    return backupId;
  }

  read(backupId: string, relativePath: string): BackupReadResult {
    const backupDir = path.join(this.dataDir, 'backups', backupId);
    const metaPath = path.join(backupDir, 'meta.json');
    if (!fs.existsSync(metaPath)) throw new Error(`Backup not found: ${backupId}`);

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as {
      relativePath?: string;
      existed?: boolean;
    };
    if (meta.relativePath !== relativePath) throw new Error(`Backup path mismatch: ${backupId}`);
    if (!meta.existed) return { existed: false, content: null };

    const safeFileName = relativePath.replace(/[/\\]/g, '__');
    return { existed: true, content: fs.readFileSync(path.join(backupDir, safeFileName)) };
  }
}

/** Same-directory temp write followed by rename, so synced files never vanish mid-save. */
export function writeFileAtomically(filePath: string, content: Buffer, beforeReplace?: (tempPath: string) => void): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${nanoid(8)}.tmp`);
  try {
    const fd = fs.openSync(tempPath, 'wx');
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    beforeReplace?.(tempPath);
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* preserve the original failure */ }
    throw error;
  }
}
