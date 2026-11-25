import micromatch from 'micromatch';
import type { Workspace } from '@bridge/shared';

// Default blocked patterns applied to every workspace regardless of config
export const DEFAULT_BLOCKED_GLOBS: string[] = [
  // Secrets and credentials
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/.ssh/**',
  '**/id_rsa',
  '**/id_ed25519',
  '**/*.credentials',
  '**/.aws/**',
  '**/credentials',
  '**/secrets/**',
  // Databases
  '**/*.sqlite',
  '**/*.db',
  '**/*.sqlite3',
  // Generic build/dependency/tool output directories
  '**/.git/**',
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/out/**',
  '**/cache/**',
  '**/.cache/**',
  '**/.venv/**',
  '**/venv/**',
  '**/__pycache__/**',
  '**/.turbo/**',
  '**/.parcel-cache/**',
  // Package-manager store and cache directories
  '**/.pnpm-store/**',
  '**/.yarn/cache/**',
  '**/.yarn/unplugged/**',
  '**/.yarn/install-state.gz',
  '**/.npm/**',
  '**/.bun-install-cache/**',
  '**/.nx/cache/**',
  '**/.angular/cache/**',
];

// Compiled-matcher cache. micromatch.isMatch(str, patterns) rebuilds the regex
// for every pattern on every call (~55x slower in tight loops like directory
// walks). We compile each pattern to a RegExp once and OR them — behaviourally
// identical to isMatch(..., { dot: true }), including `!` negation which makeRe
// encodes as a negative-lookahead regex.
// ponytail: unbounded Map, but keyed by pattern-list which is tiny in practice
// (defaults + a handful of workspace/.bridgeignore lists). Add an LRU only if
// workspace count ever explodes.
const matcherCache = new Map<string, (input: string) => boolean>();

function getMatcher(patterns: string[], nocase: boolean): (input: string) => boolean {
  const key = (nocase ? 'i\n' : 's\n') + patterns.join('\n');
  let fn = matcherCache.get(key);
  if (!fn) {
    const regexes = patterns
      .map((p) => micromatch.makeRe(p, { dot: true, nocase }))
      .filter((re): re is RegExp => re instanceof RegExp);
    fn = (input: string) => regexes.some((re) => re.test(input));
    matcherCache.set(key, fn);
  }
  return fn;
}

/** Fast equivalent of micromatch.isMatch(input, patterns, { dot: true }). */
export function matchesAny(input: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  return getMatcher(patterns, false)(input.replace(/\\/g, '/'));
}

/**
 * Like matchesAny, for deny rules. Case-insensitive because `SECRETS/x` and
 * `secrets/x` are the same file on Windows and macOS.
 */
export function matchesAnyBlocked(input: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  return getMatcher(patterns, true)(input.replace(/\\/g, '/'));
}

/** `.bridgeignore` entries may name a directory, which excludes everything below it. */
export function matchesBridgeIgnore(input: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  const contents = patterns.filter((p) => !p.startsWith('!')).map((p) => `${p.replace(/\/+$/, '')}/**`);
  return matchesAnyBlocked(input, patterns) || matchesAnyBlocked(input, contents);
}

export type FilterResult =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Checks whether a relative path is accessible under the given workspace rules.
 * Returns allowed:true or allowed:false with a human-readable reason.
 *
 * @param bridgeIgnorePatterns - Patterns loaded from .bridgeignore (applied after defaults)
 */
export function checkGlobAccess(
  relativePath: string,
  workspace: Pick<Workspace, 'allowedGlobs' | 'blockedGlobs'>,
  bridgeIgnorePatterns: string[] = []
): FilterResult {
  // Normalize to forward slashes for consistent glob matching
  const normalized = relativePath.replace(/\\/g, '/');

  // Default security rules are always applied first and cannot be overridden
  if (matchesAnyBlocked(normalized, DEFAULT_BLOCKED_GLOBS)) {
    return { allowed: false, reason: 'Blocked by default security rules' };
  }

  // .bridgeignore patterns (workspace-local, loaded from disk)
  if (matchesBridgeIgnore(normalized, bridgeIgnorePatterns)) {
    return { allowed: false, reason: 'Blocked by .bridgeignore' };
  }

  // Workspace blockedGlobs (configured at workspace registration time)
  if (matchesAnyBlocked(normalized, workspace.blockedGlobs)) {
    return { allowed: false, reason: 'Blocked by workspace blockedGlobs' };
  }

  // Workspace allowedGlobs whitelist (if configured, file must match)
  if (workspace.allowedGlobs.length > 0) {
    if (!matchesAny(normalized, workspace.allowedGlobs)) {
      return { allowed: false, reason: 'Not matched by workspace allowedGlobs' };
    }
  }

  return { allowed: true };
}
