/**
 * Print the MCP remote token (for MCP client configuration).
 * Generates and saves to data/mcp-remote-token.txt on first run.
 * Does NOT rotate the token.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(repoRoot, 'data');
const tokenPath = path.join(dataDir, 'mcp-remote-token.txt');

fs.mkdirSync(dataDir, { recursive: true });

if (!fs.existsSync(tokenPath)) {
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenPath, token, { encoding: 'utf8', mode: 0o600 });
  console.log('Generated new MCP remote token (first run).');
}

const token = fs.readFileSync(tokenPath, 'utf8').trim();

console.log('');
console.log('MCP Remote Token (paste into MCP client MCP configuration):');
console.log('');
console.log(token);
console.log('');
console.log('Use this as the Authorization header value:');
console.log(`  Authorization: Bearer ${token}`);
console.log('');
console.log('Stored in: data/mcp-remote-token.txt');
console.log('To rotate: pnpm token:mcp:rotate  (only if the token is compromised)');
console.log('');
