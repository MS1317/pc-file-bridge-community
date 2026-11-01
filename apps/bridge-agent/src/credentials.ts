import { randomBytes } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export interface DeviceCredentials {
  deviceId: string;
  deviceSecret: string;
}

export function loadOrCreateCredentials(dataDir: string): DeviceCredentials {
  mkdirSync(dataDir, { recursive: true });
  const credPath = join(dataDir, 'device-credentials.json');

  if (existsSync(credPath)) {
    try {
      const raw = JSON.parse(readFileSync(credPath, 'utf8'));
      if (typeof raw.deviceId === 'string' && typeof raw.deviceSecret === 'string') {
        return raw as DeviceCredentials;
      }
    } catch {
      // fall through to regenerate
    }
  }

  const creds: DeviceCredentials = {
    deviceId: `agent-${randomBytes(8).toString('hex')}`,
    deviceSecret: randomBytes(32).toString('hex'),
  };
  writeFileSync(credPath, JSON.stringify(creds, null, 2), 'utf8');
  console.log(`[agent] Generated new device credentials → ${credPath}`);
  return creds;
}
