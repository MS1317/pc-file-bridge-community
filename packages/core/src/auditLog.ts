import fs from 'fs';
import path from 'path';
import type { AuditEntry } from '@bridge/shared';

export class AuditLog {
  private logPath: string;

  constructor(dataDir: string) {
    this.logPath = path.join(dataDir, 'audit-log.jsonl');
    this.ensureFile();
  }

  private ensureFile(): void {
    if (!fs.existsSync(this.logPath)) {
      fs.writeFileSync(this.logPath, '', 'utf8');
    }
  }

  append(entry: AuditEntry): void {
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(this.logPath, line, 'utf8');
  }

  readRecent(limit = 50): AuditEntry[] {
    const raw = fs.readFileSync(this.logPath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const entries = lines.map((l) => JSON.parse(l) as AuditEntry);
    return entries.slice(-limit).reverse();
  }

  getById(id: string): AuditEntry | null {
    const raw = fs.readFileSync(this.logPath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    for (const line of lines) {
      const entry = JSON.parse(line) as AuditEntry;
      if (entry.id === id) return entry;
    }
    return null;
  }
}
