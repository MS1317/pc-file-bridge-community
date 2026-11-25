import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from './server';

const TOKEN = 'a'.repeat(64);
const origin = 'http://127.0.0.1:4778';

describe('API capability controls and local approvals', () => {
  let root: string;
  let app: Awaited<ReturnType<typeof buildServer>>;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-access-'));
    app = await buildServer({ dataDir: root, tokenRef: { value: TOKEN } });
  });
  afterEach(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const req = (method: string, url: string, payload?: Record<string, unknown>, trusted = false) => ({
    method: method as 'GET' | 'PUT' | 'POST',
    url,
    headers: { authorization: 'Bearer ' + TOKEN, ...(trusted ? { origin, 'x-local-admin-token': fs.readFileSync(path.join(root, 'local-admin-token.txt'), 'utf8').trim() } : {}) },
    ...(payload === undefined ? {} : { payload }),
  });

  it('defaults to denied and rejects remote capability changes', async () => {
    const settings = await app.inject(req('GET', '/access/policy'));
    expect(settings.json().data).toEqual({ fileWrites: false, terminal: false, requireApproval: false });
    const outside = await app.inject(req('PUT', '/access/policy', { fileWrites: true, terminal: true, requireApproval: false }));
    expect(outside.statusCode).toBe(403);
    const blocked = await app.inject(req('POST', '/terminal/run', { workspaceId: 'x', command: 'whoami' }));
    expect(blocked.statusCode).toBe(403);
  });

  it('queues remote terminal requests, enforces local decision, and does not execute rejected commands', async () => {
    const policy = await app.inject(req('PUT', '/access/policy', { fileWrites: false, terminal: true, requireApproval: true }, true));
    expect(policy.statusCode).toBe(200);
    const queued = await app.inject(req('POST', '/terminal/run', { workspaceId: 'missing', command: 'whoami' }));
    expect(queued.statusCode).toBe(202);
    const id = queued.json().data.approvalId as string;
    expect(id).toBeTruthy();
    const remoteReject = await app.inject(req('POST', '/access/approvals/' + id + '/reject'));
    expect(remoteReject.statusCode).toBe(403);
    const rejected = await app.inject(req('POST', '/access/approvals/' + id + '/reject', {}, true));
    expect(rejected.json().data.state).toBe('rejected');
    const repeat = await app.inject(req('POST', '/access/approvals/' + id + '/approve', {}, true));
    expect(repeat.statusCode).toBe(409);
  });

  it('executes a queued file modification only after local approval and blocks replay', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-access-workspace-'));
    const created = await app.inject(req('POST', '/workspaces', { name: 'Fixture', root: workspaceRoot, allowedGlobs: ['**/*'], blockedGlobs: [] }));
    expect(created.statusCode).toBe(201);
    const workspaceId = created.json().data.id as string;
    const policy = await app.inject(req('PUT', '/access/policy', { fileWrites: true, terminal: false, requireApproval: true }, true));
    expect(policy.statusCode).toBe(200);
    const proposed = await app.inject(req('POST', '/changes/write', { workspaceId, relativePath: 'new.ts', newContent: 'export const valid = true;' }));
    expect(proposed.statusCode).toBe(202);
    expect(fs.existsSync(path.join(workspaceRoot, 'new.ts'))).toBe(false);
    const id = proposed.json().data.approvalId as string;
    const approved = await app.inject(req('POST', '/access/approvals/' + id + '/approve', {}, true));
    expect(approved.statusCode).toBe(200);
    expect(approved.json().data.state).toBe('approved');
    expect(fs.readFileSync(path.join(workspaceRoot, 'new.ts'), 'utf8')).toBe('export const valid = true;');
    const replay = await app.inject(req('POST', '/access/approvals/' + id + '/approve', {}, true));
    expect(replay.statusCode).toBe(409);
  });

  it('shows the file and diff behind an apply or revert, and limits size only when approval is on', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-access-workspace-'));
    const workspaceId = (await app.inject(req('POST', '/workspaces', { name: 'Fixture', root: workspaceRoot }))).json().data.id as string;
    const setApproval = (requireApproval: boolean) =>
      app.inject(req('PUT', '/access/policy', { fileWrites: true, terminal: false, requireApproval }, true));
    const large = { workspaceId, relativePath: 'large.md', newContent: 'x'.repeat(300_000) };

    await setApproval(false);
    const written = await app.inject(req('POST', '/changes/write', large));
    expect(written.statusCode).toBe(200);
    const preview = await app.inject(req('POST', '/changes/preview', { workspaceId, relativePath: 'small.md', newContent: 'hello\n' }));

    await setApproval(true);
    expect((await app.inject(req('POST', '/changes/write', large))).statusCode).toBe(413);
    const apply = await app.inject(req('POST', '/changes/apply', { workspaceId, pendingChangeId: preview.json().data.pendingChangeId }));
    expect(apply.json().data.details).toMatchObject({ relativePath: 'small.md', diff: expect.stringContaining('+hello') });
    const revert = await app.inject(req('POST', '/changes/revert', { workspaceId, auditId: written.json().data.auditId }));
    expect(revert.json().data.details).toMatchObject({ relativePath: 'large.md', undoes: expect.stringContaining('apply') });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it.each(['/changes/%77rite', '/changes/write;x', '/terminal/%72un', '/changes/write?x=1'])(
    'applies the capability gate to the alternate URL spelling %s',
    async (url) => {
      const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-access-workspace-'));
      const created = await app.inject(req('POST', '/workspaces', { name: 'Fixture', root: workspaceRoot }));
      const response = await app.inject(req('POST', url, {
        workspaceId: created.json().data.id, relativePath: 'new.ts', newContent: 'x', command: 'echo hi',
      }));
      // Either gated (403) or not routed at all (404), but never executed.
      expect([403, 404]).toContain(response.statusCode);
      expect(fs.existsSync(path.join(workspaceRoot, 'new.ts'))).toBe(false);
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    },
  );

  it('gates spreadsheet mutations but not spreadsheet reads', async () => {
    const write = await app.inject(req('POST', '/spreadsheets/%63reate_spreadsheet', { workspaceId: 'x', relativePath: 'a.xlsx' }));
    expect(write.statusCode).toBe(403);
    expect(write.json().error).toContain('fileWrites is disabled');
    const read = await app.inject(req('POST', '/spreadsheets/inspect_spreadsheet', { workspaceId: 'x', relativePath: 'a.xlsx' }));
    expect(read.json().error).not.toContain('fileWrites is disabled');
  });

  it('keeps bridge credentials out of reach of file tools', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-parent-'));
    const dataDir = path.join(parent, 'bridge (x86) [1]', 'data');
    const nested = await buildServer({ dataDir, tokenRef: { value: TOKEN } });
    try {
      fs.writeFileSync(path.join(parent, 'ok.txt'), 'fine');
      const inside = await nested.inject(req('POST', '/workspaces', { name: 'data', root: dataDir }));
      expect(inside.statusCode).toBe(400);
      const created = await nested.inject(req('POST', '/workspaces', { name: 'parent', root: parent, allowedGlobs: ['**/*'], blockedGlobs: [] }));
      const workspaceId = created.json().data.id as string;
      // Rewriting the workspace policy must not lift the protection.
      await nested.inject(req('PUT', '/workspaces/' + workspaceId + '/policy', { allowedGlobs: ['**/*'], blockedGlobs: [] }));

      const secret = fs.readFileSync(path.join(dataDir, 'local-admin-token.txt'), 'utf8').trim();
      for (const name of ['data/local-admin-token.txt', 'DATA/LOCAL-ADMIN-TOKEN.TXT', 'data/workspaces.json']) {
        const read = await nested.inject(req('POST', '/files/read', { workspaceId, relativePath: 'bridge (x86) [1]/' + name }));
        expect(read.statusCode).toBe(400);
        expect(read.body).toContain('Access denied');
      }
      const search = await nested.inject(req('POST', '/files/search', { workspaceId, query: secret.slice(0, 16) }));
      expect(search.json().data).toEqual([]);
      const list = await nested.inject(req('POST', '/files/list', { workspaceId }));
      expect(list.json().data.map((f: { relativePath: string }) => f.relativePath)).toEqual(['ok.txt']);
      const preview = await nested.inject(req('POST', '/changes/preview', {
        workspaceId, relativePath: 'bridge (x86) [1]/data/access-policy.json', newContent: '{}',
      }));
      expect(preview.statusCode).toBe(400);
    } finally {
      await nested.close();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('rejects malformed access policies', async () => {
    const response = await app.inject(req('PUT', '/access/policy', { fileWrites: 'yes' }, true));
    expect(response.statusCode).toBe(400);
  });
});
