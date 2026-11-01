import { Routes, Route, NavLink, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { api } from './api';
import WorkspacesPage from './pages/WorkspacesPage';
import FilesPage from './pages/FilesPage';
import DiffPage from './pages/DiffPage';
import PendingPage from './pages/PendingPage';
import AuditPage from './pages/AuditPage';
import SettingsPage from './pages/SettingsPage';
import TokenPage from './pages/TokenPage';

type ApiStatus = 'checking' | 'online' | 'offline' | 'unauthorized';

function StatusDot({ status }: { status: ApiStatus }) {
  const dotClass = status === 'online' ? 'green' : status === 'checking' ? 'yellow' : 'red';
  const label = status === 'online' ? 'API online' : status === 'offline' ? 'API offline' : status === 'unauthorized' ? 'Token invalid' : 'checking…';
  const color = status === 'unauthorized' ? 'var(--danger)' : 'var(--text-muted)';
  return (
    <>
      <span className={`status-dot ${dotClass}`} />
      <span style={{ color }}>{label}</span>
    </>
  );
}

export default function App() {
  const [apiStatus, setApiStatus] = useState<'checking' | 'online' | 'offline' | 'unauthorized'>('checking');
  const navigate = useNavigate();

  useEffect(() => {
    async function check() {
      try {
        const r = await api.health();
        if (r.ok) { setApiStatus('online'); return; }
        // health doesn't require auth, but if the API is unreachable we'll catch below
        setApiStatus('offline');
      } catch { setApiStatus('offline'); }

      // Also check an auth-required endpoint to detect bad token
      const ws = await api.listWorkspaces().catch(() => null);
      if (ws && !ws.ok && ws.error?.toLowerCase().includes('unauthorized')) {
        setApiStatus('unauthorized');
      }
    }
    check();
    const id = setInterval(check, 30_000);
    return () => clearInterval(id);
  }, []);

  const hasToken = !!localStorage.getItem('bridge_token');
  if (!hasToken) {
    return <TokenPage onSaved={() => navigate('/')} />;
  }

  if (apiStatus === 'unauthorized') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <div className="card" style={{ width: 440 }}>
          <h2 style={{ marginBottom: 8, color: 'var(--danger)' }}>Token Invalid or Expired</h2>
          <p style={{ color: 'var(--text-muted)', marginBottom: 20, fontSize: 13 }}>
            The saved token was rejected by the API. This happens after token rotation or if the API was restarted with a new token.
          </p>
          <button className="btn-primary" style={{ width: '100%' }}
            onClick={() => { localStorage.removeItem('bridge_token'); window.location.reload(); }}>
            Re-enter Token
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <nav style={{
        width: 220,
        background: 'var(--surface)',
        borderRight: '1px solid var(--border)',
        padding: '24px 0',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
      }}>
        <div style={{ padding: '0 20px 24px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>
            PC File Bridge
          </div>
          <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', fontSize: 12 }}>
            <StatusDot status={apiStatus} />
          </div>
        </div>

        <div style={{ padding: '16px 0', flex: 1 }}>
          {[
            { to: '/', label: 'Workspaces' },
            { to: '/files', label: 'Files' },
            { to: '/diff', label: 'Diff Preview' },
            { to: '/pending', label: 'Pending Changes' },
            { to: '/audit', label: 'Audit Log' },
            { to: '/settings', label: 'Settings' },
          ].map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              style={({ isActive }) => ({
                display: 'block',
                padding: '9px 20px',
                color: isActive ? 'var(--text)' : 'var(--text-muted)',
                background: isActive ? 'var(--surface2)' : 'transparent',
                borderLeft: `3px solid ${isActive ? 'var(--accent)' : 'transparent'}`,
                fontWeight: isActive ? 600 : 400,
                transition: 'all 0.12s',
              })}
            >
              {label}
            </NavLink>
          ))}
        </div>

        <div style={{ padding: '16px 20px', borderTop: '1px solid var(--border)' }}>
          <button
            className="btn-ghost"
            style={{ width: '100%', fontSize: 12 }}
            onClick={() => { localStorage.removeItem('bridge_token'); window.location.reload(); }}
          >
            Change Token
          </button>
        </div>
      </nav>

      <main style={{ flex: 1, padding: '32px', overflowY: 'auto' }}>
        <Routes>
          <Route path="/" element={<WorkspacesPage />} />
          <Route path="/files" element={<FilesPage />} />
          <Route path="/diff" element={<DiffPage />} />
          <Route path="/pending" element={<PendingPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </div>
  );
}
