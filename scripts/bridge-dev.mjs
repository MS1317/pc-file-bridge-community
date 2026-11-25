/**
 * Start the bridge (API + dashboard + MCP server).
 *   pnpm bridge:start
 */
import { spawnPnpm } from './pnpm.mjs';

const LINE = '='.repeat(52);

console.log('');
console.log(LINE);
console.log('  PC File Bridge');
console.log('  Dashboard: http://127.0.0.1:4778');
console.log('  Writes and terminal: Dashboard > Access Control');
console.log(LINE);
console.log('');

const child = spawnPnpm(['dev:mcp']);

child.on('error', (err) => {
  console.error('[ERROR] Failed to start bridge:', err.message);
  process.exit(1);
});

child.on('exit', (code) => process.exit(code ?? 0));
