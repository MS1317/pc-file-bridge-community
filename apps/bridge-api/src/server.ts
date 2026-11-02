import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AccessControl, type AccessKind } from './accessControl';
import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import {
  WorkspaceRegistry,
  FileService,
  ChangeService,
  AuditLog,
  validateToken,
  rotateToken,
  RateLimiter,
  PendingStore,
  TerminalService,
  SpreadsheetService,
  SpreadsheetError,
} from '@bridge/core';
import type {
  TerminalExecutionPolicy,
  WorkspaceInput,
  WorkspacePolicyUpdate,
  ChangePreviewRequest,
  ReplaceRangeRequest,
  InsertLineRequest,
  TerminalJobRequest,
  TerminalJobRenewRequest,
  TerminalRunRequest,
  SpreadsheetActionName,
} from '@bridge/shared';
import { parseSpreadsheetRequest, SpreadsheetContractError, TERMINAL_EXECUTION_POLICY } from '@bridge/shared';

export interface ServerOptions {
  dataDir: string;
  /** Mutable ref so token rotation updates it in place without restarting the server. */
  tokenRef: { value: string };
  terminalPolicy?: TerminalExecutionPolicy;
}

export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  const { dataDir, tokenRef, terminalPolicy = TERMINAL_EXECUTION_POLICY } = opts;

  const access = new AccessControl(dataDir);
  const adminTokenPath = path.join(dataDir, 'local-admin-token.txt');
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(adminTokenPath)) fs.writeFileSync(adminTokenPath, crypto.randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  const localAdminToken = fs.readFileSync(adminTokenPath, 'utf8').trim();

  const registry = new WorkspaceRegistry(dataDir);
  const fileService = new FileService();
  const auditLog = new AuditLog(dataDir);
  const pendingStore = new PendingStore();
  const changeService = new ChangeService(dataDir, auditLog, pendingStore);
  const terminalService = new TerminalService(auditLog, dataDir, { policy: terminalPolicy });
  const spreadsheetService = new SpreadsheetService(dataDir, auditLog);
  const rateLimiter = new RateLimiter({ maxRequests: 120, windowMs: 60_000 });

  // Prune rate-limiter buckets every minute
  setInterval(() => rateLimiter.prune(), 60_000).unref();

  const app = Fastify({ logger: false });

  await app.register(cors, {
    origin: ['http://127.0.0.1:4778', 'http://localhost:4778'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  // ── Auth + Rate-limit hook ──────────────────────────────────────────────────
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.url === '/health') return;

    const authHeader = req.headers['authorization'] ?? '';
    const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!validateToken(provided, tokenRef.value)) {
      return reply.status(401).send({ ok: false, error: 'Unauthorized', code: 'INVALID_TOKEN' });
    }

    // Rate-limit by first 16 chars of the token (stable key, not full token in logs)
    const rateLimitKey = provided.slice(0, 16);
    if (!rateLimiter.check(rateLimitKey)) {
      const retryAfter = Math.ceil(rateLimiter.retryAfterMs(rateLimitKey) / 1000);
      reply.header('Retry-After', String(retryAfter));
      return reply.status(429).send({
        ok: false,
        error: `Rate limit exceeded. Try again in ${retryAfter}s.`,
        code: 'RATE_LIMITED',
      });
    }
  });

  // ── Health ──────────────────────────────────────────────────────────────────
  // Access settings can only be changed by the local dashboard, never by remote MCP clients.
  const localOnly = async (req: FastifyRequest, reply: FastifyReply) => {
    const ip = req.ip.replace(/^::ffff:/, '');
    if (ip !== '127.0.0.1' && ip !== '::1') {
      return reply.status(403).send({ ok: false, error: 'Local dashboard only' });
    }
    if (!validateToken(String(req.headers['x-local-admin-token'] ?? ''), localAdminToken)) {
      return reply.status(403).send({ ok: false, error: 'Local administrator token required' });
    }
    const origin = req.headers.origin;
    if (origin !== 'http://localhost:4778' && origin !== 'http://127.0.0.1:4778') {
      return reply.status(403).send({ ok: false, error: 'Untrusted origin' });
    }
  };
  app.get('/access/policy', async () => ({ ok: true, data: access.getPolicy() }));
  app.put('/access/policy', { preHandler: localOnly }, async (req, reply) => {
    try { return { ok: true, data: access.setPolicy(req.body) }; }
    catch (e) { return reply.status(400).send({ ok: false, error: String(e) }); }
  });
  app.get('/access/approvals', { preHandler: localOnly }, async () => ({ ok: true, data: access.list() }));
  app.get('/access/approvals/:id', async (req, reply) => {
    const item = access.status((req.params as { id: string }).id);
    return item ? { ok: true, data: item } : reply.status(404).send({ ok: false, error: 'Not found' });
  });
  app.post('/access/approvals/:id/approve', { preHandler: localOnly }, async (req, reply) => {
    try { return { ok: true, data: await access.approve((req.params as { id: string }).id) }; }
    catch (e) { return reply.status(409).send({ ok: false, error: String(e) }); }
  });
  app.post('/access/approvals/:id/reject', { preHandler: localOnly }, async (req, reply) => {
    try { return { ok: true, data: access.reject((req.params as { id: string }).id) }; }
    catch (e) { return reply.status(409).send({ ok: false, error: String(e) }); }
  });
  const internalExecutionKey = crypto.randomUUID();
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.url.startsWith('/access/')) return;
    const path = req.url.split('?')[0];
    const terminal = ['/terminal/run', '/terminal/start', '/terminal/renew', '/terminal/stop'].includes(path);
    const spreadsheetMutations = ['append_spreadsheet_rows', 'update_spreadsheet_range', 'update_spreadsheet_rows_by_key', 'upsert_spreadsheet_rows', 'create_spreadsheet', 'create_spreadsheet_sheet'];
    const write = ['/changes/write', '/changes/apply', '/changes/revert'].includes(path)
      || (path.startsWith('/spreadsheets/') && spreadsheetMutations.includes(path.split('/')[2]));
    if (!terminal && !write) return;
    if (req.headers['x-local-approval-execution'] === internalExecutionKey) return;
    const kind: AccessKind = terminal ? 'terminal' : 'fileWrites';
    // Only locally approved execution may bypass the gate. This is private to the server instance.
    const body = req.body as any;
    try {
      const result = access.submit(kind, path, body?.workspaceId || '', path + ' requested', {
        relativePath: String(body?.relativePath || ''),
        command: String(body?.command || '').slice(0, 500)
      }, async () => {
        const response = await app.inject({ method: 'POST', url: path, headers: {
          authorization: 'Bearer ' + tokenRef.value,
          'x-local-approval-execution': internalExecutionKey
        }, payload: body });
        const data = response.json();
        if (response.statusCode >= 400 || !data.ok) throw new Error(data.error || 'Execution failed');
        return data.data;
      });
      if (result && typeof (result as any).then === 'function') {
        const data = await (result as Promise<unknown>);
        return reply.send({ ok: true, data });
      }
      return reply.status(202).send({ ok: true, data: { approvalRequired: true, ...(result as object) } });
    } catch (e) { return reply.status(403).send({ ok: false, error: String(e) }); }
  });

  app.get('/health', async () => ({
    ok: true,
    data: { status: 'running', version: '0.2.0', timestamp: new Date().toISOString() },
  }));

  // ── Auth ────────────────────────────────────────────────────────────────────
  app.post('/auth/rotate-token', async (_req, reply) => {
    try {
      const newToken = rotateToken(dataDir);
      tokenRef.value = newToken;

      auditLog.append({
        id: `rotate-${Date.now()}`,
        timestamp: new Date().toISOString(),
        action: 'token_rotation',
        workspaceId: '',
        workspaceName: '',
        relativePath: '',
        oldHash: null,
        newHash: null,
        backupId: '',
      });

      return reply.send({
        ok: true,
        data: {
          rotated: true,
          newToken,
          message: 'Token rotated. Update the dashboard immediately — the old token is invalid.',
        },
      });
    } catch (e: any) {
      return reply.status(500).send({ ok: false, error: e.message });
    }
  });

  // ── Workspaces ──────────────────────────────────────────────────────────────
  app.get('/workspaces', async () => {
    try {
      return { ok: true, data: registry.list() };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  });

  app.post('/workspaces', async (req, reply) => {
    const input = req.body as WorkspaceInput;
    if (!input?.name || !input?.root) {
      return reply.status(400).send({ ok: false, error: 'name and root are required' });
    }
    try {
      const workspace = registry.add(input);
      return reply.status(201).send({ ok: true, data: workspace });
    } catch (e: any) {
      return reply.status(400).send({ ok: false, error: e.message });
    }
  });

  app.get('/workspaces/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const workspace = registry.get(id);
    if (!workspace) return reply.status(404).send({ ok: false, error: 'Workspace not found' });
    return { ok: true, data: workspace };
  });

  app.put('/workspaces/:id/policy', async (req, reply) => {
    const { id } = req.params as { id: string };
    const input = req.body as WorkspacePolicyUpdate;
    if (!input || !Array.isArray(input.allowedGlobs) || !Array.isArray(input.blockedGlobs)) {
      return reply.status(400).send({ ok: false, error: 'allowedGlobs and blockedGlobs arrays are required' });
    }
    try {
      const workspace = registry.updatePolicy(id, input);
      if (!workspace) return reply.status(404).send({ ok: false, error: 'Workspace not found' });
      return { ok: true, data: workspace };
    } catch (e: any) {
      return reply.status(400).send({ ok: false, error: e.message });
    }
  });

  app.delete('/workspaces/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const removed = registry.remove(id);
    if (!removed) return reply.status(404).send({ ok: false, error: 'Workspace not found' });
    return { ok: true, data: { removed: true } };
  });

  // ── Files ───────────────────────────────────────────────────────────────────
  app.post('/files/list', async (req, reply) => {
    const { workspaceId } = req.body as { workspaceId: string };
    const workspace = registry.get(workspaceId);
    if (!workspace) return reply.status(404).send({ ok: false, error: 'Workspace not found' });
    try {
      return { ok: true, data: fileService.listFiles(workspace) };
    } catch (e: any) {
      return reply.status(400).send({ ok: false, error: e.message });
    }
  });

  app.post('/files/search', async (req, reply) => {
    const { workspaceId, query, glob } = req.body as {
      workspaceId: string;
      query: string;
      glob?: string;
    };
    if (!query) return reply.status(400).send({ ok: false, error: 'query is required' });
    const workspace = registry.get(workspaceId);
    if (!workspace) return reply.status(404).send({ ok: false, error: 'Workspace not found' });
    try {
      return { ok: true, data: fileService.searchFiles(workspace, query, glob) };
    } catch (e: any) {
      return reply.status(400).send({ ok: false, error: e.message });
    }
  });

  app.post('/files/read', async (req, reply) => {
    const { workspaceId, relativePath } = req.body as {
      workspaceId: string;
      relativePath: string;
    };
    if (!relativePath)
      return reply.status(400).send({ ok: false, error: 'relativePath is required' });
    const workspace = registry.get(workspaceId);
    if (!workspace) return reply.status(404).send({ ok: false, error: 'Workspace not found' });
    try {
      return { ok: true, data: fileService.readFile(workspace, relativePath) };
    } catch (e: any) {
      return reply.status(400).send({ ok: false, error: e.message });
    }
  });

  // ── Large-repo navigation ───────────────────────────────────────────────────
  app.post('/files/tree', async (req, reply) => {
    const { workspaceId, relativePath, maxDepth, limit } = req.body as {
      workspaceId: string;
      relativePath?: string;
      maxDepth?: number;
      limit?: number;
    };
    const workspace = registry.get(workspaceId);
    if (!workspace) return reply.status(404).send({ ok: false, error: 'Workspace not found' });
    try {
      return { ok: true, data: fileService.listTree(workspace, relativePath ?? '', maxDepth, limit) };
    } catch (e: any) {
      return reply.status(400).send({ ok: false, error: e.message });
    }
  });

  app.post('/files/range', async (req, reply) => {
    const { workspaceId, relativePath, startLine, endLine } = req.body as {
      workspaceId: string;
      relativePath: string;
      startLine: number;
      endLine: number;
    };
    if (!relativePath || startLine == null || endLine == null) {
      return reply.status(400).send({ ok: false, error: 'relativePath, startLine, and endLine are required' });
    }
    const workspace = registry.get(workspaceId);
    if (!workspace) return reply.status(404).send({ ok: false, error: 'Workspace not found' });
    try {
      return { ok: true, data: fileService.readFileRange(workspace, relativePath, Number(startLine), Number(endLine)) };
    } catch (e: any) {
      return reply.status(400).send({ ok: false, error: e.message });
    }
  });

  app.post('/files/find', async (req, reply) => {
    const { workspaceId, query, limit } = req.body as {
      workspaceId: string;
      query: string;
      limit?: number;
    };
    if (!query) return reply.status(400).send({ ok: false, error: 'query is required' });
    const workspace = registry.get(workspaceId);
    if (!workspace) return reply.status(404).send({ ok: false, error: 'Workspace not found' });
    try {
      return { ok: true, data: fileService.findFile(workspace, query, limit) };
    } catch (e: any) {
      return reply.status(400).send({ ok: false, error: e.message });
    }
  });

  app.post('/files/overview', async (req, reply) => {
    const { workspaceId } = req.body as { workspaceId: string };
    const workspace = registry.get(workspaceId);
    if (!workspace) return reply.status(404).send({ ok: false, error: 'Workspace not found' });
    try {
      return { ok: true, data: fileService.repoOverview(workspace) };
    } catch (e: any) {
      return reply.status(400).send({ ok: false, error: e.message });
    }
  });

  // ── Targeted edits (line-based preview — no direct file writes) ────────────
  app.post('/terminal/run', async (req, reply) => {
    const body = req.body as TerminalRunRequest;
    if (!body?.workspaceId || !body?.command) {
      return reply.status(400).send({ ok: false, error: 'workspaceId and command are required' });
    }
    const workspace = registry.get(body.workspaceId);
    if (!workspace) return reply.status(404).send({ ok: false, error: 'Workspace not found' });
    try {
      return { ok: true, data: await terminalService.run(workspace, body) };
    } catch (e: any) {
      return reply.status(400).send({ ok: false, error: e.message });
    }
  });

  app.post('/terminal/start', async (req, reply) => {
    const body = req.body as TerminalRunRequest;
    if (!body?.workspaceId || !body?.command) {
      return reply.status(400).send({ ok: false, error: 'workspaceId and command are required' });
    }
    const workspace = registry.get(body.workspaceId);
    if (!workspace) return reply.status(404).send({ ok: false, error: 'Workspace not found' });
    try {
      return { ok: true, data: terminalService.start(workspace, body) };
    } catch (e: any) {
      return reply.status(400).send({ ok: false, error: e.message });
    }
  });

  app.post('/terminal/status', async (req, reply) => {
    const body = req.body as TerminalJobRequest;
    if (!body?.workspaceId || !body?.jobId) {
      return reply.status(400).send({ ok: false, error: 'workspaceId and jobId are required' });
    }
    const workspace = registry.get(body.workspaceId);
    if (!workspace) return reply.status(404).send({ ok: false, error: 'Workspace not found' });
    try {
      return { ok: true, data: terminalService.status(workspace, body.jobId) };
    } catch (e: any) {
      return reply.status(400).send({ ok: false, error: e.message });
    }
  });

  app.post('/terminal/renew', async (req, reply) => {
    const body = req.body as TerminalJobRenewRequest;
    if (!body?.workspaceId || !body?.jobId || !body?.leaseId) {
      return reply.status(400).send({ ok: false, error: 'workspaceId, jobId, and leaseId are required' });
    }
    const workspace = registry.get(body.workspaceId);
    if (!workspace) return reply.status(404).send({ ok: false, error: 'Workspace not found' });
    try {
      return { ok: true, data: terminalService.renew(workspace, body.jobId, body.leaseId) };
    } catch (e: any) {
      return reply.status(400).send({ ok: false, error: e.message });
    }
  });

  app.post('/terminal/stop', async (req, reply) => {
    const body = req.body as TerminalJobRequest;
    if (!body?.workspaceId || !body?.jobId) {
      return reply.status(400).send({ ok: false, error: 'workspaceId and jobId are required' });
    }
    const workspace = registry.get(body.workspaceId);
    if (!workspace) return reply.status(404).send({ ok: false, error: 'Workspace not found' });
    try {
      return { ok: true, data: terminalService.stop(workspace, body.jobId) };
    } catch (e: any) {
      return reply.status(400).send({ ok: false, error: e.message });
    }
  });

  app.post('/spreadsheets/:action', async (req, reply) => {
    const { action } = req.params as { action: string };
    try {
      const parsed = parseSpreadsheetRequest(action, req.body);
      const workspace = registry.get(parsed.workspaceId);
      if (!workspace) return reply.status(404).send({ ok: false, error: 'Workspace not found' });
      const result = await spreadsheetService.execute(workspace, action as SpreadsheetActionName, parsed);
      return { ok: true, data: result };
    } catch (error) {
      const spreadsheetError = error instanceof SpreadsheetError
        ? error
        : error instanceof SpreadsheetContractError
          ? new SpreadsheetError(error.kind, error.message)
          : null;
      if (spreadsheetError) {
        const status = spreadsheetError.kind === 'concurrent_modification' ? 409 : 400;
        return reply.status(status).send({ ok: false, error: spreadsheetError.message, code: spreadsheetError.kind });
      }
      const message = error instanceof Error ? error.message : 'Spreadsheet operation failed';
      return reply.status(400).send({ ok: false, error: message, code: 'write_failed' });
    }
  });

  app.post('/changes/replace-range', async (req, reply) => {
    const body = req.body as ReplaceRangeRequest;
    if (!body?.workspaceId || !body?.relativePath || body?.startLine == null || body?.endLine == null || body?.newContent === undefined) {
      return reply.status(400).send({ ok: false, error: 'workspaceId, relativePath, startLine, endLine, and newContent are required' });
    }
    const workspace = registry.get(body.workspaceId);
    if (!workspace) return reply.status(404).send({ ok: false, error: 'Workspace not found' });
    try {
      return { ok: true, data: changeService.previewReplaceRange(workspace, { ...body, startLine: Number(body.startLine), endLine: Number(body.endLine) }) };
    } catch (e: any) {
      return reply.status(400).send({ ok: false, error: e.message });
    }
  });

  app.post('/changes/insert-before', async (req, reply) => {
    const body = req.body as InsertLineRequest;
    if (!body?.workspaceId || !body?.relativePath || body?.line == null || body?.content === undefined) {
      return reply.status(400).send({ ok: false, error: 'workspaceId, relativePath, line, and content are required' });
    }
    const workspace = registry.get(body.workspaceId);
    if (!workspace) return reply.status(404).send({ ok: false, error: 'Workspace not found' });
    try {
      return { ok: true, data: changeService.previewInsertBefore(workspace, { ...body, line: Number(body.line) }) };
    } catch (e: any) {
      return reply.status(400).send({ ok: false, error: e.message });
    }
  });

  app.post('/changes/insert-after', async (req, reply) => {
    const body = req.body as InsertLineRequest;
    if (!body?.workspaceId || !body?.relativePath || body?.line == null || body?.content === undefined) {
      return reply.status(400).send({ ok: false, error: 'workspaceId, relativePath, line, and content are required' });
    }
    const workspace = registry.get(body.workspaceId);
    if (!workspace) return reply.status(404).send({ ok: false, error: 'Workspace not found' });
    try {
      return { ok: true, data: changeService.previewInsertAfter(workspace, { ...body, line: Number(body.line) }) };
    } catch (e: any) {
      return reply.status(400).send({ ok: false, error: e.message });
    }
  });

  // ── Changes (pending-change flow) ───────────────────────────────────────────
  app.post('/changes/preview', async (req, reply) => {
    const body = req.body as ChangePreviewRequest;
    if (!body?.workspaceId || !body?.relativePath || body?.newContent === undefined) {
      return reply
        .status(400)
        .send({ ok: false, error: 'workspaceId, relativePath, and newContent are required' });
    }
    const workspace = registry.get(body.workspaceId);
    if (!workspace) return reply.status(404).send({ ok: false, error: 'Workspace not found' });
    try {
      const result = changeService.preview(workspace, body);
      return { ok: true, data: result };
    } catch (e: any) {
      return reply.status(400).send({ ok: false, error: e.message });
    }
  });

  // Atomic write: preview + apply in one request (one tunnel round trip instead
  // of two). Same guards as the two-step flow.
  app.post('/changes/write', async (req, reply) => {
    const body = req.body as ChangePreviewRequest;
    if (!body?.workspaceId || !body?.relativePath || body?.newContent === undefined) {
      return reply
        .status(400)
        .send({ ok: false, error: 'workspaceId, relativePath, and newContent are required' });
    }
    const workspace = registry.get(body.workspaceId);
    if (!workspace) return reply.status(404).send({ ok: false, error: 'Workspace not found' });
    try {
      return { ok: true, data: changeService.applyImmediate(workspace, body) };
    } catch (e: any) {
      return reply.status(400).send({ ok: false, error: e.message });
    }
  });

  app.get('/changes/pending', async () => {
    return { ok: true, data: changeService.listPending() };
  });

  app.post('/changes/apply', async (req, reply) => {
    const { workspaceId, pendingChangeId } = req.body as {
      workspaceId: string;
      pendingChangeId: string;
    };
    if (!workspaceId || !pendingChangeId) {
      return reply
        .status(400)
        .send({ ok: false, error: 'workspaceId and pendingChangeId are required' });
    }
    const workspace = registry.get(workspaceId);
    if (!workspace) return reply.status(404).send({ ok: false, error: 'Workspace not found' });
    try {
      const result = changeService.applyPending(workspace, pendingChangeId);
      return { ok: true, data: result };
    } catch (e: any) {
      return reply.status(400).send({ ok: false, error: e.message });
    }
  });

  app.post('/changes/reject', async (req, reply) => {
    const { pendingChangeId } = req.body as { pendingChangeId: string };
    if (!pendingChangeId) {
      return reply.status(400).send({ ok: false, error: 'pendingChangeId is required' });
    }
    try {
      changeService.rejectPending(pendingChangeId);
      return { ok: true, data: { rejected: true } };
    } catch (e: any) {
      return reply.status(400).send({ ok: false, error: e.message });
    }
  });

  app.get('/changes/recent', async (req) => {
    const limit = Number((req.query as any)?.limit ?? 50);
    return { ok: true, data: auditLog.readRecent(Math.min(limit, 200)) };
  });

  app.post('/changes/revert', async (req, reply) => {
    const { workspaceId, auditId } = req.body as { workspaceId: string; auditId: string };
    if (!workspaceId || !auditId) {
      return reply.status(400).send({ ok: false, error: 'workspaceId and auditId are required' });
    }
    const workspace = registry.get(workspaceId);
    if (!workspace) return reply.status(404).send({ ok: false, error: 'Workspace not found' });
    try {
      return { ok: true, data: changeService.revert(workspace, auditId) };
    } catch (e: any) {
      return reply.status(400).send({ ok: false, error: e.message });
    }
  });

  return app;
}
