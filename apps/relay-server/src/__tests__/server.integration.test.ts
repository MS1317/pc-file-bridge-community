import { createHmac, randomUUID } from 'crypto';
import type { AddressInfo } from 'net';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import { buildRelayServer } from '../server';

type JsonMessage = Record<string, any>;

function waitForMessage(socket: WebSocket, predicate: (message: JsonMessage) => boolean): Promise<JsonMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('Timed out waiting for relay message'));
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

describe('relay server integration', () => {
  const relayClientToken = 'relay-client-test-token'.padEnd(64, 'r');
  const deviceId = `agent-${randomUUID()}`;
  const deviceSecret = 'device-test-secret';
  let fastify: Awaited<ReturnType<typeof buildRelayServer>>['fastify'];
  let wss: WebSocketServer;
  let relayUrl: string;
  let client: WebSocket;
  let usedNonce: string;

  beforeAll(async () => {
    const server = await buildRelayServer({
      relayClientToken,
      deviceSecrets: new Map([[deviceId, deviceSecret]]),
    });
    fastify = server.fastify;
    wss = server.wss;
    await fastify.listen({ host: '127.0.0.1', port: 0 });
    const address = fastify.server.address() as AddressInfo;
    relayUrl = `ws://127.0.0.1:${address.port}/device`;
  });

  afterAll(async () => {
    if (client && client.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        client.once('close', () => resolve());
        client.close();
      });
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await fastify.close();
  });

  async function authenticate(signatureOverride?: string, nonceOverride?: string): Promise<WebSocket> {
    const socket = new WebSocket(relayUrl);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const nonce = nonceOverride ?? randomUUID();
    const signature = createHmac('sha256', deviceSecret).update(`${deviceId}:${nonce}`).digest('hex');
    const authReply = waitForMessage(socket, (message) => message.type === 'auth_ok' || message.type === 'auth_fail');
    socket.send(JSON.stringify({
      type: 'auth',
      deviceId,
      signature: signatureOverride ?? signature,
      nonce,
      timestamp: new Date().toISOString(),
      agentVersion: 'test-agent',
    }));
    const result = await authReply;
    if (result.type !== 'auth_ok') {
      socket.close();
      throw new Error(`Device authentication failed: ${result.reason}`);
    }
    usedNonce = nonce;
    return socket;
  }

  it('authenticates devices, exposes status, and proxies only allowed remote operations', async () => {
    const health = await fastify.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({ ok: true, service: 'relay-server' });

    const noClientAuth = await fastify.inject({
      method: 'POST', url: '/gpt/request', payload: { deviceId, operation: 'files.read' },
    });
    expect(noClientAuth.statusCode).toBe(401);

    const offline = await fastify.inject({
      method: 'POST', headers: { authorization: `Bearer ${relayClientToken}` }, url: '/gpt/request',
      payload: { deviceId: 'offline-device', operation: 'files.read' },
    });
    expect(offline.statusCode).toBe(503);
    expect(JSON.parse(offline.body)).toMatchObject({ code: 'DEVICE_OFFLINE' });

    const forbidden = await fastify.inject({
      method: 'POST', headers: { authorization: `Bearer ${relayClientToken}` }, url: '/gpt/request',
      payload: { deviceId, operation: 'terminal.run' },
    });
    expect(forbidden.statusCode).toBe(400);
    expect(JSON.parse(forbidden.body)).toMatchObject({ code: 'OPERATION_NOT_ALLOWED' });

    client = await authenticate();
    const deniedDevices = await fastify.inject({ method: 'GET', url: '/devices' });
    expect(deniedDevices.statusCode).toBe(401);
    const devices = await fastify.inject({ method: 'GET', url: '/devices', headers: { authorization: `Bearer ${relayClientToken}` } });
    expect(JSON.parse(devices.body).devices).toEqual(expect.arrayContaining([
      expect.objectContaining({ deviceId, connected: true, agentVersion: 'test-agent' }),
    ]));

    const heartbeatAck = waitForMessage(client, (message) => message.type === 'heartbeat_ack');
    client.send(JSON.stringify({
      type: 'heartbeat', deviceId, timestamp: new Date().toISOString(), bridgeApiHealthy: true, agentVersion: 'test-agent',
    }));
    await expect(heartbeatAck).resolves.toMatchObject({ type: 'heartbeat_ack' });

    const proxied = fastify.inject({
      method: 'POST', headers: { authorization: `Bearer ${relayClientToken}` }, url: '/gpt/request',
      payload: { deviceId, operation: 'files.read', body: { workspaceId: 'ws-1', relativePath: 'src/app.ts' } },
    });
    const request = await waitForMessage(client, (message) => message.type === 'request');
    expect(request).toMatchObject({
      operation: 'files.read', method: 'POST', path: '/files/read',
      body: { workspaceId: 'ws-1', relativePath: 'src/app.ts' },
    });
    client.send(JSON.stringify({
      type: 'response', requestId: request.requestId, statusCode: 200, body: { ok: true, data: { content: 'hello' } },
    }));
    const result = await proxied;
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ ok: true, data: { content: 'hello' } });
  });

  it('rejects invalid HMAC signatures and replayed authentication nonces', async () => {
    const invalid = new WebSocket(relayUrl);
    await new Promise<void>((resolve, reject) => {
      invalid.once('open', resolve);
      invalid.once('error', reject);
    });
    const invalidNonce = randomUUID();
    const invalidResponse = waitForMessage(invalid, (message) => message.type === 'auth_fail');
    invalid.send(JSON.stringify({
      type: 'auth', deviceId, signature: 'bad-signature', nonce: invalidNonce,
      timestamp: new Date().toISOString(), agentVersion: 'test-agent',
    }));
    await expect(invalidResponse).resolves.toMatchObject({ reason: 'Invalid signature' });

    if (!client || client.readyState !== WebSocket.OPEN) client = await authenticate();
    const replay = new WebSocket(relayUrl);
    await new Promise<void>((resolve, reject) => {
      replay.once('open', resolve);
      replay.once('error', reject);
    });
    const signature = createHmac('sha256', deviceSecret).update(`${deviceId}:${usedNonce}`).digest('hex');
    const replayResponse = waitForMessage(replay, (message) => message.type === 'auth_fail');
    replay.send(JSON.stringify({
      type: 'auth', deviceId, signature, nonce: usedNonce,
      timestamp: new Date().toISOString(), agentVersion: 'test-agent',
    }));
    await expect(replayResponse).resolves.toMatchObject({ reason: 'Replay detected' });
    replay.close();
  });
});
