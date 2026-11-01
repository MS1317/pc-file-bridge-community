import fs from 'fs';
import path from 'path';

// Cache parsed patterns per workspace root, keyed by file mtime so external
// edits are still picked up. Avoids a full readFileSync + parse on every
// read/edit/preview call (each of which loaded .bridgeignore fresh).
const cache = new Map<string, { mtimeMs: number; patterns: string[] }>();

/**
 * Load .bridgeignore from a workspace root.
 * Returns glob patterns, stripping blank lines and comments (# ...).
 * Returns [] if no .bridgeignore file exists.
 */
export function loadBridgeIgnore(workspaceRoot: string): string[] {
  const ignoreFile = path.join(workspaceRoot, '.bridgeignore');

  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(ignoreFile).mtimeMs;
  } catch {
    cache.delete(workspaceRoot);
    return [];
  }

  const hit = cache.get(workspaceRoot);
  if (hit && hit.mtimeMs === mtimeMs) return hit.patterns;

  const patterns = fs
    .readFileSync(ignoreFile, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));

  cache.set(workspaceRoot, { mtimeMs, patterns });
  return patterns;
}
