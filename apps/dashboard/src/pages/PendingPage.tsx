import { useState, useEffect, useCallback } from 'react';
import type { PendingChange } from '@bridge/shared';
import { api } from '../api';
import { DiffView } from './DiffPage';

export default function PendingPage() {
  const [items, setItems] = useState<PendingChange[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const r = await api.listPending();
    setLoading(false);
    if (r.ok) setItems(r.data);
    else setError(r.error);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleApply(item: PendingChange) {
    if (!confirm(`Apply change to "${item.relativePath}"?`)) return;
    setBusy(item.pendingChangeId); setMsg(''); setError('');
    const r = await api.applyChange(item.workspaceId, item.pendingChangeId);
    setBusy(null);
    if (r.ok) { setMsg(`✓ Applied: ${r.data.auditId}`); load(); }
    else setError(r.error);
  }

  async function handleReject(item: PendingChange) {
    if (!confirm(`Reject change to "${item.relativePath}"?`)) return;
    setBusy(item.pendingChangeId); setMsg(''); setError('');
    const r = await api.rejectChange(item.pendingChangeId);
    setBusy(null);
    if (r.ok) { setMsg('Change rejected.'); load(); }
    else setError(r.error);
  }

  const statusColor: Record<string, string> = {
    pending: 'var(--warning)',
    applied: 'var(--success)',
    rejected: 'var(--danger)',
    expired: 'var(--text-muted)',
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700 }}>Pending Changes</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 4 }}>
            Changes awaiting approval. Expire after 30 minutes. Lost on API restart.
          </p>
        </div>
        <button className="btn-ghost" onClick={load} disabled={loading}>Refresh</button>
      </div>

      {error && <div className="error-msg" style={{ marginBottom: 12 }}>{error}</div>}
      {msg && <div className="success-msg" style={{ marginBottom: 12 }}>{msg}</div>}
      {loading && <div style={{ color: 'var(--text-muted)' }}>Loading…</div>}
      {!loading && items.length === 0 && <div className="empty">No pending changes.</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {items.map((item) => (
          <div key={item.pendingChangeId} className="card" style={{ padding: '14px 18px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: statusColor[item.status] ?? 'var(--text-muted)', textTransform: 'uppercase' }}>
                    {item.status}
                  </span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>{item.relativePath}</span>
                  {item.reason && <span style={{ color: 'var(--text-muted)', fontSize: 12, fontStyle: 'italic' }}>"{item.reason}"</span>}
                </div>
                <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
                  <span>ID: <code style={{ color: 'var(--code)' }}>{item.pendingChangeId}</code></span>
                  <span>{new Date(item.createdAt).toLocaleString()}</span>
                  {item.status === 'pending' && (
                    <span style={{ color: 'var(--warning)' }}>
                      Expires {new Date(item.expiresAt).toLocaleTimeString()}
                    </span>
                  )}
                  {item.warnings.length > 0 && (
                    <span style={{ color: 'var(--warning)' }}>⚠ {item.warnings.length} warning(s)</span>
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                <button
                  className="btn-ghost"
                  style={{ fontSize: 12 }}
                  onClick={() => setExpanded(expanded === item.pendingChangeId ? null : item.pendingChangeId)}
                >
                  {expanded === item.pendingChangeId ? 'Hide Diff' : 'Show Diff'}
                </button>
                {item.status === 'pending' && (
                  <>
                    <button className="btn-primary" style={{ fontSize: 12 }}
                      disabled={busy === item.pendingChangeId}
                      onClick={() => handleApply(item)}>
                      {busy === item.pendingChangeId ? '…' : 'Apply'}
                    </button>
                    <button className="btn-danger" style={{ fontSize: 12 }}
                      disabled={busy === item.pendingChangeId}
                      onClick={() => handleReject(item)}>
                      Reject
                    </button>
                  </>
                )}
              </div>
            </div>

            {expanded === item.pendingChangeId && (
              <div style={{ marginTop: 12 }}>
                <DiffView diff={item.diff} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
