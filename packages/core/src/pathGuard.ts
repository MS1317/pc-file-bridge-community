import path from 'path';
import fs from 'fs';

export class PathGuardError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = 'PathGuardError';
  }
}

function isInsideRoot(candidate: string, realRoot: string): boolean {
  const sep = path.sep;
  const rootWithSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  return candidate === realRoot || candidate.startsWith(rootWithSep);
}

/**
 * Walk every existing ancestor of `targetPath` from the workspace root down,
 * resolving each segment with realpathSync. If any resolved segment escapes
 * the workspace (via a symlink), throws PathGuardError.
 *
 * For segments that do not exist yet (new files), we stop checking at the
 * deepest existing ancestor — this covers the parent-directory case.
 */
function checkAncestorSymlinks(normalizedRoot: string, targetPath: string): void {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(normalizedRoot);
  } catch {
    return; // workspace root itself doesn't exist — caller should have caught this
  }

  // Build list of path segments from root down to target
  const relative = path.relative(normalizedRoot, targetPath);
  const parts = relative.split(path.sep).filter(Boolean);

  let current = normalizedRoot;
  for (const part of parts) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) break; // nothing left to check for non-existent paths

    let realCurrent: string;
    try {
      realCurrent = fs.realpathSync(current);
    } catch {
      break;
    }

    if (!isInsideRoot(realCurrent, realRoot)) {
      throw new PathGuardError(
        `Symlink escapes workspace at "${path.relative(normalizedRoot, current)}" → "${realCurrent}"`,
        'SYMLINK_ESCAPE'
      );
    }
  }
}

/**
 * Resolves and validates that a relative path stays within the workspace root.
 * Defends against:
 *  - path traversal (../../..)
 *  - absolute paths
 *  - symlinks at any path segment that point outside the workspace
 *  - new files whose parent directory is a symlink escaping the workspace
 */
export function resolveAndGuard(workspaceRoot: string, relativePath: string): string {
  // Reject absolute paths immediately (covers both POSIX /etc and Windows C:\)
  if (path.isAbsolute(relativePath)) {
    throw new PathGuardError(
      `Absolute paths are not allowed: ${relativePath}`,
      'ABSOLUTE_PATH'
    );
  }

  // Reject null bytes (defense in depth)
  if (relativePath.includes('\0')) {
    throw new PathGuardError('Null byte in path', 'NULL_BYTE');
  }

  const normalizedRoot = path.resolve(workspaceRoot);
  const resolved = path.resolve(normalizedRoot, relativePath);

  // Ensure the resolved path is strictly inside the workspace root
  if (!isInsideRoot(resolved, normalizedRoot)) {
    throw new PathGuardError(
      `Path traversal detected: "${relativePath}" resolves outside workspace`,
      'PATH_TRAVERSAL'
    );
  }

  // Walk existing ancestors checking for symlink escapes
  checkAncestorSymlinks(normalizedRoot, resolved);

  return resolved;
}

/** Converts an absolute path back to a relative path from workspace root. */
export function toRelative(workspaceRoot: string, absolutePath: string): string {
  return path.relative(path.resolve(workspaceRoot), absolutePath);
}
