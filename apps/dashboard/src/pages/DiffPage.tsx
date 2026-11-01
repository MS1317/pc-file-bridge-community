import { useState, useEffect } from 'react';
import type { Workspace, ChangePreviewResult } from '@bridge/shared';
import { api } from '../api';

export function DiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n');
  return (
    <div className="diff-view">
      {lines.map((line, i) => {
        const cls = line.startsWith('+') && !line.startsWith('+++')
          ? 'diff-add'
          : line.startsWith('-') && !line.startsWith('---')
          ? 'diff-remove'
          : line.startsWith('@') || line.startsWith('---') || line.startsWith('+++')
          ? 'diff-meta'
          : '';
        return <div key={i} className={cls}>{line || ' '}</div>;
      })}
    </div>
  );
}

export default function DiffPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [relativePath, setRelativePath] = useState('');
  const [newContent, setNewContent] = useState('');
  const [baseHash, setBaseHash] = useState('');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<ChangePreviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [error, setError] = useState('');
  const [applySuccess, setApplySuccess] = useState('');

  useEffect(() => {
    api.listWorkspaces().then((r) => {
      if (r.ok) { setWorkspaces(r.data); if (r.data.length > 0) setWorkspaceId(r.data[0].id); }
    });
  }, []);

  async function handlePreview(e: React.FormEvent) {
    e.preventDefault();
    if (!workspaceId || !relativePath || newContent === '') {
      setError('Workspace, path, and new content are all required');
      return;
    }
    setLoading(true); setError(''); setPreview(null); setApplySuccess('');
    const r = await api.previewChange({ workspaceId, relativePath, newContent, baseHash: baseHash || undefined, reason: reason || undefined });
    setLoading(false);
    if (r.ok) setPreview(r.data);
    else setError(r.error);
  }

  async function handleApply() {
    if (!preview) return;
    if (!confirm('Apply this change? A backup will be created automatically.')) return;
    setApplying(true); setError('');
    const r = await api.applyChange(workspaceId, preview.pendingChangeId);
    setApplying(false);
    if (r.ok) {
      setApplySuccess(`✓ Applied! Audit ID: ${r.data.auditId} · Backup: ${r.data.backupId}`);
      setPreview(null);
    } else setError(r.error);
  }

  async function handleReject() {
    if (!preview) return;
    setRejecting(true); setError('');
    const r = await api.rejectChange(preview.pendingChangeId);
    setRejecting(false);
    if (r.ok) { setPreview(null); setApplySuccess('Change rejected.'); }
    else setError(r.error);
  }

  return (
    <div>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>Diff Preview</h1>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 20 }}>
        Preview creates a pending change. Explicit Apply or Reject is required — no auto-write.
      </p>

      {workspaces.length === 0 ? (
        <div className="empty">No workspaces registered.</div>
      ) : (
        <form onSubmit={handlePreview}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <label>Workspace</label>
              <select value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
                {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </div>
            <div>
              <label>Relative File Path</label>
              <input value={relativePath} onChange={(e) => setRelativePath(e.target.value)}
                placeholder="src/components/Button.tsx" style={{ fontFamily: 'var(--mono)' }} />
            </div>
            <div>
              <label>Base Hash (optional)</label>
              <input value={baseHash} onChange={(e) => setBaseHash(e.target.value)}
                placeholder="sha256 of current file" style={{ fontFamily: 'var(--mono)' }} />
            </div>
            <div>
              <label>Reason</label>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Fix button hover state" />
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            <label>New File Content</label>
            <textarea value={newContent} onChange={(e) => setNewContent(e.target.value)}
              rows={12} style={{ fontFamily: 'var(--mono)', fontSize: 12, resize: 'vertical' }}
              placeholder="Paste the complete new file content here…" />
          </div>
          {error && <div className="error-msg" style={{ marginBottom: 10 }}>{error}</div>}
          {applySuccess && <div className="success-msg" style={{ marginBottom: 10 }}>{applySuccess}</div>}
          <button className="btn-primary" type="submit" disabled={loading}>
            {loading ? 'Previewing…' : 'Preview Diff'}
          </button>
        </form>
      )}

      {preview && (
        <div style={{ marginTop: 24 }}>
          <div style={{ display: 'flex', gap: 12, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <h3 style={{ fontSize: 15 }}>Pending Change</h3>
            <span style={{ fontSize: 12, padding: '3px 10px', borderRadius: 4, background: 'rgba(76,175,130,0.18)', color: 'var(--success)' }}>
              ✓ Safe to apply
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              ID: <code style={{ color: 'var(--code)' }}>{preview.pendingChangeId}</code>
              {' · '}Expires: {new Date(preview.expiresAt).toLocaleTimeString()}
            </span>
          </div>

          <div style={{ display: 'flex', gap: 20, fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
            <span>Old: <code style={{ color: 'var(--code)' }}>{preview.oldHash?.slice(0, 12) ?? 'none'}…</code></span>
            <span>New: <code style={{ color: 'var(--code)' }}>{preview.newHash.slice(0, 12)}…</code></span>
            <span>{preview.fileExists ? 'Modifying existing file' : 'Creating new file'}</span>
          </div>

          {preview.warnings.length > 0 && (
            <div style={{ background: 'rgba(224,160,58,0.12)', border: '1px solid rgba(224,160,58,0.3)', borderRadius: 6, padding: '10px 14px', marginBottom: 12 }}>
              {preview.warnings.map((w, i) => <div key={i} style={{ color: 'var(--warning)', fontSize: 13 }}>⚠ {w}</div>)}
            </div>
          )}

          <DiffView diff={preview.diff} />

          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button className="btn-primary" onClick={handleApply} disabled={applying || rejecting}>
              {applying ? 'Applying…' : 'Apply Change'}
            </button>
            <button className="btn-danger" onClick={handleReject} disabled={applying || rejecting}>
              {rejecting ? 'Rejecting…' : 'Reject'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
