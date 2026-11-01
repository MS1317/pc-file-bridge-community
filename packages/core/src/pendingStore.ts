import { nanoid } from 'nanoid';
import type { PendingChange, PendingChangeStatus } from '@bridge/shared';

const PENDING_TTL_MS = 30 * 60 * 1000; // 30 minutes

export interface PendingCreateInput {
  workspaceId: string;
  relativePath: string;
  baseHash: string | null;
  newHash: string;
  diff: string;
  reason?: string;
  warnings: string[];
}

/**
 * In-memory store for pending changes.
 * Entries expire after 30 minutes and are purged lazily on access.
 * NOTE: entries are lost on API restart — intentional for v1.
 * The full newContent is stored separately so the PendingChange type (shared with
 * the dashboard) never contains large content blobs.
 */
export class PendingStore {
  private store = new Map<string, PendingChange>();
  private contentStore = new Map<string, string>(); // pendingChangeId → newContent

  create(input: PendingCreateInput, newContent: string): PendingChange {
    const now = new Date();
    const pending: PendingChange = {
      pendingChangeId: nanoid(16),
      workspaceId: input.workspaceId,
      relativePath: input.relativePath,
      baseHash: input.baseHash,
      newHash: input.newHash,
      diff: input.diff,
      reason: input.reason,
      warnings: input.warnings,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + PENDING_TTL_MS).toISOString(),
      status: 'pending',
    };
    this.store.set(pending.pendingChangeId, pending);
    this.contentStore.set(pending.pendingChangeId, newContent);
    return pending;
  }

  get(id: string): PendingChange | null {
    const entry = this.store.get(id);
    if (!entry) return null;
    if (this.isExpired(entry)) {
      const expired = { ...entry, status: 'expired' as PendingChangeStatus };
      this.store.set(id, expired);
      return expired;
    }
    return entry;
  }

  getContent(id: string): string | null {
    return this.contentStore.get(id) ?? null;
  }

  setStatus(id: string, status: PendingChangeStatus): void {
    const entry = this.store.get(id);
    if (entry) this.store.set(id, { ...entry, status });
    if (status === 'applied' || status === 'rejected') {
      this.contentStore.delete(id);
    }
  }

  listPending(): PendingChange[] {
    this.pruneExpired();
    return [...this.store.values()].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  private isExpired(entry: PendingChange): boolean {
    return entry.status === 'pending' && Date.now() > new Date(entry.expiresAt).getTime();
  }

  private pruneExpired(): void {
    for (const [id, entry] of this.store) {
      if (this.isExpired(entry)) {
        this.store.set(id, { ...entry, status: 'expired' });
        this.contentStore.delete(id);
      }
      if (Date.now() - new Date(entry.createdAt).getTime() > PENDING_TTL_MS * 2) {
        this.store.delete(id);
        this.contentStore.delete(id);
      }
    }
  }
}
