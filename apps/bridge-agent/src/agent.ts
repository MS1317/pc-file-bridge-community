import { createHmac, randomBytes } from 'crypto';
import { request as httpRequest } from 'http';
import WebSocket from 'ws';
import {
  ALLOWED_OPERATIONS,
  OPERATION_MAP,
  type WsMessage,
  type AuthOkMessage,
  type AuthFailMessage,
  type RelayRequestMessage,
  type HeartbeatAckMessage,
} from 'shared';
import type { DeviceCredentials } from './credentials.js';

const AGENT_VERSION = '0.1.0';
const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_BACKOFF_MS = 30_000;
const REQUEST_TIMEOUT_MS = 18_000;

// Replay protection: track recently-seen requestIds for 2 minutes
const seenRequestIds = new Map<string, number>();
const REQUEST_ID_TTL_MS = 120_000;

function pruneRequestIds() {
  const cutoff = Date.now() - REQUEST_ID_TTL_MS;
  for (const [id, ts] of seenRequestIds) {
    if (ts < cutoff) seenRequestIds.delete(id);
  }
}

function signAuth(deviceId: string, nonce: string, secret: string): string {
  return createHmac('sha256', secret).update(`${deviceId}:${nonce}`).digest('hex');
}

async function checkBridgeHealth(bridgeUrl: string, bridgeToken: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const url = new URL('/health', bridgeUrl);
      const req = httpRequest(
        { hostname: url.hostname, port: Number(url.port), path: url.pathname, method: 'GET',
          headers: { Authorization: `Bearer ${bridgeToken}` }, timeout: 3000 },
        (res) => resolve(res.statusCode === 200),
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    } catch {
      resolve(false);
    }
  });
}

async function forwardToBridge(
  bridgeUrl: string,
  bridgeToken: string,
  method: string,
  path: string,
  body: unknown,
): Promise<{ statusCode: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body != null ? JSON.stringify(body) : null;
    const url = new URL(path, bridgeUrl);
    const options = {
      hostname: url.hostname,
      port: Number(url.port),
      path: url.pathname + url.search,
      method,
      headers: {
        Authorization: `Bearer ${bridgeToken}`,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload).toString() } : {}),
      },
      timeout: REQUEST_TIMEOUT_MS,
    };

    const req = httpRequest(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ statusCode: res.statusCode ?? 500, body: JSON.parse(text) });
        } catch {
          resolve({ statusCode: res.statusCode ?? 500, body: {} });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Bridge request timed out')); });

    if (payload) req.write(payload);
    req.end();
  });
}

export class BridgeAgent {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private stopping = false;
  private sessionId: string | null = null;

  constructor(
    private relayUrl: string,
    private creds: DeviceCredentials,
    private bridgeUrl: string,
    private bridgeToken: string,
  ) {}

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopping = true;
    this.clearHeartbeat();
    this.ws?.close();
  }

  private connect(): void {
    if (this.stopping) return;

    const ws = new WebSocket(this.relayUrl);
    this.ws = ws;

    ws.on('open', () => {
      console.log('[agent] Connected to relay, authenticating…');
      const nonce = randomBytes(16).toString('hex');
      const timestamp = new Date().toISOString();
      const signature = signAuth(this.creds.deviceId, nonce, this.creds.deviceSecret);
      ws.send(JSON.stringify({
        type: 'auth',
        deviceId: this.creds.deviceId,
        signature,
        nonce,
        timestamp,
        agentVersion: AGENT_VERSION,
      }));
    });

    ws.on('message', (raw: Buffer) => {
      let msg: WsMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        console.warn('[agent] Received unparseable message');
        return;
      }
      this.handleMessage(msg, ws);
    });

    ws.on('close', () => {
      this.clearHeartbeat();
      this.sessionId = null;
      if (!this.stopping) {
        const delay = Math.min(1000 * 2 ** this.reconnectAttempt, MAX_BACKOFF_MS);
        this.reconnectAttempt++;
        console.log(`[agent] Disconnected. Reconnecting in ${delay}ms…`);
        setTimeout(() => this.connect(), delay);
      }
    });

    ws.on('error', (err) => {
      console.error('[agent] WebSocket error:', err.message);
    });
  }

  private handleMessage(msg: WsMessage, ws: WebSocket): void {
    switch (msg.type) {
      case 'auth_ok': {
        const ok = msg as AuthOkMessage;
        this.sessionId = ok.sessionId;
        this.reconnectAttempt = 0;
        console.log(`[agent] Authenticated. Session: ${ok.sessionId}`);
        this.startHeartbeat(ws);
        break;
      }

      case 'auth_fail': {
        const fail = msg as AuthFailMessage;
        console.error(`[agent] Auth failed: ${fail.reason}`);
        this.stopping = true;
        ws.close();
        break;
      }

      case 'heartbeat_ack': {
        const ack = msg as HeartbeatAckMessage;
        console.log(`[agent] Heartbeat ack at ${ack.timestamp}`);
        break;
      }

      case 'request': {
        const req = msg as RelayRequestMessage;
        void this.handleRequest(req, ws);
        break;
      }

      default:
        break;
    }
  }

  private async handleRequest(req: RelayRequestMessage, ws: WebSocket): Promise<void> {
    pruneRequestIds();

    // Replay protection
    if (seenRequestIds.has(req.requestId)) {
      ws.send(JSON.stringify({
        type: 'error',
        requestId: req.requestId,
        code: 'REPLAY_DETECTED',
        message: 'Duplicate requestId rejected',
      }));
      return;
    }

    // Allowlist check (defence in depth — relay already checks, but agent verifies too)
    if (!ALLOWED_OPERATIONS.has(req.operation)) {
      ws.send(JSON.stringify({
        type: 'error',
        requestId: req.requestId,
        code: 'OPERATION_NOT_ALLOWED',
        message: `Operation '${req.operation}' is not allowed`,
      }));
      return;
    }

    // Validate that op spec matches what relay sent
    const opSpec = OPERATION_MAP[req.operation];
    if (!opSpec || opSpec.method !== req.method || opSpec.path !== req.path) {
      ws.send(JSON.stringify({
        type: 'error',
        requestId: req.requestId,
        code: 'OPERATION_MISMATCH',
        message: 'Operation spec mismatch between relay and agent',
      }));
      return;
    }

    // Staleness check
    const age = Date.now() - new Date(req.createdAt).getTime();
    if (age > 30_000) {
      ws.send(JSON.stringify({
        type: 'error',
        requestId: req.requestId,
        code: 'REQUEST_EXPIRED',
        message: 'Request too old',
      }));
      return;
    }

    seenRequestIds.set(req.requestId, Date.now());

    try {
      const result = await forwardToBridge(
        this.bridgeUrl,
        this.bridgeToken,
        req.method,
        req.path,
        req.body,
      );
      ws.send(JSON.stringify({
        type: 'response',
        requestId: req.requestId,
        statusCode: result.statusCode,
        body: result.body,
      }));
    } catch (err) {
      ws.send(JSON.stringify({
        type: 'error',
        requestId: req.requestId,
        code: 'BRIDGE_ERROR',
        message: err instanceof Error ? err.message : 'Unknown error forwarding to bridge',
      }));
    }
  }

  private startHeartbeat(ws: WebSocket): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(async () => {
      const bridgeApiHealthy = await checkBridgeHealth(this.bridgeUrl, this.bridgeToken);
      ws.send(JSON.stringify({
        type: 'heartbeat',
        deviceId: this.creds.deviceId,
        timestamp: new Date().toISOString(),
        bridgeApiHealthy,
        agentVersion: AGENT_VERSION,
      }));
    }, HEARTBEAT_INTERVAL_MS);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
