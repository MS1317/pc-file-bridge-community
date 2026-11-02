import fs from 'fs';
import os from 'os';
import path from 'path';
import type { FastifyInstance } from 'fastify';
import { TerminalService } from '@bridge/core';
import { buildServer } from './server';

const TOKEN = 'bridge-api-test-token-'.padEnd(64, 'x');

describe('bridge HTTP API', () => {
  let root: string;
  let dataDir: string;
  let workspaceRoot: string;
  let app: FastifyInstance;
  let tokenRef: { value: string };
  let workspaceId: string;

  const auth = () => ({ authorization: `Bearer ${tokenRef.value}` });
  const payload = <T = any>(response: { body: string }): T => JSON.parse(response.body);

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-api-test-'));
    dataDir = path.join(root, 'data');
    workspaceRoot = path.join(root, 'workspace');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, 'src', 'alpha.ts'), 'first needle\nsecond line\nthird line\n', 'utf8');
    fs.writeFileSync(path.join(workspaceRoot, 'src', 'beta.ts'), 'another file\n', 'utf8');
    fs.writeFileSync(path.join(workspaceRoot, '.env'), 'SECRET=value', 'utf8');

    tokenRef = { value: TOKEN };
    app = await buildServer({ dataDir, tokenRef });
    const controls = await app.inject({ method: 'PUT', url: '/access/policy', headers: { ...auth(), origin: 'http://127.0.0.1:4778', 'x-local-admin-token': fs.readFileSync(path.join(dataDir, 'local-admin-token.txt'), 'utf8').trim() }, payload: { fileWrites: true, terminal: true, requireApproval: false } });
    expect(controls.statusCode).toBe(200);
    const created = await app.inject({
      method: 'POST',
      url: '/workspaces',
      headers: auth(),
      payload: { name: 'API Fixture', root: workspaceRoot, allowedGlobs: ['**/*'], blockedGlobs: [] },
    });
    expect(created.statusCode).toBe(201);
    workspaceId = payload<{ data: { id: string } }>(created).data.id;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps health public and requires the current bearer token everywhere else', async () => {
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(payload(health)).toMatchObject({ ok: true, data: { status: 'running' } });

    const missing = await app.inject({ method: 'GET', url: '/workspaces' });
    expect(missing.statusCode).toBe(401);
    expect(payload(missing)).toMatchObject({ code: 'INVALID_TOKEN' });

    const invalid = await app.inject({
      method: 'POST', url: '/files/list', headers: { authorization: 'Bearer wrong' }, payload: { workspaceId },
    });
    expect(invalid.statusCode).toBe(401);
  });

  it('lists, reads, searches, ranges, finds, and describes workspace files', async () => {
    const list = await app.inject({ method: 'POST', url: '/files/list', headers: auth(), payload: { workspaceId } });
    expect(payload<{ data: Array<{ relativePath: string }> }>(list).data.map((file) => path.normalize(file.relativePath))).toContain(path.join('src', 'alpha.ts'));
    expect(payload<{ data: Array<{ relativePath: string }> }>(list).data.some((file) => file.relativePath === '.env')).toBe(false);

    const read = await app.inject({ method: 'POST', url: '/files/read', headers: auth(), payload: { workspaceId, relativePath: 'src/alpha.ts' } });
    expect(payload<{ data: { content: string; hash: string } }>(read).data).toMatchObject({
      content: 'first needle\nsecond line\nthird line\n', hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const range = await app.inject({ method: 'POST', url: '/files/range', headers: auth(), payload: { workspaceId, relativePath: 'src/alpha.ts', startLine: 2, endLine: 2 } });
    expect(payload<{ data: { lines: Array<{ lineNumber: number; content: string }> } }>(range).data.lines)
      .toEqual([{ lineNumber: 2, content: 'second line' }]);

    const search = await app.inject({ method: 'POST', url: '/files/search', headers: auth(), payload: { workspaceId, query: 'needle' } });
    expect(path.normalize(payload<{ data: Array<{ relativePath: string }> }>(search).data[0].relativePath)).toBe(path.join('src', 'alpha.ts'));

    const tree = await app.inject({ method: 'POST', url: '/files/tree', headers: auth(), payload: { workspaceId, maxDepth: 2 } });
    expect(payload<{ data: { tree: Array<{ name: string; type: string }> } }>(tree).data.tree)
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'src', type: 'dir' })]));

    const find = await app.inject({ method: 'POST', url: '/files/find', headers: auth(), payload: { workspaceId, query: 'alpha' } });
    expect(path.normalize(payload<{ data: { matches: Array<{ relativePath: string }> } }>(find).data.matches[0].relativePath)).toBe(path.join('src', 'alpha.ts'));

    const overview = await app.inject({ method: 'POST', url: '/files/overview', headers: auth(), payload: { workspaceId } });
    expect(payload<{ data: { workspaceId: string; rootFiles: string[] } }>(overview).data)
      .toMatchObject({ workspaceId, rootFiles: expect.any(Array) });
  });

  it('rejects missing workspaces and blocked paths without returning file contents', async () => {
    const missing = await app.inject({ method: 'POST', url: '/files/list', headers: auth(), payload: { workspaceId: 'missing' } });
    expect(missing.statusCode).toBe(404);
    const secret = await app.inject({ method: 'POST', url: '/files/read', headers: auth(), payload: { workspaceId, relativePath: '.env' } });
    expect(secret.statusCode).toBe(400);
    expect(secret.body).not.toContain('SECRET=value');
    const traversal = await app.inject({ method: 'POST', url: '/files/read', headers: auth(), payload: { workspaceId, relativePath: '../outside.txt' } });
    expect(traversal.statusCode).toBe(400);
  });

  it('runs the preview, apply, audit, and revert file-change workflow', async () => {
    const filePath = path.join(workspaceRoot, 'src', 'alpha.ts');
    const original = fs.readFileSync(filePath, 'utf8');
    const preview = await app.inject({
      method: 'POST', url: '/changes/preview', headers: auth(),
      payload: { workspaceId, relativePath: 'src/alpha.ts', newContent: 'updated\n', reason: 'API test' },
    });
    expect(preview.statusCode).toBe(200);
    const pendingChangeId = payload<{ data: { pendingChangeId: string } }>(preview).data.pendingChangeId;
    expect(fs.readFileSync(filePath, 'utf8')).toBe(original);

    const pending = await app.inject({ method: 'GET', url: '/changes/pending', headers: auth() });
    expect(payload<{ data: Array<{ pendingChangeId: string }> }>(pending).data[0].pendingChangeId).toBe(pendingChangeId);
    const applied = await app.inject({ method: 'POST', url: '/changes/apply', headers: auth(), payload: { workspaceId, pendingChangeId } });
    const auditId = payload<{ data: { auditId: string; success: boolean } }>(applied).data.auditId;
    expect(payload<{ data: { success: boolean } }>(applied).data.success).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('updated\n');

    const recent = await app.inject({ method: 'GET', url: '/changes/recent?limit=10', headers: auth() });
    expect(payload<{ data: Array<{ id: string; action: string }> }>(recent).data)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: auditId, action: 'apply' })]));
    const reverted = await app.inject({ method: 'POST', url: '/changes/revert', headers: auth(), payload: { workspaceId, auditId } });
    expect(payload<{ data: { success: boolean } }>(reverted).data.success).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(original);
  });

  it('supports targeted previews, reject, and the one-request write path', async () => {
    const routes = [
      { url: '/changes/replace-range', payload: { workspaceId, relativePath: 'src/alpha.ts', startLine: 1, endLine: 1, newContent: 'replacement' } },
      { url: '/changes/insert-before', payload: { workspaceId, relativePath: 'src/alpha.ts', line: 1, content: 'before' } },
      { url: '/changes/insert-after', payload: { workspaceId, relativePath: 'src/alpha.ts', line: 1, content: 'after' } },
    ];
    for (const route of routes) {
      const preview = await app.inject({ method: 'POST', url: route.url, headers: auth(), payload: route.payload });
      expect(preview.statusCode).toBe(200);
      const pendingChangeId = payload<{ data: { pendingChangeId: string } }>(preview).data.pendingChangeId;
      const rejected = await app.inject({ method: 'POST', url: '/changes/reject', headers: auth(), payload: { pendingChangeId } });
      expect(payload<{ data: { rejected: boolean } }>(rejected).data.rejected).toBe(true);
    }
    expect(fs.readFileSync(path.join(workspaceRoot, 'src', 'alpha.ts'), 'utf8')).toBe('first needle\nsecond line\nthird line\n');

    const written = await app.inject({
      method: 'POST', url: '/changes/write', headers: auth(),
      payload: { workspaceId, relativePath: 'src/new.ts', newContent: 'created from one request\n' },
    });
    expect(payload<{ data: { success: boolean } }>(written).data.success).toBe(true);
    expect(fs.readFileSync(path.join(workspaceRoot, 'src', 'new.ts'), 'utf8')).toBe('created from one request\n');
  });

  it('rotates the API token and immediately rejects the old one', async () => {
    const rotated = await app.inject({ method: 'POST', url: '/auth/rotate-token', headers: auth() });
    expect(rotated.statusCode).toBe(200);
    expect(tokenRef.value).not.toBe(TOKEN);
    const oldToken = await app.inject({ method: 'GET', url: '/workspaces', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(oldToken.statusCode).toBe(401);
    const currentToken = await app.inject({ method: 'GET', url: '/workspaces', headers: auth() });
    expect(currentToken.statusCode).toBe(200);
  });

  it('runs synchronous commands and routes asynchronous job start, status, renewal, and stop', async () => {
    const run = await app.inject({
      method: 'POST', url: '/terminal/run', headers: auth(), payload: { workspaceId, command: 'node --version' },
    });
    expect(payload<{ data: { exitCode: number; stdout: string; timedOut: boolean } }>(run).data)
      .toMatchObject({ exitCode: 0, timedOut: false, stdout: expect.stringMatching(/v\d+/) });

    const runningJob = {
      jobId: 'job-api-test', leaseId: 'lease-api-test', state: 'running',
      command: 'node --version', relativeCwd: '.', exitCode: null, signal: null,
      stdout: '', stderr: '', timedOut: false, truncated: false, durationMs: 0,
      processId: 1, processStartedAt: new Date().toISOString(), workerProcessId: 2,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), terminationReason: null,
    };
    const startedService = jest.spyOn(TerminalService.prototype, 'start').mockReturnValue(runningJob as any);
    const statusService = jest.spyOn(TerminalService.prototype, 'status').mockReturnValue(runningJob as any);
    const renewService = jest.spyOn(TerminalService.prototype, 'renew').mockReturnValue(runningJob as any);
    const stopService = jest.spyOn(TerminalService.prototype, 'stop').mockReturnValue({
      ...runningJob, state: 'stopped', terminationReason: 'explicit_stop',
    } as any);

    const started = await app.inject({
      method: 'POST', url: '/terminal/start', headers: auth(),
      payload: { workspaceId, command: 'node --version', timeoutMs: 10_000 },
    });
    const job = payload<{ data: { jobId: string; leaseId: string; state: string } }>(started).data;
    expect(job.state).toBe('running');
    expect(startedService).toHaveBeenCalledWith(expect.objectContaining({ id: workspaceId }), expect.objectContaining({ command: 'node --version' }));
    const status = await app.inject({ method: 'POST', url: '/terminal/status', headers: auth(), payload: { workspaceId, jobId: job.jobId } });
    expect(payload<{ data: { jobId: string } }>(status).data.jobId).toBe(job.jobId);
    expect(statusService).toHaveBeenCalledWith(expect.objectContaining({ id: workspaceId }), job.jobId);
    const renewed = await app.inject({ method: 'POST', url: '/terminal/renew', headers: auth(), payload: { workspaceId, jobId: job.jobId, leaseId: job.leaseId } });
    expect(renewed.statusCode).toBe(200);
    expect(renewService).toHaveBeenCalledWith(expect.objectContaining({ id: workspaceId }), job.jobId, job.leaseId);
    const stopped = await app.inject({ method: 'POST', url: '/terminal/stop', headers: auth(), payload: { workspaceId, jobId: job.jobId } });
    expect(payload<{ data: { state: string } }>(stopped).data.state).toBe('stopped');
    expect(stopService).toHaveBeenCalledWith(expect.objectContaining({ id: workspaceId }), job.jobId);
  });

  it('creates and reads an xlsx workbook through the spreadsheet route', async () => {
    const created = await app.inject({
      method: 'POST', url: '/spreadsheets/create_spreadsheet', headers: auth(),
      payload: { workspaceId, relativePath: 'report.xlsx', sheets: [{ name: 'Data', headers: ['Name'], rows: [['Ada']] }] },
    });
    expect(created.statusCode).toBe(200);
    expect(fs.existsSync(path.join(workspaceRoot, 'report.xlsx'))).toBe(true);
    const read = await app.inject({
      method: 'POST', url: '/spreadsheets/read_spreadsheet_range', headers: auth(),
      payload: { workspaceId, relativePath: 'report.xlsx', sheetName: 'Data', range: 'A1:A2' },
    });
    expect(read.statusCode).toBe(200);
    expect(payload<{ data: { rows: Array<Array<{ rawValue: unknown }>> } }>(read).data.rows[1][0].rawValue).toBe('Ada');
    const invalid = await app.inject({ method: 'POST', url: '/spreadsheets/not_a_real_action', headers: auth(), payload: {} });
    expect(invalid.statusCode).toBe(400);
    expect(payload<{ ok: boolean; code: string }>(invalid)).toMatchObject({ ok: false, code: 'invalid_request' });
  });

  it('creates, updates, and removes workspaces through the registry routes', async () => {
    const list = await app.inject({ method: 'GET', url: '/workspaces', headers: auth() });
    expect(payload<{ data: Array<{ id: string }> }>(list).data).toHaveLength(1);
    const updated = await app.inject({
      method: 'PUT', url: `/workspaces/${workspaceId}/policy`, headers: auth(),
      payload: { allowedGlobs: ['**/*.md'], blockedGlobs: ['private/**'] },
    });
    expect(payload<{ data: { allowedGlobs: string[]; blockedGlobs: string[] } }>(updated).data)
      .toMatchObject({ allowedGlobs: ['**/*.md'], blockedGlobs: ['private/**'] });
    const removed = await app.inject({ method: 'DELETE', url: `/workspaces/${workspaceId}`, headers: auth() });
    expect(payload<{ data: { removed: boolean } }>(removed).data.removed).toBe(true);
    const missing = await app.inject({ method: 'GET', url: `/workspaces/${workspaceId}`, headers: auth() });
    expect(missing.statusCode).toBe(404);
  });
});
