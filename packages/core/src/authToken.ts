import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const TOKEN_FILE = 'auth-token.txt';
const MCP_REMOTE_TOKEN_FILE = 'mcp-remote-token.txt';

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Reads a secret from the data directory, creating both on first run. The API
 * and MCP server start together, so exclusive create decides which of them
 * writes the file and the other one reads that value.
 */
export function loadOrCreateSecret(dataDir: string, fileName: string): string {
  const secretPath = path.join(dataDir, fileName);
  fs.mkdirSync(dataDir, { recursive: true });
  try {
    const secret = generateToken();
    fs.writeFileSync(secretPath, secret, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return secret;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const secret = fs.readFileSync(secretPath, 'utf8').trim();
    if (secret) return secret;
    // The other process has created the file but not written it yet.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  throw new Error(`${secretPath} is empty. Delete it and start the bridge again.`);
}

export function loadOrCreateToken(dataDir: string): string {
  return loadOrCreateSecret(dataDir, TOKEN_FILE);
}

/**
 * Rotate the token: generate a new one, write it, return it.
 * The caller is responsible for updating in-memory state so the old token
 * is immediately rejected.
 */
export function rotateToken(dataDir: string): string {
  const tokenPath = path.join(dataDir, TOKEN_FILE);
  const newToken = generateToken();
  fs.writeFileSync(tokenPath, newToken, { encoding: 'utf8', mode: 0o600 });
  return newToken;
}

export function loadOrCreateMcpRemoteToken(dataDir: string): string {
  return loadOrCreateSecret(dataDir, MCP_REMOTE_TOKEN_FILE);
}

export function rotateMcpRemoteToken(dataDir: string): string {
  const tokenPath = path.join(dataDir, MCP_REMOTE_TOKEN_FILE);
  const newToken = generateToken();
  fs.writeFileSync(tokenPath, newToken, { encoding: 'utf8', mode: 0o600 });
  return newToken;
}

export function validateToken(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  try {
    // Buffers must be same length for timingSafeEqual; pad if not
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
