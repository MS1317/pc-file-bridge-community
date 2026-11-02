import path from 'path';
import { buildServer } from './server';
import { loadOrCreateToken } from '@bridge/core';

const DATA_DIR = path.resolve(__dirname, '../../../data');
const PORT = 4777;
const HOST = '127.0.0.1';

async function main() {
  const initialToken = loadOrCreateToken(DATA_DIR);
  // Mutable ref — token rotation updates this without restarting the server
  const tokenRef = { value: initialToken };

  const app = await buildServer({ dataDir: DATA_DIR, tokenRef });
  await app.listen({ port: PORT, host: HOST });

  console.log('');
  console.log('╔════════════════════════════════════════════╗');
  console.log('║     PC File Bridge API v0.2        ║');
  console.log('╠════════════════════════════════════════════╣');
  console.log(`║  Listening on  http://${HOST}:${PORT}       ║`);
  console.log(`║  Dashboard     http://127.0.0.1:4778       ║`);
  console.log('╠════════════════════════════════════════════╣');
  console.log('║  Token saved to: data/auth-token.txt       ║');
  console.log('║  Paste it in the dashboard on first run.   ║');
  console.log('╚════════════════════════════════════════════╝');
  console.log('');
}

main().catch((err) => {
  console.error('Failed to start bridge API:', err);
  process.exit(1);
});
