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

  const req = (method: string, url: string, payload?: unknown, trusted = false) => ({
    method: method as 'GET' | 'PUT' | 'POST',
    url,
    headers: { authorization: 'Bearer ' + TOKEN, ...(trusted ? { origin } : {}) },
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

  it('rejects malformed access policies', async () => {
    const response = await app.inject(req('PUT', '/access/policy', { fileWrites: 'yes' }, true));
    expect(response.statusCode).toBe(400);
  });
});
