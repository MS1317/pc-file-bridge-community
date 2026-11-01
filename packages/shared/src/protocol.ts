// ─── Wire protocol between relay-server and bridge-agent ─────────────────────
// All messages travel over the WebSocket at ws://relay/device

export type WsMessageType =
  | 'auth'
  | 'auth_ok'
  | 'auth_fail'
  | 'heartbeat'
  | 'heartbeat_ack'
  | 'request'
  | 'response'
  | 'error';

// Sent by agent immediately after WebSocket open
export interface AuthMessage {
  type: 'auth';
  deviceId: string;
  /** HMAC-SHA256(deviceId + ":" + nonce, deviceSecret) */
  signature: string;
  nonce: string;
  timestamp: string;
  agentVersion: string;
}

export interface AuthOkMessage {
  type: 'auth_ok';
  sessionId: string;
}

export interface AuthFailMessage {
  type: 'auth_fail';
  reason: string;
}

// Agent → relay every 15 seconds
export interface HeartbeatMessage {
  type: 'heartbeat';
  deviceId: string;
  timestamp: string;
  bridgeApiHealthy: boolean;
  agentVersion: string;
}

export interface HeartbeatAckMessage {
  type: 'heartbeat_ack';
  timestamp: string;
}

// Relay → agent: forwarded GPT request
export interface RelayRequestMessage {
  type: 'request';
  requestId: string;
  /** Dot-notation operation name for allowlist check */
  operation: string;
  method: 'GET' | 'POST' | 'DELETE';
  /** Path on the local bridge API e.g. "/workspaces" */
  path: string;
  body?: unknown;
  createdAt: string;
  /** Random bytes for replay protection */
  nonce: string;
}

// Agent → relay: response to a forwarded request
export interface RelayResponseMessage {
  type: 'response';
  requestId: string;
  statusCode: number;
  body: unknown;
}

export interface RelayErrorMessage {
  type: 'error';
  requestId?: string;
  code: string;
  message: string;
}

export type WsMessage =
  | AuthMessage
  | AuthOkMessage
  | AuthFailMessage
  | HeartbeatMessage
  | HeartbeatAckMessage
  | RelayRequestMessage
  | RelayResponseMessage
  | RelayErrorMessage;

// ─── Device info returned by GET /devices ────────────────────────────────────

export interface DeviceStatus {
  deviceId: string;
  connected: boolean;
  lastSeenAt: string | null;
  sessionId: string | null;
  bridgeApiHealthy: boolean | null;
  agentVersion: string | null;
}

// ─── Allowed operations (agent-side allowlist) ────────────────────────────────

export const ALLOWED_OPERATIONS = new Set<string>([
  'health',
  'workspaces.list',
  'files.list',
  'files.search',
  'files.read',
  'changes.preview',
  'changes.pending',
  'changes.apply',
  'changes.reject',
  'changes.recent',
  'changes.revert',
]);

// Mapping: operation → { method, path }
export const OPERATION_MAP: Record<string, { method: 'GET' | 'POST' | 'DELETE'; path: string }> = {
  'health':           { method: 'GET',  path: '/health' },
  'workspaces.list':  { method: 'GET',  path: '/workspaces' },
  'files.list':       { method: 'POST', path: '/files/list' },
  'files.search':     { method: 'POST', path: '/files/search' },
  'files.read':       { method: 'POST', path: '/files/read' },
  'changes.preview':  { method: 'POST', path: '/changes/preview' },
  'changes.pending':  { method: 'GET',  path: '/changes/pending' },
  'changes.apply':    { method: 'POST', path: '/changes/apply' },
  'changes.reject':   { method: 'POST', path: '/changes/reject' },
  'changes.recent':   { method: 'GET',  path: '/changes/recent' },
  'changes.revert':   { method: 'POST', path: '/changes/revert' },
};
