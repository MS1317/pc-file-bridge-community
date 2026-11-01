import { useState } from 'react';
import { api } from '../api';

interface Props {
  onSaved: () => void;
}

export default function TokenPage({ onSaved }: Props) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);

  async function handleSave() {
    if (!token.trim()) { setError('Token cannot be empty'); return; }
    setChecking(true);
    setError('');
    localStorage.setItem('bridge_token', token.trim());
    const res = await api.health();
    setChecking(false);
    if (res.ok) {
      onSaved();
    } else {
      setError('Could not reach the API with this token. Make sure the bridge API is running on port 4777.');
      localStorage.removeItem('bridge_token');
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
      <div className="card" style={{ width: 420 }}>
        <h2 style={{ marginBottom: 6 }}>Connect to Bridge API</h2>
        <p style={{ color: 'var(--text-muted)', marginBottom: 20, fontSize: 13 }}>
          Enter the auth token from <code style={{ color: 'var(--code)' }}>data/auth-token.txt</code>.
          It was printed when you first started the API.
        </p>
        <label>Auth Token</label>
        <input
          type="password"
          placeholder="Paste your token here"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSave()}
          autoFocus
        />
        {error && <div className="error-msg">{error}</div>}
        <button
          className="btn-primary"
          style={{ marginTop: 16, width: '100%' }}
          onClick={handleSave}
          disabled={checking}
        >
          {checking ? 'Checking…' : 'Connect'}
        </button>
        <p style={{ marginTop: 16, fontSize: 12, color: 'var(--text-muted)' }}>
          Token is stored only in your browser's localStorage and never sent anywhere except localhost.
        </p>
      </div>
    </div>
  );
}
