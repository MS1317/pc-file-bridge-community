import { randomBytes } from 'crypto';
import { buildRelayServer } from './server.js';

const PORT = Number(process.env.RELAY_PORT ?? 4888);
const RELAY_CLIENT_TOKEN = process.env.RELAY_CLIENT_TOKEN ?? randomBytes(32).toString('hex');

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
  console.log('║         Relay Server  v0.1.0                 ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  HTTP  →  http://127.0.0.1:${PORT}            ║`);
  console.log(`║  WS    →  ws://127.0.0.1:${PORT}/device       ║`);
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Relay client token:                         ║`);
  console.log(`║  ${'[REDACTED]'}  ║`);
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
