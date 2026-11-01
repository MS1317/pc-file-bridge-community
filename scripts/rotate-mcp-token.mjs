/**
 * Rotate the MCP remote token.
 * Generates a new token, writes it to data/mcp-remote-token.txt, and prints it.
 *
 * Do this only if the token is compromised.
 * After rotating, update Authorization: Bearer <token> in your ChatGPT MCP config.
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
console.warn('ACTION REQUIRED: Update your ChatGPT MCP configuration with the new token.');
console.warn('The old token is now invalid. ChatGPT will fail to connect until you update it.');
console.log('');
console.log('In your ChatGPT MCP config, change Authorization to:');
console.log(`  Authorization: Bearer ${newToken}`);
console.log('');
console.log('The internal bridge API token (data/auth-token.txt) was NOT changed.');
console.log('');
