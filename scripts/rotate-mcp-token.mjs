/**
 * Rotate the MCP remote token.
 * Generates a new token, writes it to data/mcp-remote-token.txt, and prints it.
 *
 * Do this only if the token is compromised.
 * After rotating, restart the MCP server and update the token in every MCP client.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(repoRoot, 'data');
const tokenPath = path.join(dataDir, 'mcp-remote-token.txt');

fs.mkdirSync(dataDir, { recursive: true });

const newToken = crypto.randomBytes(32).toString('hex');
fs.writeFileSync(tokenPath, newToken, { encoding: 'utf8', mode: 0o600 });

console.log('');
console.log('MCP remote token rotated.');
console.log('');
console.log('New token:');
console.log('');
console.log(newToken);
console.log('');
console.warn('ACTION REQUIRED: Restart the MCP server, then update the token in every MCP client.');
console.warn('The running MCP server keeps accepting the old token until it restarts.');
console.log('');
console.log('Header for clients that support one:');
console.log(`  Authorization: Bearer ${newToken}`);
console.log('');
console.log('The internal bridge API token (data/auth-token.txt) was NOT changed.');
console.log('');
