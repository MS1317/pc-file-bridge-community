import { useCallback, useEffect, useState } from 'react';
import { api, type ApprovalRequest, type AccessPolicy } from '../api';

export default function AccessPage() {
  const [policy, setPolicy] = useState<AccessPolicy | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [adminToken, setAdminToken] = useState(localStorage.getItem('bridge_local_admin_token') ?? '');
  const refresh = useCallback(async () => {
    const [p, a] = await Promise.all([api.getAccessPolicy(), api.listApprovals()]);
    if (p.ok) setPolicy(p.data);
    if (a.ok) setApprovals(a.data);
    else setMessage(a.error);
  }, []);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 4000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function update(next: AccessPolicy) {
    setBusy(true);
    const res = await api.setAccessPolicy(next);
    setBusy(false);
    if (res.ok) { setPolicy(res.data); setMessage('Policy saved.'); }
    else setMessage(res.error);
    refresh();
  }
  async function decision(id: string, approve: boolean) {
    if (approve && !confirm('Execute this operation on your computer? Check the command or target carefully.')) return;
    setBusy(true);
    const result = approve ? await api.approveAccess(id) : await api.rejectAccess(id);
    setBusy(false);
    setMessage(result.ok ? (result.data.state === 'approved' ? 'Operation executed.' : 'Request ' + result.data.state) : result.error);
    refresh();
  }

  return <div style={{ maxWidth: 860 }}>
    <h1 style={{ fontSize: 22, marginBottom: 8 }}>Access Control</h1>
    <p style={{ color: 'var(--text-muted)', marginBottom: 20 }}>Controls apply to every MCP client, including Claude and ChatGPT. The bridge API enforces them.</p>
    <div className="card" style={{ marginBottom: 16 }}>
      <h3>Local administrator credential</h3>
      <p style={{ fontSize: 12, margin: '8px 0', color: 'var(--text-muted)' }}>Read <code>data/local-admin-token.txt</code> on the computer running the bridge. This separate token is required to change permissions or approve operations.</p>
      <input aria-label="Local admin token" type="password" placeholder="Paste local admin token" value={adminToken} onChange={e => setAdminToken(e.target.value)} style={{ width: '100%', padding: 10, marginBottom: 10 }} />
      <button className="btn-primary" onClick={() => { localStorage.setItem('bridge_local_admin_token', adminToken.trim()); setMessage('Local administrator credential saved in this browser.'); refresh(); }}>Save local credential</button>
    </div>
    {message && <div className="card" style={{ marginBottom: 16 }}>{message}</div>}
    {policy && <div className="card" style={{ marginBottom: 20 }}>
      <h3 style={{ marginBottom: 12 }}>Capabilities</h3>
      {([
        ['fileWrites', 'Allow file and spreadsheet modifications'],
        ['terminal', 'Allow terminal commands'],
        ['requireApproval', 'Require local approval for each sensitive operation']
      ] as const).map(([key, title]) => <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', cursor: 'pointer' }}>
        <input type="checkbox" checked={policy[key]} disabled={busy} onChange={(e) => {
          if ((key === 'terminal' || key === 'requireApproval') && (key === 'terminal' ? e.target.checked : !e.target.checked) &&
              !confirm(key === 'terminal' ? 'Terminal commands run with your Windows user privileges. Enable?' : 'Disable per-operation approvals? Authenticated clients may then execute without another prompt.')) return;
          update({ ...policy, [key]: e.target.checked });
        }} />
        <span>{title}</span>
      </label>)}
      <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>Changes take effect immediately. Policies are saved locally. Approvals expire after 10 minutes and do not survive server restarts.</p>
    </div>}
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
      <h3>Local approval queue</h3>
      <button className="btn-ghost" onClick={refresh}>Refresh</button>
    </div>
    {approvals.filter(a => a.state === 'pending').length === 0 && <div className="card">No operations awaiting approval.</div>}
    {approvals.filter(a => a.state === 'pending').map(a => <div className="card" key={a.approvalId} style={{ marginBottom: 12 }}>
      <b>{a.kind === 'terminal' ? 'Terminal' : 'File modification'}: {a.action}</b>
      <p style={{ margin: '8px 0', fontSize: 12 }}>Workspace: {a.workspaceId || 'Not specified'}</p>
      {Object.entries(a.details).filter(([k,v]) => v && k !== 'payload').map(([k,v]) => <div key={k} style={{ marginBottom: 5, overflowWrap: 'anywhere' }}><code>{k}: {v}</code></div>)}
      <div style={{ fontSize: 12, marginTop: 10, marginBottom: 6 }}>Exact submitted payload (review before approving)</div>
      <pre style={{ fontSize: 11, maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', background: '#0b0e1a', padding: 12, borderRadius: 6 }}>{a.details.payload}</pre>
      <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>Expires {new Date(a.expiresAt).toLocaleString()}</p>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn-primary" disabled={busy} onClick={() => decision(a.approvalId, true)}>Approve & execute</button>
        <button className="btn-danger" disabled={busy} onClick={() => decision(a.approvalId, false)}>Reject</button>
      </div>
    </div>)}
  </div>;
}
