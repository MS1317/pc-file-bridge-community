import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Workspace } from '@bridge/shared';
import { loadOrCreateSecret } from '../authToken';
import { FileService } from '../fileService';
import { canonicalPath, resolveWorkspacePath } from '../workspaceAccess';

describe('workspace access rules', () => {
  let root: string;
  let workspace: Workspace;

  beforeEach(() => {
    root = canonicalPath(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-access-rules-')));
    workspace = {
      id: 'ws', name: 'ws', root, allowedGlobs: ['**/*'], blockedGlobs: ['private/**'],
      writeMode: 'approval_required', createdAt: new Date().toISOString(),
    };
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function write(relativePath: string, content = 'secret'): void {
    fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(root, relativePath), content);
  }

  it.each(['secrets/a.json', 'SECRETS/a.json', '.ENV', 'Private/a.txt', 'app.PEM'])('blocks %s whatever its casing', (name) => {
    expect(() => resolveWorkspacePath(workspace, name)).toThrow('Access denied');
  });

  it('treats a directory named in .bridgeignore as excluding its contents', () => {
    write('generated/a.txt');
    write('kept/a.txt');
    write('.bridgeignore', 'generated\r\n');
    const service = new FileService();
    expect(() => service.readFile(workspace, 'generated/a.txt')).toThrow('Blocked by .bridgeignore');
    expect(service.readFile(workspace, 'kept/a.txt').content).toBe('secret');
  });

  it('checks the file a link really points at', () => {
    write('secrets/a.txt');
    try {
      fs.symlinkSync(path.join(root, 'secrets'), path.join(root, 'public'), 'junction');
    } catch {
      return; // links are not permitted on this machine
    }
    expect(() => resolveWorkspacePath(workspace, 'public/a.txt')).toThrow('Access denied');
  });

  it('allows new files in directories that do not exist yet', () => {
    expect(resolveWorkspacePath(workspace, 'new/dir/a.txt')).toBe(path.join(root, 'new', 'dir', 'a.txt'));
  });

  it('creates the data directory and keeps an existing secret', () => {
    const dataDir = path.join(root, 'missing', 'data');
    const secret = loadOrCreateSecret(dataDir, 'token.txt');
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(loadOrCreateSecret(dataDir, 'token.txt')).toBe(secret);
  });
});
