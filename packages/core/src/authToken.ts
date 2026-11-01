import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const TOKEN_FILE = 'auth-token.txt';
const MCP_REMOTE_TOKEN_FILE = 'mcp-remote-token.txt';

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function loadOrCreateToken(dataDir: string): string {
  const tokenPath = path.join(dataDir, TOKEN_FILE);
  if (fs.existsSync(tokenPath)) {
    return fs.readFileSync(tokenPath, 'utf8').trim();
  }
  const token = generateToken();
  fs.writeFileSync(tokenPath, token, { encoding: 'utf8', mode: 0o600 });
  return token;
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
  const tokenPath = path.join(dataDir, MCP_REMOTE_TOKEN_FILE);
  if (fs.existsSync(tokenPath)) {
    return fs.readFileSync(tokenPath, 'utf8').trim();
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenPath, token, { encoding: 'utf8', mode: 0o600 });
  return token;
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
