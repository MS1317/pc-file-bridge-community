import fs from 'fs';
import path from 'path';
import { loadOrCreateMcpRemoteToken } from '@bridge/core';
import { createBridgeApiClient } from './bridgeApiClient';
import { buildServer } from './server';

const DATA_DIR = path.resolve(__dirname, '../../../data');
const HOST = process.env.MCP_HOST ?? '127.0.0.1';
const PORT = Number(process.env.MCP_PORT ?? 4779);
const BRIDGE_API_URL = process.env.BRIDGE_API_URL ?? 'http://127.0.0.1:4777';

const LOCALHOST_VALUES = new Set(['127.0.0.1', 'localhost', '::1']);

function isLocalhost(host: string): boolean {
  return LOCALHOST_VALUES.has(host.toLowerCase());
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const isExposed = !isLocalhost(HOST);
  if (isExposed && process.env.MCP_ENABLE_WRITES === 'true' && process.env.MCP_ALLOW_REMOTE_WRITES !== 'true') {
    throw new Error('Refusing remote writes without MCP_ALLOW_REMOTE_WRITES=true');
  }

  // Load or generate MCP remote token (ChatGPT-facing; separate from internal bridge API token)
  const mcpToken = process.env.MCP_REMOTE_TOKEN?.trim() || loadOrCreateMcpRemoteToken(DATA_DIR);

  // ── Startup safety guard ────────────────────────────────────────────────────
  if (HOST === '0.0.0.0' || isExposed) {
    console.warn('');
    console.warn('================================================================');
    console.warn('  WARNING: MCP server bound to non-localhost interface!');
    console.warn(`  MCP_HOST=${HOST} — ensure your tunnel is properly secured.`);
    console.warn('================================================================');

    if (!mcpToken) {
      console.error('FATAL: MCP exposed but MCP auth token could not be loaded. Refusing to start.');
      process.exit(1);
    }
  }

  const mcpTokenRef = { value: mcpToken };

  const bridgeApi = createBridgeApiClient({
    dataDir: DATA_DIR,
    baseUrl: BRIDGE_API_URL,
  });

  const app = await buildServer({ bridgeApi, mcpTokenRef });
  await app.listen({ port: PORT, host: HOST });

  const tokenSource = process.env.MCP_REMOTE_TOKEN ? 'MCP_REMOTE_TOKEN env var' : 'data/mcp-remote-token.txt';

  console.log('');
  console.log('==============================================');
  console.log(' ChatGPT PC File Bridge MCP v0.1.0');
  console.log('==============================================');
  console.log(` MCP endpoint : http://${HOST}:${PORT}/mcp`);
  console.log(` Health       : http://${HOST}:${PORT}/health`);
  console.log(` Bridge API   : ${BRIDGE_API_URL}`);
  console.log(` MCP auth     : loaded from ${tokenSource}`);
  console.log(` MCP tools    : read / search / preview / apply / terminal enabled`);
  console.log('==============================================');
  console.log('');
}

main().catch((error) => {
  console.error('Failed to start MCP server:', error);
  process.exit(1);
});
