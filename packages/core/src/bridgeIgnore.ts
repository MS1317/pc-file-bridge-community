import fs from 'fs';
import path from 'path';

/** Load workspace ignore rules fresh to avoid timestamp-resolution cache races. */
export function loadBridgeIgnore(workspaceRoot: string): string[] {
  const ignoreFile = path.join(workspaceRoot, '.bridgeignore');
  let content: string;
  try {
    content = fs.readFileSync(ignoreFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}
