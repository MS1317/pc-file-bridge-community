import { useState, useEffect } from 'react';
import type { Workspace, FileEntry, SearchMatch, FileContent } from '@bridge/shared';
import { api } from '../api';

export default function FilesPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWs, setSelectedWs] = useState('');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchMatch[] | null>(null);
  const [selectedFile, setSelectedFile] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.listWorkspaces().then((r) => {
      if (r.ok) {
        setWorkspaces(r.data);
        if (r.data.length > 0) setSelectedWs(r.data[0].id);
      }
    });
  }, []);

  useEffect(() => {
    if (!selectedWs) return;
    setFiles([]);
    setSearchResults(null);
    setSelectedFile(null);
    setLoading(true);
    api.listFiles(selectedWs).then((r) => {
      setLoading(false);
      if (r.ok) setFiles(r.data);
      else setError(r.error);
    });
  }, [selectedWs]);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!searchQuery.trim() || !selectedWs) return;
    setLoading(true);
    const r = await api.searchFiles(selectedWs, searchQuery);
    setLoading(false);
    if (r.ok) setSearchResults(r.data);
    else setError(r.error);
  }

  async function handleReadFile(relativePath: string) {
    if (!selectedWs) return;
    setSelectedFile(null);
    const r = await api.readFile(selectedWs, relativePath);
    if (r.ok) setSelectedFile(r.data);
    else setError(r.error);
  }

  const displayList = searchResults ?? files;

  return (
    <div>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>Files</h1>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 20 }}>
        Browse and read files within a workspace.
      </p>

      {workspaces.length === 0 ? (
        <div className="empty">No workspaces registered. Add one on the Workspaces page first.</div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 12, marginBottom: 20, alignItems: 'flex-end' }}>
            <div style={{ width: 220 }}>
              <label>Workspace</label>
              <select value={selectedWs} onChange={(e) => setSelectedWs(e.target.value)}>
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </select>
            </div>
            <form onSubmit={handleSearch} style={{ display: 'flex', gap: 8, flex: 1 }}>
              <div style={{ flex: 1 }}>
                <label>Search text</label>
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search file contents…"
                />
              </div>
              <button className="btn-primary" type="submit" style={{ alignSelf: 'flex-end' }}>
                Search
              </button>
              {searchResults && (
                <button
                  className="btn-ghost"
                  type="button"
                  style={{ alignSelf: 'flex-end' }}
                  onClick={() => { setSearchResults(null); setSearchQuery(''); }}
                >
                  Clear
                </button>
              )}
            </form>
          </div>

          {error && <div className="error-msg" style={{ marginBottom: 12 }}>{error}</div>}
          {loading && <div style={{ color: 'var(--text-muted)' }}>Loading…</div>}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)' }}>
                {searchResults
                  ? `${searchResults.length} matches`
                  : `${files.length} files`}
              </div>
              <div style={{ maxHeight: 500, overflowY: 'auto' }}>
                {searchResults
                  ? searchResults.map((m, i) => (
                      <button
                        key={i}
                        onClick={() => handleReadFile(m.relativePath)}
                        style={{
                          display: 'block', width: '100%', textAlign: 'left',
                          padding: '10px 16px', background: 'transparent',
                          borderBottom: '1px solid var(--border)', borderRadius: 0,
                          color: 'var(--text)',
                        }}
                      >
                        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--accent)' }}>
                          {m.relativePath}:{m.line}
                        </div>
                        <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 2, fontFamily: 'var(--mono)' }}>
                          {m.preview}
                        </div>
                      </button>
                    ))
                  : files.map((f) => (
                      <button
                        key={f.relativePath}
                        onClick={() => handleReadFile(f.relativePath)}
                        style={{
                          display: 'block', width: '100%', textAlign: 'left',
                          padding: '9px 16px', background: 'transparent',
                          borderBottom: '1px solid var(--border)', borderRadius: 0,
                          color: 'var(--text)',
                        }}
                      >
                        <div style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{f.relativePath}</div>
                        <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 1 }}>
                          {(f.sizeBytes / 1024).toFixed(1)} KB · {new Date(f.modifiedAt).toLocaleString()}
                        </div>
                      </button>
                    ))}
              </div>
            </div>

            <div className="card">
              {selectedFile ? (
                <>
                  <div style={{ marginBottom: 10, fontSize: 12 }}>
                    <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>
                      {selectedFile.relativePath}
                    </span>
                    <span style={{ color: 'var(--text-muted)', marginLeft: 12 }}>
                      SHA256: {selectedFile.hash.slice(0, 12)}…
                    </span>
                  </div>
                  <pre style={{
                    maxHeight: 440, overflowY: 'auto', background: '#0b0e1a',
                    padding: 14, borderRadius: 6, fontSize: 12, lineHeight: 1.5,
                    fontFamily: 'var(--mono)', color: 'var(--text)',
                    border: '1px solid var(--border)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  }}>
                    {selectedFile.content}
                  </pre>
                </>
              ) : (
                <div className="empty">Click a file to read its contents.</div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
