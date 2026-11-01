import { useState, useEffect, useCallback } from 'react';
import type { Workspace } from '@bridge/shared';
import { api } from '../api';

export default function WorkspacesPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [editingPolicyId, setEditingPolicyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await api.listWorkspaces();
    setLoading(false);
    if (res.ok) setWorkspaces(res.data);
    else setError(res.error);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Remove workspace "${name}"? This does not delete files.`)) return;
    const res = await api.deleteWorkspace(id);
    if (res.ok) load();
    else alert(res.error);
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700 }}>Workspaces</h1>
          <p style={{ color: 'var(--text-muted)', marginTop: 4, fontSize: 13 }}>
            Registered project folders the bridge can access.
          </p>
        </div>
        <button className="btn-primary" onClick={() => setShowAdd((v) => !v)}>
          {showAdd ? 'Cancel' : '+ Add Workspace'}
        </button>
      </div>

      {showAdd && <AddWorkspaceForm onAdded={() => { setShowAdd(false); load(); }} />}

      {error && <div className="error-msg" style={{ marginBottom: 16 }}>{error}</div>}
      {loading && <div style={{ color: 'var(--text-muted)' }}>Loading…</div>}

      {!loading && workspaces.length === 0 && (
        <div className="empty">No workspaces registered yet. Add one above.</div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {workspaces.map((ws) => {
          const editing = editingPolicyId === ws.id;
          return (
            <div key={ws.id} className="card" style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                  <span style={{ fontWeight: 600, fontSize: 15 }}>{ws.name}</span>
                  <span className={`tag ${ws.writeMode === 'approval_required' ? 'tag-approval' : 'tag-auto'}`}>
                    {ws.writeMode === 'approval_required' ? 'Approval Required' : 'Auto Apply'}
                  </span>
                  <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>ID: {ws.id}</span>
                </div>
                <div style={{ color: 'var(--text-muted)', fontSize: 12, fontFamily: 'var(--mono)', marginBottom: 8 }}>
                  {ws.root}
                </div>
                <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--text-muted)' }}>
                  <span>{ws.allowedGlobs.length} allowed patterns</span>
                  <span>{ws.blockedGlobs.length} blocked patterns</span>
                  <span>Added {new Date(ws.createdAt).toLocaleDateString()}</span>
                </div>
                {editing && (
                  <WorkspacePolicyEditor
                    workspace={ws}
                    onCancel={() => setEditingPolicyId(null)}
                    onSaved={() => { setEditingPolicyId(null); load(); }}
                  />
                )}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn-secondary" onClick={() => setEditingPolicyId(editing ? null : ws.id)}>
                  {editing ? 'Close Policy' : 'Edit Policy'}
                </button>
                <button className="btn-danger" onClick={() => handleDelete(ws.id, ws.name)}>
                  Remove
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WorkspacePolicyEditor({ workspace, onCancel, onSaved }: {
  workspace: Workspace;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [allowedGlobs, setAllowedGlobs] = useState(() => [...workspace.allowedGlobs]);
  const [blockedGlobs, setBlockedGlobs] = useState(() => [...workspace.blockedGlobs]);
  const [newAllowed, setNewAllowed] = useState('');
  const [newBlocked, setNewBlocked] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  function addPattern(value: string, patterns: string[], setPatterns: (next: string[]) => void, clear: () => void) {
    const pattern = value.trim();
    if (!pattern) return;
    if (!patterns.includes(pattern)) setPatterns([...patterns, pattern]);
    clear();
  }

  function removePattern(pattern: string, setPatterns: (next: string[]) => void, patterns: string[]) {
    setPatterns(patterns.filter((item) => item !== pattern));
  }

  async function savePolicy() {
    setSaving(true);
    setError('');
    const res = await api.updateWorkspacePolicy(workspace.id, { allowedGlobs, blockedGlobs });
    setSaving(false);
    if (res.ok) onSaved();
    else setError(res.error);
  }

  return (
    <section style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
      <h3 style={{ marginBottom: 6, fontSize: 14 }}>File-access policy</h3>
      <p style={{ margin: '0 0 14px', color: 'var(--text-muted)', fontSize: 12 }}>
        Blocked patterns take precedence. Built-in secret, database, traversal, workspace-root, and symlink protections remain enforced even if a pattern is removed here.
      </p>
      {allowedGlobs.length === 0 && (
        <p className="error-msg" style={{ margin: '0 0 14px' }}>
          No allowed globs means the workspace has no explicit whitelist: every non-blocked file can be accessed. Add an allowed pattern before saving if you want a restricted allowlist.
        </p>
      )}
      <GlobPatternList
        label="Allowed globs"
        patterns={allowedGlobs}
        value={newAllowed}
        placeholder="**/*.log"
        onValueChange={setNewAllowed}
        onAdd={() => addPattern(newAllowed, allowedGlobs, setAllowedGlobs, () => setNewAllowed(''))}
        onRemove={(pattern) => removePattern(pattern, setAllowedGlobs, allowedGlobs)}
      />
      <GlobPatternList
        label="Blocked globs"
        patterns={blockedGlobs}
        value={newBlocked}
        placeholder="**/private/**"
        onValueChange={setNewBlocked}
        onAdd={() => addPattern(newBlocked, blockedGlobs, setBlockedGlobs, () => setNewBlocked(''))}
        onRemove={(pattern) => removePattern(pattern, setBlockedGlobs, blockedGlobs)}
      />
      {error && <div className="error-msg" style={{ marginTop: 12 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
        <button className="btn-primary" type="button" onClick={savePolicy} disabled={saving}>
          {saving ? 'Saving…' : 'Save Policy'}
        </button>
        <button className="btn-secondary" type="button" onClick={onCancel} disabled={saving}>Cancel</button>
      </div>
    </section>
  );
}

function GlobPatternList({ label, patterns, value, placeholder, onValueChange, onAdd, onRemove }: {
  label: string;
  patterns: string[];
  value: string;
  placeholder: string;
  onValueChange: (value: string) => void;
  onAdd: () => void;
  onRemove: (pattern: string) => void;
}) {
  return (
    <div style={{ marginTop: 14 }}>
      <label>{label}</label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '7px 0 10px' }}>
        {patterns.map((pattern) => (
          <span key={pattern} className="tag" style={{ fontFamily: 'var(--mono)', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            {pattern}
            <button type="button" aria-label={`Remove ${pattern}`} onClick={() => onRemove(pattern)} style={{ border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', padding: 0 }}>×</button>
          </span>
        ))}
        {patterns.length === 0 && <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>No explicit patterns.</span>}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); onAdd(); } }}
          placeholder={placeholder}
          style={{ fontFamily: 'var(--mono)' }}
        />
        <button className="btn-secondary" type="button" onClick={onAdd}>Add</button>
      </div>
    </div>
  );
}

function AddWorkspaceForm({ onAdded }: { onAdded: () => void }) {
  const [name, setName] = useState('');
  const [root, setRoot] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !root.trim()) { setError('Name and root path are required'); return; }
    setSaving(true);
    setError('');
    const res = await api.addWorkspace({ name: name.trim(), root: root.trim() });
    setSaving(false);
    if (res.ok) onAdded();
    else setError(res.error);
  }

  return (
    <div className="card" style={{ marginBottom: 24, borderColor: 'var(--accent)' }}>
      <h3 style={{ marginBottom: 16, fontSize: 15 }}>Add Workspace</h3>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <label>Workspace Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Project" />
        </div>
        <div>
          <label>Root Path (absolute)</label>
          <input
            value={root}
            onChange={(e) => setRoot(e.target.value)}
            placeholder="C:\Users\developer\Desktop\Dev\MyProject"
            style={{ fontFamily: 'var(--mono)' }}
          />
        </div>
        {error && <div className="error-msg">{error}</div>}
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn-primary" type="submit" disabled={saving}>
            {saving ? 'Adding…' : 'Add Workspace'}
          </button>
        </div>
      </form>
    </div>
  );
}
