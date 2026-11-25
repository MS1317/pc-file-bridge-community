import { randomBytes } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { buildRelayServer } from './server';

const PORT = Number(process.env.RELAY_PORT ?? 4888);
const DATA_DIR = resolve(__dirname, '../../../data');
const TOKEN_PATH = join(DATA_DIR, 'relay-client-token.txt');

function loadOrCreateClientToken(): string {
  mkdirSync(DATA_DIR, { recursive: true });
  try {
    writeFileSync(TOKEN_PATH, randomBytes(32).toString('hex'), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return readFileSync(TOKEN_PATH, 'utf8').trim();
}

const RELAY_CLIENT_TOKEN = process.env.RELAY_CLIENT_TOKEN?.trim() || loadOrCreateClientToken();

// In Stage 2A simulation, the bridge-agent will present its device credentials.
// For local testing, seed one device from environment variables.
const deviceSecrets = new Map<string, string>();
const AGENT_DEVICE_ID = process.env.AGENT_DEVICE_ID;
const AGENT_DEVICE_SECRET = process.env.AGENT_DEVICE_SECRET;
if (AGENT_DEVICE_ID && AGENT_DEVICE_SECRET) {
  deviceSecrets.set(AGENT_DEVICE_ID, AGENT_DEVICE_SECRET);
}

async function main() {
  const { fastify, wss: _wss } = await buildRelayServer({ relayClientToken: RELAY_CLIENT_TOKEN, deviceSecrets, port: PORT });

  await fastify.listen({ port: PORT, host: '127.0.0.1' });

  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║         Relay Server  v0.2.0                 ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  HTTP  →  http://127.0.0.1:${PORT}            ║`);
  console.log(`║  WS    →  ws://127.0.0.1:${PORT}/device       ║`);
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Relay client token:                         ║`);
  console.log(`║  ${process.env.RELAY_CLIENT_TOKEN ? 'from RELAY_CLIENT_TOKEN' : 'saved in data/relay-client-token.txt'}`.padEnd(47) + '║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');

  if (!AGENT_DEVICE_ID || !AGENT_DEVICE_SECRET) {
    console.log('⚠  No AGENT_DEVICE_ID / AGENT_DEVICE_SECRET set.');
    console.log('   Run: pnpm agent  (it will auto-register its credentials)');
    console.log('');
  }
}

main().catch((err) => {
  console.error('Relay server failed to start:', err);
  process.exit(1);
});
