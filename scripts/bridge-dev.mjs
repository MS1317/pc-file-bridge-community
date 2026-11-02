/**
 * Start the bridge (API + dashboard + MCP server).
 *   node bridge-dev.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const LINE = '='.repeat(52);

console.log('');
console.log(LINE);
console.log('  PC File Bridge');
console.log('  MCP tools: read / search / preview / apply enabled');
console.log(LINE);
console.log('');

const child = spawn('corepack', ['pnpm', 'dev:mcp'], {
  stdio: 'inherit',
  shell: true,
  cwd: repoRoot,
});

child.on('error', (err) => {
  console.error('[ERROR] Failed to start bridge:', err.message);
  process.exit(1);
});

child.on('exit', (code) => process.exit(code ?? 0));
