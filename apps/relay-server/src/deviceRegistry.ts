import { randomUUID } from 'crypto';
import type WebSocket from 'ws';
import type { DeviceStatus } from 'shared';

const OFFLINE_THRESHOLD_MS = 90_000;

export interface DeviceEntry {
  deviceId: string;
  sessionId: string;
  ws: WebSocket;
  lastSeenAt: Date;
  bridgeApiHealthy: boolean | null;
  agentVersion: string | null;
}

const devices = new Map<string, DeviceEntry>();

export function registerDevice(deviceId: string, ws: WebSocket, agentVersion: string): string {
  const sessionId = randomUUID();
  devices.set(deviceId, {
    deviceId,
    sessionId,
    ws,
    lastSeenAt: new Date(),
    bridgeApiHealthy: null,
    agentVersion,
  });
  return sessionId;
}

export function unregisterDevice(deviceId: string): void {
  devices.delete(deviceId);
}

export function touchDevice(
  deviceId: string,
  bridgeApiHealthy: boolean,
  agentVersion: string,
): void {
  const entry = devices.get(deviceId);
  if (entry) {
    entry.lastSeenAt = new Date();
    entry.bridgeApiHealthy = bridgeApiHealthy;
    entry.agentVersion = agentVersion;
  }
}

export function getDevice(deviceId: string): DeviceEntry | null {
  const entry = devices.get(deviceId);
  if (!entry) return null;
  if (Date.now() - entry.lastSeenAt.getTime() > OFFLINE_THRESHOLD_MS) return null;
  return entry;
}

export function listDevices(): DeviceStatus[] {
  return Array.from(devices.values()).map((e) => ({
    deviceId: e.deviceId,
    connected: Date.now() - e.lastSeenAt.getTime() <= OFFLINE_THRESHOLD_MS,
    lastSeenAt: e.lastSeenAt.toISOString(),
    sessionId: e.sessionId,
    bridgeApiHealthy: e.bridgeApiHealthy,
    agentVersion: e.agentVersion,
  }));
}

export function findDeviceBySessionId(sessionId: string): DeviceEntry | null {
  for (const entry of devices.values()) {
    if (entry.sessionId === sessionId) return entry;
  }
  return null;
}
