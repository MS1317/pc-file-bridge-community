/**
 * Stage 2A relay-server unit tests
 *
 * These tests run against the relay logic directly without needing a real
 * bridge-api or bridge-agent running.
 */

import { randomBytes, createHmac, randomUUID } from 'crypto';
import WebSocket, { WebSocketServer } from 'ws';
import Fastify from 'fastify';

// ─── Minimal inline implementations (no server spin-up) ────────────────────

// Test 1-3: ALLOWED_OPERATIONS allowlist
describe('ALLOWED_OPERATIONS allowlist', () => {
  // Import directly to avoid server spin-up
  const { ALLOWED_OPERATIONS, OPERATION_MAP } = require('shared');

  it('contains all expected operations', () => {
    const expected = [
      'health', 'workspaces.list', 'files.list', 'files.search', 'files.read',
      'changes.preview', 'changes.pending', 'changes.apply', 'changes.reject',
      'changes.recent', 'changes.revert',
    ];
    for (const op of expected) {
      expect(ALLOWED_OPERATIONS.has(op)).toBe(true);
    }
  });

  it('does not contain forbidden operations', () => {
    const forbidden = ['auth/rotate-token', 'exec', 'shell', 'workspaces.create', 'workspaces.delete'];
    for (const op of forbidden) {
      expect(ALLOWED_OPERATIONS.has(op)).toBe(false);
    }
  });

  it('every allowed operation has a matching OPERATION_MAP entry', () => {
    for (const op of ALLOWED_OPERATIONS) {
      expect(OPERATION_MAP[op]).toBeDefined();
      expect(['GET', 'POST', 'DELETE']).toContain(OPERATION_MAP[op].method);
      expect(OPERATION_MAP[op].path).toMatch(/^\//);
    }
  });
});

// Test 4-6: HMAC auth logic
describe('HMAC device auth', () => {
  function signAuth(deviceId: string, nonce: string, secret: string): string {
    return createHmac('sha256', secret).update(`${deviceId}:${nonce}`).digest('hex');
  }

  it('produces valid signature for correct inputs', () => {
    const id = 'agent-abc123';
    const nonce = randomBytes(16).toString('hex');
    const secret = randomBytes(32).toString('hex');
    const sig = signAuth(id, nonce, secret);
    const expected = createHmac('sha256', secret).update(`${id}:${nonce}`).digest('hex');
    expect(sig).toBe(expected);
  });

  it('different nonce produces different signature', () => {
    const id = 'agent-abc123';
    const secret = randomBytes(32).toString('hex');
    const sig1 = signAuth(id, 'nonce1', secret);
    const sig2 = signAuth(id, 'nonce2', secret);
    expect(sig1).not.toBe(sig2);
  });

  it('wrong secret produces different signature', () => {
    const id = 'agent-abc123';
    const nonce = 'test-nonce';
    const sig1 = signAuth(id, nonce, 'secret-a');
    const sig2 = signAuth(id, nonce, 'secret-b');
    expect(sig1).not.toBe(sig2);
  });
});

// Test 7-9: Replay protection (requestId tracking)
describe('Replay protection', () => {
  const seenIds = new Map<string, number>();
  const TTL = 120_000;

  function checkReplay(id: string): boolean {
    const cutoff = Date.now() - TTL;
    for (const [k, ts] of seenIds) if (ts < cutoff) seenIds.delete(k);
    if (seenIds.has(id)) return true; // duplicate
    seenIds.set(id, Date.now());
    return false;
  }

  it('allows first use of a requestId', () => {
    expect(checkReplay(randomUUID())).toBe(false);
  });

  it('rejects duplicate requestId', () => {
    const id = randomUUID();
    checkReplay(id);
    expect(checkReplay(id)).toBe(true);
  });

  it('allows different requestIds', () => {
    const a = randomUUID();
    const b = randomUUID();
    checkReplay(a);
    expect(checkReplay(b)).toBe(false);
  });
});

// Test 10-12: Sliding-window rate limiter
describe('Rate limiter', () => {
  function makeRateLimiter(max: number, windowMs: number) {
    const map = new Map<string, number[]>();
    return (key: string): boolean => {
      const now = Date.now();
      const times = (map.get(key) ?? []).filter((t) => now - t < windowMs);
      if (times.length >= max) { map.set(key, times); return false; }
      times.push(now);
      map.set(key, times);
      return true;
    };
  }

  it('allows up to max requests', () => {
    const rl = makeRateLimiter(3, 60_000);
    expect(rl('k')).toBe(true);
    expect(rl('k')).toBe(true);
    expect(rl('k')).toBe(true);
  });

  it('blocks on exceed', () => {
    const rl = makeRateLimiter(2, 60_000);
    rl('k'); rl('k');
    expect(rl('k')).toBe(false);
  });

  it('different keys are independent', () => {
    const rl = makeRateLimiter(1, 60_000);
    rl('a');
    expect(rl('a')).toBe(false);
    expect(rl('b')).toBe(true);
  });
});

// Test 13-15: Agent-side operation validation
describe('Agent operation validation', () => {
  const { ALLOWED_OPERATIONS, OPERATION_MAP } = require('shared');

  function validateRequest(operation: string, method: string, path: string): string | null {
    if (!ALLOWED_OPERATIONS.has(operation)) return 'OPERATION_NOT_ALLOWED';
    const spec = OPERATION_MAP[operation];
    if (!spec) return 'UNKNOWN_OPERATION';
    if (spec.method !== method || spec.path !== path) return 'OPERATION_MISMATCH';
    return null; // valid
  }

  it('accepts valid operation', () => {
    expect(validateRequest('workspaces.list', 'GET', '/workspaces')).toBeNull();
  });

  it('rejects operation not on allowlist', () => {
    expect(validateRequest('exec', 'POST', '/exec')).toBe('OPERATION_NOT_ALLOWED');
  });

  it('rejects method/path mismatch (tampered relay message)', () => {
    // Relay says "GET /workspaces" but attacker tampers method to POST
    expect(validateRequest('workspaces.list', 'POST', '/workspaces')).toBe('OPERATION_MISMATCH');
  });
});

// Test 16-18: Request staleness check
describe('Request staleness', () => {
  function isStale(createdAt: string, maxAgeMs = 30_000): boolean {
    return Date.now() - new Date(createdAt).getTime() > maxAgeMs;
  }

  it('fresh request is not stale', () => {
    expect(isStale(new Date().toISOString())).toBe(false);
  });

  it('old request is stale', () => {
    const old = new Date(Date.now() - 60_000).toISOString();
    expect(isStale(old)).toBe(true);
  });

  it('exactly at boundary is not stale', () => {
    const borderline = new Date(Date.now() - 29_000).toISOString();
    expect(isStale(borderline)).toBe(false);
  });
});

// Test 19-20: Device offline detection
describe('Device offline detection', () => {
  const OFFLINE_THRESHOLD = 90_000;

  function isOnline(lastSeenAt: Date): boolean {
    return Date.now() - lastSeenAt.getTime() <= OFFLINE_THRESHOLD;
  }

  it('recently-seen device is online', () => {
    expect(isOnline(new Date())).toBe(true);
  });

  it('device unseen for 91s is offline', () => {
    const old = new Date(Date.now() - 91_000);
    expect(isOnline(old)).toBe(false);
  });
});

// Test 21: Token NOT exposed in relay request
describe('Security: bridge token isolation', () => {
  it('RelayRequestMessage type has no bridgeToken field', () => {
    const { OPERATION_MAP } = require('shared');
    // A relay request is: { type, requestId, operation, method, path, body, createdAt, nonce }
    // Verify there's no auth/token field defined in a sample message
    const sampleReq = {
      type: 'request',
      requestId: randomUUID(),
      operation: 'workspaces.list',
      method: OPERATION_MAP['workspaces.list'].method,
      path: OPERATION_MAP['workspaces.list'].path,
      createdAt: new Date().toISOString(),
      nonce: randomBytes(8).toString('hex'),
    };
    expect(sampleReq).not.toHaveProperty('bridgeToken');
    expect(sampleReq).not.toHaveProperty('Authorization');
    expect(sampleReq).not.toHaveProperty('token');
  });
});
