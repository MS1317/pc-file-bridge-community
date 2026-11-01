import { createHmac } from 'crypto';
import fs from 'fs';
import http, { type Server as HttpServer } from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import type { DeviceCredentials } from './credentials';
import { loadOrCreateCredentials } from './credentials';
import { BridgeAgent } from './agent';

type JsonMessage = Record<string, any>;

function waitForMessage(socket: WebSocket, predicate: (message: JsonMessage) => boolean): Promise<JsonMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('Timed out waiting for relay-agent message'));
    }, 3_000);
    const onMessage = (raw: RawData) => {
      let message: JsonMessage;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.off('message', onMessage);
      resolve(message);
    };
    socket.on('message', onMessage);
  });
}

describe('bridge agent and device credentials', () => {
  let tempDir: string;
  let bridgeServer: HttpServer;
  let relay: WebSocketServer;
  let relaySocket: WebSocket;
  let agent: BridgeAgent;
  let creds: DeviceCredentials;
  let bridgeUrl: string;
  let relayUrl: string;
  let relayConnected: Promise<WebSocket>;
  let resolveRelayConnected: (socket: WebSocket) => void;
  let bridgeCalls: Array<{ method: string; path: string; token: string | string[] | undefined; body: unknown }>;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-agent-test-'));
    bridgeCalls = [];
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    bridgeServer = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const body = text ? JSON.parse(text) : undefined;
        bridgeCalls.push({ method: request.method ?? '', path: request.url ?? '', token: request.headers.authorization, body });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ok: true, data: { method: request.method, path: request.url, body } }));
      });
    });
    await new Promise<void>((resolve) => bridgeServer.listen(0, '127.0.0.1', resolve));
    const bridgeAddress = bridgeServer.address() as net.AddressInfo;
    bridgeUrl = `http://127.0.0.1:${bridgeAddress.port}`;

    relay = new WebSocketServer({ port: 0, host: '127.0.0.1', path: '/device' });
    await new Promise<void>((resolve) => relay.once('listening', resolve));
    const relayAddress = relay.address() as net.AddressInfo;
    relayUrl = `ws://127.0.0.1:${relayAddress.port}/device`;

    creds = { deviceId: 'agent-test-device', deviceSecret: 'device-test-secret' };
    relayConnected = new Promise<WebSocket>((resolve) => { resolveRelayConnected = resolve; });
    relay.on('connection', (socket) => {
      relaySocket = socket;
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as JsonMessage;
        if (message.type === 'auth') socket.send(JSON.stringify({ type: 'auth_ok', sessionId: 'session-test' }));
      });
      resolveRelayConnected(socket);
    });

    agent = new BridgeAgent(relayUrl, creds, bridgeUrl, 'bridge-internal-token');
  });

  afterEach(async () => {
    agent?.stop();
    await new Promise<void>((resolve) => relay?.close(() => resolve()));
    await new Promise<void>((resolve) => bridgeServer?.close(() => resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
    logSpy?.mockRestore();
    warnSpy?.mockRestore();
    errorSpy?.mockRestore();
  });

  it('creates persistent device credentials and replaces malformed credential files', () => {
    const dataDir = path.join(tempDir, 'credentials');
    const first = loadOrCreateCredentials(dataDir);
    expect(first.deviceId).toMatch(/^agent-[a-f0-9]{16}$/);
    expect(first.deviceSecret).toMatch(/^[a-f0-9]{64}$/);
    expect(loadOrCreateCredentials(dataDir)).toEqual(first);

    fs.writeFileSync(path.join(dataDir, 'device-credentials.json'), '{broken', 'utf8');
    const recovered = loadOrCreateCredentials(dataDir);
    expect(recovered.deviceId).not.toBe(first.deviceId);
    expect(recovered.deviceSecret).not.toBe(first.deviceSecret);
  });

  it('authenticates with HMAC, forwards allowed requests with the bridge token, and rejects unsafe or stale requests', async () => {
    agent.start();
    relaySocket = await relayConnected;
    const auth = await waitForMessage(relaySocket, (message) => message.type === 'auth');
    const expectedSignature = createHmac('sha256', creds.deviceSecret)
      .update(`${creds.deviceId}:${auth.nonce}`)
      .digest('hex');
    expect(auth.signature).toBe(expectedSignature);
    expect(auth.agentVersion).toBeTruthy();

    const allowed = {
      type: 'request',
      requestId: 'agent-request-valid',
      operation: 'files.read',
      method: 'POST',
      path: '/files/read',
      body: { workspaceId: 'ws-1', relativePath: 'src/app.ts' },
      createdAt: new Date().toISOString(),
      nonce: 'relay-nonce-1',
    };
    const validResponse = waitForMessage(relaySocket, (message) => message.requestId === allowed.requestId);
    relaySocket.send(JSON.stringify(allowed));
    await expect(validResponse).resolves.toMatchObject({
      type: 'response',
      statusCode: 200,
      body: { ok: true, data: { path: '/files/read', body: allowed.body } },
    });
    expect(bridgeCalls).toEqual([{
      method: 'POST', path: '/files/read', token: 'Bearer bridge-internal-token', body: allowed.body,
    }]);

    const rejected = [
      { ...allowed, requestId: 'agent-request-forbidden', operation: 'terminal.run' },
      { ...allowed, requestId: 'agent-request-mismatch', method: 'GET' },
      { ...allowed, requestId: 'agent-request-stale', createdAt: new Date(Date.now() - 60_000).toISOString() },
    ];
    for (const request of rejected) {
      const result = waitForMessage(relaySocket, (message) => message.requestId === request.requestId);
      relaySocket.send(JSON.stringify(request));
      await expect(result).resolves.toMatchObject({ type: 'error' });
    }
    expect(bridgeCalls).toHaveLength(1);

    const duplicateResponse = waitForMessage(relaySocket, (message) => message.requestId === allowed.requestId);
    relaySocket.send(JSON.stringify(allowed));
    await expect(duplicateResponse).resolves.toMatchObject({ code: 'REPLAY_DETECTED' });
    expect(bridgeCalls).toHaveLength(1);
  });
});
