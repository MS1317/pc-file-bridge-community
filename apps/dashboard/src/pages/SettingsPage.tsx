import { useState } from 'react';
import { api } from '../api';

export default function SettingsPage() {
  const [rotating, setRotating] = useState(false);
  const [newToken, setNewToken] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  async function handleRotate() {
    if (!confirm('Rotate the auth token? The current token will be immediately invalidated. You will need to paste the new token.')) return;
    setRotating(true); setError(''); setNewToken('');
    const r = await api.rotateToken();
    setRotating(false);
    if (r.ok) {
      setNewToken(r.data.newToken);
      localStorage.setItem('bridge_token', r.data.newToken);
    } else {
      setError(r.error);
    }
  }

  async function handleCopy() {
    await navigator.clipboard.writeText(newToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>Settings</h1>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 24 }}>
        Token management and local bridge configuration.
      </p>

      <div className="card" style={{ maxWidth: 540 }}>
        <h3 style={{ fontSize: 15, marginBottom: 8 }}>Auth Token Rotation</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 16, lineHeight: 1.7 }}>
          Generate a new 256-bit random token. The old token is invalidated immediately.
          The new token is saved to <code style={{ color: 'var(--code)' }}>data/auth-token.txt</code> and
          automatically applied to this dashboard session.
        </p>

        {error && <div className="error-msg" style={{ marginBottom: 12 }}>{error}</div>}

        {newToken ? (
          <div>
            <div style={{ marginBottom: 8, color: 'var(--success)', fontSize: 13 }}>
              ✓ Token rotated and applied to this session.
            </div>
            <div style={{ background: '#0b0e1a', borderRadius: 6, padding: '10px 14px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
              <code style={{ fontSize: 11, color: 'var(--code)', flex: 1, wordBreak: 'break-all' }}>
                {newToken}
              </code>
              <button className="btn-ghost" style={{ fontSize: 11, flexShrink: 0 }} onClick={handleCopy}>
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>
              Save this token in a password manager if you plan to use it from another tool.
            </p>
          </div>
        ) : (
          <button className="btn-primary" onClick={handleRotate} disabled={rotating}>
            {rotating ? 'Rotating…' : 'Rotate Token'}
          </button>
        )}
      </div>
    </div>
  );
}
