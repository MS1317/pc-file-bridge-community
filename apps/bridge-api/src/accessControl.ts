import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface AccessPolicy {
  fileWrites: boolean;
  terminal: boolean;
  requireApproval: boolean;
}

export type AccessKind = 'fileWrites' | 'terminal';
export type ApprovalState = 'pending' | 'executing' | 'approved' | 'rejected' | 'failed' | 'expired';

export interface ApprovalRequest {
  approvalId: string;
  kind: AccessKind;
  action: string;
  workspaceId: string;
  description: string;
  details: Record<string, string>;
  state: ApprovalState;
  createdAt: string;
  expiresAt: string;
  result?: unknown;
  error?: string;
}

interface PendingApproval {
  record: ApprovalRequest;
  execute: () => Promise<unknown> | unknown;
}

const DEFAULT_POLICY: AccessPolicy = {
  fileWrites: false,
  terminal: false,
  requireApproval: true,
};
const APPROVAL_TTL_MS = 10 * 60_000;
const MAX_REQUESTS = 100;

export class AccessControl {
  private readonly file: string;
  private policy: AccessPolicy;
  private readonly requests = new Map<string, PendingApproval>();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'access-policy.json');
    this.policy = { ...DEFAULT_POLICY };
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<AccessPolicy>;
      if (typeof saved.fileWrites === 'boolean') this.policy.fileWrites = saved.fileWrites;
      if (typeof saved.terminal === 'boolean') this.policy.terminal = saved.terminal;
      if (typeof saved.requireApproval === 'boolean') this.policy.requireApproval = saved.requireApproval;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('Unable to read access policy: ' + String(error));
      }
    }
  }

  getPolicy(): AccessPolicy {
    return { ...this.policy };
  }

  setPolicy(input: unknown): AccessPolicy {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid access policy');
    const body = input as Record<string, unknown>;
    if (typeof body.fileWrites !== 'boolean' || typeof body.terminal !== 'boolean' ||
        typeof body.requireApproval !== 'boolean') {
      throw new Error('fileWrites, terminal and requireApproval must be booleans');
    }
    const next: AccessPolicy = {
      fileWrites: body.fileWrites,
      terminal: body.terminal,
      requireApproval: body.requireApproval,
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = this.file + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    this.policy = next;
    for (const request of this.requests.values()) {
      if (request.record.state === 'pending' && !next[request.record.kind]) request.record.state = 'rejected';
    }
    return this.getPolicy();
  }

  private expire(): void {
    const now = Date.now();
    for (const [id, entry] of this.requests) {
      if (entry.record.state === 'pending' && Date.parse(entry.record.expiresAt) <= now) {
        entry.record.state = 'expired';
      }
      if (Date.parse(entry.record.createdAt) < now - 60 * 60_000) this.requests.delete(id);
    }
  }

  submit(
    kind: AccessKind,
    action: string,
    workspaceId: string,
    description: string,
    details: Record<string, string>,
    execute: () => Promise<unknown> | unknown,
  ): Promise<unknown> | ApprovalRequest {
    if (!this.policy[kind]) throw new Error(kind + ' is disabled in Dashboard > Access Control');
    if (!this.policy.requireApproval) return Promise.resolve().then(execute);
    this.expire();
    if (Array.from(this.requests.values()).filter((r) => r.record.state === 'pending').length >= MAX_REQUESTS) {
      throw new Error('Too many pending approvals; review or reject outstanding requests');
    }
    const now = Date.now();
    const record: ApprovalRequest = {
      approvalId: crypto.randomUUID(),
      kind, action, workspaceId, description, details, state: 'pending',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + APPROVAL_TTL_MS).toISOString(),
    };
    this.requests.set(record.approvalId, { record, execute });
    return { ...record };
  }

  list(): ApprovalRequest[] {
    this.expire();
    return Array.from(this.requests.values()).map(({ record }) => ({ ...record, result: undefined }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  status(id: string): ApprovalRequest | undefined {
    this.expire();
    const item = this.requests.get(id);
    return item ? { ...item.record } : undefined;
  }

  reject(id: string): ApprovalRequest {
    this.expire();
    const item = this.requests.get(id);
    if (!item || item.record.state !== 'pending') throw new Error('Approval request unavailable or already handled');
    item.record.state = 'rejected';
    return { ...item.record };
  }

  async approve(id: string): Promise<ApprovalRequest> {
    this.expire();
    const item = this.requests.get(id);
    if (!item || item.record.state !== 'pending') throw new Error('Approval request unavailable or already handled');
    if (!this.policy[item.record.kind]) throw new Error('Capability disabled; request cannot be approved');
    item.record.state = 'executing';
    try {
      item.record.result = await item.execute();
      item.record.state = 'approved';
    } catch (error) {
      item.record.state = 'failed';
      item.record.error = error instanceof Error ? error.message : 'Operation failed';
    }
    return { ...item.record };
  }
}
