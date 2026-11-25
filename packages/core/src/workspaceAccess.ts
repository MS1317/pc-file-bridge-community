import fs from 'fs';
import path from 'path';
import type { Workspace } from '@bridge/shared';
import { loadBridgeIgnore } from './bridgeIgnore';
import { checkGlobAccess } from './globFilter';
import { resolveAndGuard } from './pathGuard';

/** Resolves links, short names and on-disk casing for the part of the path that exists. */
export function canonicalPath(target: string): string {
  const resolved = path.resolve(target);
  const missing: string[] = [];
  let current = resolved;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...missing);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * The only way file tools should turn a requested path into an absolute one.
 * Rules are checked against the requested path and against the file it really
 * names, so an alias (link, short name, different casing) cannot dodge a rule.
 */
export function resolveWorkspacePath(workspace: Workspace, relativePath: string): string {
  const ignorePatterns = loadBridgeIgnore(workspace.root);
  const assertAllowed = (candidate: string) => {
    const check = checkGlobAccess(candidate, workspace, ignorePatterns);
    if (!check.allowed) throw new Error(`Access denied: ${check.reason}`);
  };

  assertAllowed(relativePath);
  const absolutePath = resolveAndGuard(workspace.root, relativePath);
  assertAllowed(path.relative(canonicalPath(workspace.root), canonicalPath(absolutePath)));
  return absolutePath;
}
