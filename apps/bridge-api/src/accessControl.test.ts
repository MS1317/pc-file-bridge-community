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
    expect(settings.json().data).toEqual({ fileWrites: false, terminal: false, requireApproval: true });
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
    const workspaceRoot = path.join(root, 'workspace');
    fs.mkdirSync(workspaceRoot);
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

  it('rejects malformed access policies', async () => {
    const response = await app.inject(req('PUT', '/access/policy', { fileWrites: 'yes' }, true));
    expect(response.statusCode).toBe(400);
  });
});
