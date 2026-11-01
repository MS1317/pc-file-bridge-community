import { useState, useEffect, useCallback, useRef } from 'react';
import type { AuditEntry, Workspace } from '@bridge/shared';
import { api } from '../api';

export default function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reverting, setReverting] = useState<string | null>(null);
  const refreshing = useRef(false);

  const load = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const [auditRes, wsRes] = await Promise.all([
        api.recentChanges(100),
        api.listWorkspaces(),
      ]);
      if (auditRes.ok) {
        setEntries(auditRes.data);
        setError('');
      } else setError(auditRes.error);
      if (wsRes.ok) setWorkspaces(wsRes.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh audit log.');
    } finally {
      refreshing.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => { void load(); }, 5_000);
    return () => window.clearInterval(interval);
  }, [load]);

  async function handleRevert(entry: AuditEntry) {
    if (!confirm(`Revert change to "${entry.relativePath}"? The file will be restored to the state before this change.`)) return;
    setReverting(entry.id);
    const r = await api.revertChange(entry.workspaceId, entry.id);
    setReverting(null);
    if (r.ok) {
      alert(`Reverted! New audit ID: ${r.data.auditId}`);
      load();
    } else {
      alert(`Revert failed: ${r.error}`);
    }
  }

  function canRevert(entry: AuditEntry): boolean {
    return entry.action === 'apply' && workspaces.some((w) => w.id === entry.workspaceId);
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>Audit Log</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            Every file change, revert, and terminal command is recorded here. Most recent first. Refreshes automatically every 5 seconds.
          </p>
        </div>
        <button className="btn-ghost" onClick={load}>Refresh</button>
      </div>

      {error && <div className="error-msg" style={{ marginBottom: 12 }}>{error}</div>}
      {loading && <div style={{ color: 'var(--text-muted)' }}>Loading…</div>}

      {!loading && entries.length === 0 && (
        <div className="empty">No changes recorded yet.</div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {entries.map((entry) => (
          <div key={entry.id} className="card" style={{ padding: '14px 18px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 6 }}>
                  <span style={{
                    fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
                    background: entry.action === 'apply'
                      ? 'rgba(124,106,247,0.18)' : 'rgba(76,175,130,0.18)',
                    color: entry.action === 'apply' ? 'var(--accent)' : 'var(--success)',
                    textTransform: 'uppercase',
                  }}>
                    {entry.action}
                  </span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
                    {entry.action === 'terminal_command' ? entry.command : entry.relativePath}
                  </span>
                  <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                    in {entry.workspaceName}
                  </span>
                </div>

                <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--text-muted)' }}>
                  <span>{new Date(entry.timestamp).toLocaleString()}</span>
                  <span>ID: <code style={{ color: 'var(--code)' }}>{entry.id}</code></span>
                  {entry.action !== 'terminal_command' && (
                    <span>Backup: <code style={{ color: 'var(--code)' }}>{entry.backupId}</code></span>
                  )}
                  {entry.action === 'terminal_command' && (
                    <>
                      <span>CWD: <code style={{ color: 'var(--code)' }}>{entry.relativePath}</code></span>
                      <span>Exit: {entry.timedOut ? 'timed out' : entry.exitCode}</span>
                      <span>{entry.durationMs}ms</span>
                    </>
                  )}
                  {entry.reason && <span>Reason: {entry.reason}</span>}
                  {entry.revertedFromId && (
                    <span style={{ color: 'var(--success)' }}>← reverted {entry.revertedFromId}</span>
                  )}
                </div>

                {entry.action !== 'terminal_command' && <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  <span>Old: <code style={{ color: 'var(--code)' }}>{entry.oldHash?.slice(0, 10) ?? 'none'}…</code></span>
                  <span>New: <code style={{ color: 'var(--code)' }}>{entry.newHash?.slice(0, 10) ?? 'none'}…</code></span>
                </div>}
              </div>

              {canRevert(entry) && (
                <button
                  className="btn-ghost"
                  style={{ fontSize: 12, whiteSpace: 'nowrap' }}
                  disabled={reverting === entry.id}
                  onClick={() => handleRevert(entry)}
                >
                  {reverting === entry.id ? 'Reverting…' : 'Revert'}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
