import { join } from 'path';
import { loadOrCreateCredentials } from './credentials.js';
import { BridgeAgent } from './agent.js';

const DATA_DIR = process.env.AGENT_DATA_DIR ?? join(process.cwd(), 'data', 'agent');
const RELAY_URL = process.env.RELAY_URL ?? 'ws://127.0.0.1:4888/device';
const BRIDGE_URL = process.env.BRIDGE_URL ?? 'http://127.0.0.1:4777';
const BRIDGE_TOKEN_ENV = process.env.BRIDGE_TOKEN;

if (!BRIDGE_TOKEN_ENV) {
  console.error('[agent] BRIDGE_TOKEN environment variable is required.');
  console.error('        Set it to the value from data/auth-token.txt in the bridge-api.');
  process.exit(1);
}

const creds = loadOrCreateCredentials(DATA_DIR);

console.log('');
console.log('╔══════════════════════════════════════════════╗');
console.log('║         Bridge Agent  v0.1.0                 ║');
console.log('╠══════════════════════════════════════════════╣');
console.log(`║  Relay  →  ${RELAY_URL.padEnd(33)}║`);
console.log(`║  Bridge →  ${BRIDGE_URL.padEnd(33)}║`);
console.log(`║  Device →  ${creds.deviceId.padEnd(33)}║`);
console.log('╚══════════════════════════════════════════════╝');
console.log('');
console.log('  To register this device with the relay, set these');
console.log('  env vars when starting the relay-server:');
console.log(`    AGENT_DEVICE_ID=${creds.deviceId}`);
console.log(`    AGENT_DEVICE_SECRET=<from ${DATA_DIR}/device-credentials.json>`);
console.log('');

const agent = new BridgeAgent(RELAY_URL, creds, BRIDGE_URL, BRIDGE_TOKEN_ENV);
agent.start();

process.on('SIGINT', () => {
  console.log('\n[agent] Shutting down…');
  agent.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  agent.stop();
  process.exit(0);
});
