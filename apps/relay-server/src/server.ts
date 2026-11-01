import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID, createHmac, timingSafeEqual } from 'crypto';
import {
  ALLOWED_OPERATIONS,
  OPERATION_MAP,
  type WsMessage,
  type AuthMessage,
  type HeartbeatMessage,
  type RelayResponseMessage,
  type RelayErrorMessage,
} from 'shared';
import {
  registerDevice,
  unregisterDevice,
  touchDevice,
  getDevice,
  listDevices,
  findDeviceBySessionId,
} from './deviceRegistry.js';

export interface RelayServerOptions {
  relayClientToken: string;
  /** deviceId → deviceSecret map for HMAC auth */
  deviceSecrets: Map<string, string>;
  port?: number;
}

// In-memory sliding-window rate limiter for GPT-facing endpoints
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const NONCE_TTL_MS = 120_000;
const seenNonces = new Map<string, number>();

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const times = (rateLimitMap.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (times.length >= RATE_LIMIT) {
    rateLimitMap.set(key, times);
    return false;
  }
  times.push(now);
  rateLimitMap.set(key, times);
  return true;
}

function pruneNonces(): void {
  const cutoff = Date.now() - NONCE_TTL_MS;
  for (const [nonce, ts] of seenNonces) {
    if (ts < cutoff) seenNonces.delete(nonce);
  }
}

function verifyDeviceHmac(
  deviceId: string,
  nonce: string,
  timestamp: string,
  signature: string,
  deviceSecrets: Map<string, string>,
): boolean {
  const secret = deviceSecrets.get(deviceId);
  if (!secret) return false;

  const age = Date.now() - new Date(timestamp).getTime();
  if (Math.abs(age) > 60_000) return false;

  const expected = createHmac('sha256', secret)
    .update(`${deviceId}:${nonce}`)
    .digest('hex');

  try {
    return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

export async function buildRelayServer(opts: RelayServerOptions): Promise<{
  fastify: FastifyInstance;
  wss: WebSocketServer;
}> {
  const fastify = Fastify({ logger: false });
  await fastify.register(cors, { origin: false });

  // Auth hook for GPT-facing endpoints
  fastify.addHook('onRequest', async (req, reply) => {
    if (req.url === '/health') return;

    const auth = req.headers['authorization'] ?? '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (!timingSafeEqual(
      Buffer.from(token.padEnd(64, '\0')),
      Buffer.from(opts.relayClientToken.padEnd(64, '\0')),
    )) {
      await reply.code(401).send({ ok: false, error: 'Unauthorized' });
    }
  });

  fastify.get('/health', async () => ({
    ok: true,
    service: 'relay-server',
    version: '0.1.0',
    connectedDevices: listDevices().filter((d) => d.connected).length,
  }));

  fastify.get('/devices', async () => ({ ok: true, devices: listDevices() }));

  // GPT-facing proxy endpoint: POST /gpt/request
  fastify.post<{ Body: { deviceId: string; operation: string; body?: unknown } }>(
    '/gpt/request',
    {
      schema: {
        body: {
          type: 'object',
          required: ['deviceId', 'operation'],
          properties: {
            deviceId: { type: 'string' },
            operation: { type: 'string' },
            body: {},
          },
        },
      },
    },
    async (req, reply) => {
      const { deviceId, operation, body: reqBody } = req.body;

      // Rate limit per device
      if (!checkRateLimit(deviceId)) {
        return reply.code(429).header('Retry-After', '60').send({
          ok: false,
          error: 'Rate limit exceeded',
          code: 'RATE_LIMITED',
        });
      }

      // Allowlist check
      if (!ALLOWED_OPERATIONS.has(operation)) {
        return reply.code(400).send({
          ok: false,
          error: `Operation '${operation}' is not allowed`,
          code: 'OPERATION_NOT_ALLOWED',
        });
      }

      const opSpec = OPERATION_MAP[operation];
      if (!opSpec) {
        return reply.code(400).send({ ok: false, error: 'Unknown operation', code: 'UNKNOWN_OPERATION' });
      }

      const device = getDevice(deviceId);
      if (!device) {
        return reply.code(503).send({
          ok: false,
          error: 'PC bridge is offline. Open the bridge agent on your PC.',
          code: 'DEVICE_OFFLINE',
        });
      }

      const requestId = randomUUID();
      const nonce = randomUUID();
      const createdAt = new Date().toISOString();

      // Send request to device over WebSocket
      const relayReq = {
        type: 'request' as const,
        requestId,
        operation,
        method: opSpec.method,
        path: opSpec.path,
        body: reqBody,
        createdAt,
        nonce,
      };

      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          device.ws.removeListener('message', onMessage);
          resolve(reply.code(504).send({
            ok: false,
            error: 'Device timed out',
            code: 'DEVICE_TIMEOUT',
          }));
        }, REQUEST_TIMEOUT_MS);

        function onMessage(raw: Buffer) {
          let msg: WsMessage;
          try {
            msg = JSON.parse(raw.toString());
          } catch {
            return;
          }

          if (
            (msg.type === 'response' || msg.type === 'error') &&
            'requestId' in msg &&
            msg.requestId === requestId
          ) {
            clearTimeout(timer);
            device.ws.removeListener('message', onMessage);

            if (msg.type === 'response') {
              const resp = msg as RelayResponseMessage;
              resolve(reply.code(resp.statusCode).send(resp.body));
            } else {
              const err = msg as RelayErrorMessage;
              resolve(reply.code(502).send({ ok: false, error: err.message, code: err.code }));
            }
          }
        }

        device.ws.on('message', onMessage);
        device.ws.send(JSON.stringify(relayReq));
      });
    },
  );

  // Build HTTP server for WS upgrade
  const httpServer = createServer(fastify.server);
  const wss = new WebSocketServer({ server: fastify.server, path: '/device' });

  wss.on('connection', (ws: WebSocket) => {
    let authenticatedDeviceId: string | null = null;

    const authTimeout = setTimeout(() => {
      if (!authenticatedDeviceId) {
        ws.send(JSON.stringify({ type: 'auth_fail', reason: 'Auth timeout' }));
        ws.close();
      }
    }, 5_000);

    ws.on('message', (raw: Buffer) => {
      let msg: WsMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'error', code: 'PARSE_ERROR', message: 'Invalid JSON' }));
        return;
      }

      if (msg.type === 'auth') {
        clearTimeout(authTimeout);
        const authMsg = msg as AuthMessage;
        pruneNonces();

        if (seenNonces.has(authMsg.nonce)) {
          ws.send(JSON.stringify({ type: 'auth_fail', reason: 'Replay detected' }));
          ws.close();
          return;
        }

        if (!verifyDeviceHmac(
          authMsg.deviceId,
          authMsg.nonce,
          authMsg.timestamp,
          authMsg.signature,
          opts.deviceSecrets,
        )) {
          ws.send(JSON.stringify({ type: 'auth_fail', reason: 'Invalid signature' }));
          ws.close();
          return;
        }

        seenNonces.set(authMsg.nonce, Date.now());
        authenticatedDeviceId = authMsg.deviceId;
        const sessionId = registerDevice(authMsg.deviceId, ws, authMsg.agentVersion);
        ws.send(JSON.stringify({ type: 'auth_ok', sessionId }));
        return;
      }

      if (!authenticatedDeviceId) {
        ws.send(JSON.stringify({ type: 'auth_fail', reason: 'Not authenticated' }));
        ws.close();
        return;
      }

      if (msg.type === 'heartbeat') {
        const hb = msg as HeartbeatMessage;
        touchDevice(hb.deviceId, hb.bridgeApiHealthy, hb.agentVersion);
        ws.send(JSON.stringify({ type: 'heartbeat_ack', timestamp: new Date().toISOString() }));
      }
      // response/error messages are handled by per-request listeners above
    });

    ws.on('close', () => {
      if (authenticatedDeviceId) unregisterDevice(authenticatedDeviceId);
    });

    ws.on('error', () => {
      if (authenticatedDeviceId) unregisterDevice(authenticatedDeviceId);
    });
  });

  return { fastify, wss };
}
