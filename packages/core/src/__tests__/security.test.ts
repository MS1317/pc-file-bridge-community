import path from 'path';
import os from 'os';
import fs from 'fs';
import { resolveAndGuard, PathGuardError } from '../pathGuard';
import { checkGlobAccess } from '../globFilter';
import { hashContent } from '../fileHash';
import { RateLimiter } from '../rateLimiter';
import { PendingStore } from '../pendingStore';
import { ChangeService } from '../changeService';
import { AuditLog } from '../auditLog';
import { validateToken, rotateToken, loadOrCreateMcpRemoteToken, rotateMcpRemoteToken } from '../authToken';
import { FileService } from '../fileService';
import { loadBridgeIgnore } from '../bridgeIgnore';
import type { Workspace } from '@bridge/shared';

const WORKSPACE_ROOT = path.join(os.tmpdir(), 'bridge-test-workspace');
const DATA_DIR = path.join(os.tmpdir(), 'bridge-test-data');

beforeAll(() => {
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(WORKSPACE_ROOT, 'hello.ts'), 'const x = 1;', 'utf8');
});

afterAll(() => {
  fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const mockWorkspace = {
  allowedGlobs: ['**/*.ts', '**/*.tsx', '**/*.json', '**/*.md'],
  blockedGlobs: ['**/.env', '**/.env.*', '**/*.pem', '**/*.key'],
};

// ─── Path Guard ───────────────────────────────────────────────────────────────

describe('resolveAndGuard', () => {
  it('allows a valid relative path inside workspace', () => {
    const result = resolveAndGuard(WORKSPACE_ROOT, 'hello.ts');
    expect(result).toBe(path.resolve(WORKSPACE_ROOT, 'hello.ts'));
  });

  it('allows nested paths inside workspace', () => {
    const result = resolveAndGuard(WORKSPACE_ROOT, 'src/components/Button.tsx');
    expect(result).toBe(path.resolve(WORKSPACE_ROOT, 'src/components/Button.tsx'));
  });

  it('blocks path traversal with ../', () => {
    expect(() => resolveAndGuard(WORKSPACE_ROOT, '../../etc/passwd')).toThrow(PathGuardError);
  });

  it('blocks path traversal with encoded sequences that still resolve outside', () => {
    expect(() => resolveAndGuard(WORKSPACE_ROOT, '../outside.txt')).toThrow(PathGuardError);
  });

  it('blocks absolute paths', () => {
    expect(() => resolveAndGuard(WORKSPACE_ROOT, '/etc/passwd')).toThrow(PathGuardError);
  });

  it('blocks Windows-style absolute paths', () => {
    expect(() => resolveAndGuard(WORKSPACE_ROOT, 'C:\\Windows\\system32')).toThrow(PathGuardError);
  });
});

// ─── Glob Filter ─────────────────────────────────────────────────────────────

describe('checkGlobAccess', () => {
  it('allows a whitelisted file extension', () => {
    const result = checkGlobAccess('src/index.ts', mockWorkspace);
    expect(result.allowed).toBe(true);
  });

  it('allows a JSON file', () => {
    const result = checkGlobAccess('package.json', mockWorkspace);
    expect(result.allowed).toBe(true);
  });

  it('blocks .env by default rule', () => {
    const result = checkGlobAccess('.env', mockWorkspace);
    expect(result.allowed).toBe(false);
  });

  it('blocks .env.local by default rule', () => {
    const result = checkGlobAccess('.env.local', mockWorkspace);
    expect(result.allowed).toBe(false);
  });

  it('blocks .pem files by workspace rule', () => {
    const result = checkGlobAccess('certs/server.pem', mockWorkspace);
    expect(result.allowed).toBe(false);
  });

  it('blocks .key files by workspace rule', () => {
    const result = checkGlobAccess('certs/private.key', mockWorkspace);
    expect(result.allowed).toBe(false);
  });

  it('blocks node_modules by default rule', () => {
    const result = checkGlobAccess('node_modules/lodash/index.js', mockWorkspace);
    expect(result.allowed).toBe(false);
  });

  it('blocks .git directory by default rule', () => {
    const result = checkGlobAccess('.git/config', mockWorkspace);
    expect(result.allowed).toBe(false);
  });

  it('blocks a .py file not in allowedGlobs', () => {
    const result = checkGlobAccess('script.py', mockWorkspace);
    expect(result.allowed).toBe(false);
  });

  it('blocks sqlite database files by default rule', () => {
    const result = checkGlobAccess('data/local.db', mockWorkspace);
    expect(result.allowed).toBe(false);
  });
});

// ─── Hash ─────────────────────────────────────────────────────────────────────

describe('hashContent', () => {
  it('returns a 64-character hex string', () => {
    const hash = hashContent('hello world');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]+$/);
  });

  it('returns the same hash for the same content', () => {
    expect(hashContent('abc')).toBe(hashContent('abc'));
  });

  it('returns different hashes for different content', () => {
    expect(hashContent('abc')).not.toBe(hashContent('xyz'));
  });
});

// ─── Symlink / path safety (strengthened) ────────────────────────────────────

describe('symlink and path safety', () => {
  const safeDir = path.join(WORKSPACE_ROOT, 'safe-subdir');
  const outsideDir = path.join(os.tmpdir(), 'bridge-test-outside');

  beforeAll(() => {
    fs.mkdirSync(safeDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'secret', 'utf8');
    fs.writeFileSync(path.join(safeDir, 'safe.ts'), 'ok', 'utf8');
  });

  afterAll(() => {
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('allows a new file inside a safe parent directory', () => {
    // safeDir exists and is inside workspace — new file inside it should be fine
    const result = resolveAndGuard(WORKSPACE_ROOT, 'safe-subdir/new-file.ts');
    expect(result).toBe(path.resolve(WORKSPACE_ROOT, 'safe-subdir/new-file.ts'));
  });

  it('blocks a path that traverses outside via double-dot', () => {
    expect(() => resolveAndGuard(WORKSPACE_ROOT, 'safe-subdir/../../etc/passwd'))
      .toThrow(PathGuardError);
  });

  it('blocks a path with a null byte', () => {
    expect(() => resolveAndGuard(WORKSPACE_ROOT, 'safe\0subdir')).toThrow(PathGuardError);
  });

  it('allows reading an existing safe file', () => {
    const result = resolveAndGuard(WORKSPACE_ROOT, 'safe-subdir/safe.ts');
    expect(result).toBe(path.resolve(WORKSPACE_ROOT, 'safe-subdir/safe.ts'));
  });

  // Symlink tests — skip gracefully on platforms where symlink creation requires elevation
  it('blocks a symlink whose target is outside workspace', () => {
    const linkPath = path.join(WORKSPACE_ROOT, 'evil-link');
    try {
      if (fs.existsSync(linkPath)) fs.unlinkSync(linkPath);
      fs.symlinkSync(outsideDir, linkPath, 'junction');
    } catch {
      // Windows may require elevation for symlinks in non-dev mode — skip
      console.warn('Skipping symlink test: insufficient privileges to create symlink');
      return;
    }
    try {
      expect(() => resolveAndGuard(WORKSPACE_ROOT, 'evil-link/secret.txt')).toThrow(PathGuardError);
    } finally {
      try { fs.unlinkSync(linkPath); } catch { /* cleanup */ }
    }
  });
});

// ─── Rate Limiter ─────────────────────────────────────────────────────────────

describe('RateLimiter', () => {
  it('allows requests within limit', () => {
    const rl = new RateLimiter({ maxRequests: 5, windowMs: 60_000 });
    for (let i = 0; i < 5; i++) {
      expect(rl.check('key1')).toBe(true);
    }
  });

  it('blocks the 6th request when limit is 5', () => {
    const rl = new RateLimiter({ maxRequests: 5, windowMs: 60_000 });
    for (let i = 0; i < 5; i++) rl.check('key2');
    expect(rl.check('key2')).toBe(false);
  });

  it('uses separate buckets per key', () => {
    const rl = new RateLimiter({ maxRequests: 2, windowMs: 60_000 });
    rl.check('a'); rl.check('a');
    expect(rl.check('a')).toBe(false);
    expect(rl.check('b')).toBe(true); // different key — still allowed
  });

  it('resets after window expires', () => {
    const rl = new RateLimiter({ maxRequests: 1, windowMs: 1 }); // 1ms window
    rl.check('c');
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(rl.check('c')).toBe(true); // window reset
      resolve();
    }, 10));
  });

  it('retryAfterMs returns positive value when rate-limited', () => {
    const rl = new RateLimiter({ maxRequests: 1, windowMs: 60_000 });
    rl.check('d');
    rl.check('d'); // now limited
    expect(rl.retryAfterMs('d')).toBeGreaterThan(0);
  });
});

// ─── Token rotation ───────────────────────────────────────────────────────────

describe('token rotation', () => {
  it('generates a new token different from the old one', () => {
    const tokenFile = path.join(DATA_DIR, 'auth-token.txt');
    const old = 'aaaa'.repeat(16); // 64 chars
    fs.writeFileSync(tokenFile, old, 'utf8');
    const newTok = rotateToken(DATA_DIR);
    expect(newTok).not.toBe(old);
    expect(newTok).toHaveLength(64);
  });

  it('new token passes validateToken, old token fails', () => {
    const tokenFile = path.join(DATA_DIR, 'auth-token.txt');
    const old = 'bbbb'.repeat(16);
    fs.writeFileSync(tokenFile, old, 'utf8');
    const newTok = rotateToken(DATA_DIR);
    expect(validateToken(newTok, newTok)).toBe(true);
    expect(validateToken(old, newTok)).toBe(false);
  });
});

// ─── MCP token ───────────────────────────────────────────────────────────────

describe('loadOrCreateMcpRemoteToken', () => {
  it('creates mcp-remote-token.txt with 64-char hex token', () => {
    const mcpTokenFile = path.join(DATA_DIR, 'mcp-remote-token.txt');
    if (fs.existsSync(mcpTokenFile)) fs.unlinkSync(mcpTokenFile);
    const token = loadOrCreateMcpRemoteToken(DATA_DIR);
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[a-f0-9]+$/);
    expect(fs.existsSync(mcpTokenFile)).toBe(true);
  });

  it('returns same token on second call (reads from file)', () => {
    const t1 = loadOrCreateMcpRemoteToken(DATA_DIR);
    const t2 = loadOrCreateMcpRemoteToken(DATA_DIR);
    expect(t1).toBe(t2);
  });

  it('mcp-remote-token.txt is separate from auth-token.txt', () => {
    // Bridge API token lives in auth-token.txt; MCP remote token in mcp-remote-token.txt
    const bridgeToken = fs.existsSync(path.join(DATA_DIR, 'auth-token.txt'))
      ? fs.readFileSync(path.join(DATA_DIR, 'auth-token.txt'), 'utf8').trim()
      : null;
    const mcpToken = loadOrCreateMcpRemoteToken(DATA_DIR);
    if (bridgeToken) {
      expect(mcpToken).not.toBe(bridgeToken);
    }
    expect(mcpToken).toHaveLength(64);
  });

  it('rotateMcpRemoteToken generates new token and writes to mcp-remote-token.txt', () => {
    const old = loadOrCreateMcpRemoteToken(DATA_DIR);
    const rotated = rotateMcpRemoteToken(DATA_DIR);
    expect(rotated).not.toBe(old);
    expect(rotated).toHaveLength(64);
    expect(rotated).toMatch(/^[a-f0-9]+$/);
    // File now contains the new token
    const onDisk = fs.readFileSync(path.join(DATA_DIR, 'mcp-remote-token.txt'), 'utf8').trim();
    expect(onDisk).toBe(rotated);
  });

  it('auth-token.txt (bridge API) is unaffected by rotateMcpRemoteToken', () => {
    const bridgeTokenFile = path.join(DATA_DIR, 'auth-token.txt');
    const bridgeTokenBefore = fs.existsSync(bridgeTokenFile)
      ? fs.readFileSync(bridgeTokenFile, 'utf8').trim()
      : null;
    rotateMcpRemoteToken(DATA_DIR);
    const bridgeTokenAfter = fs.existsSync(bridgeTokenFile)
      ? fs.readFileSync(bridgeTokenFile, 'utf8').trim()
      : null;
    // Bridge API token must not have changed
    expect(bridgeTokenAfter).toBe(bridgeTokenBefore);
  });
});

// ─── FileService navigation tools ────────────────────────────────────────────

describe('FileService.listTree', () => {
  const treeRoot = path.join(os.tmpdir(), 'bridge-tree-test');
  const treeWorkspace: Workspace = {
    id: 'tree-ws',
    name: 'Tree Test',
    root: treeRoot,
    allowedGlobs: ['**/*.ts', '**/*.json', '**/*.md'],
    blockedGlobs: [],
    writeMode: 'approval_required',
    createdAt: new Date().toISOString(),
  };

  beforeAll(() => {
    fs.mkdirSync(path.join(treeRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.join(treeRoot, 'node_modules', 'lodash'), { recursive: true });
    fs.mkdirSync(path.join(treeRoot, '.git'), { recursive: true });
    fs.mkdirSync(path.join(treeRoot, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(treeRoot, 'out'), { recursive: true });
    fs.mkdirSync(path.join(treeRoot, 'cache'), { recursive: true });
    fs.mkdirSync(path.join(treeRoot, '.pnpm-store', 'v3', 'files'), { recursive: true });
    fs.mkdirSync(path.join(treeRoot, '.yarn', 'cache'), { recursive: true });
    fs.mkdirSync(path.join(treeRoot, '.yarn', 'releases'), { recursive: true });
    fs.mkdirSync(path.join(treeRoot, '.yarn', 'unplugged', 'lodash'), { recursive: true });
    fs.mkdirSync(path.join(treeRoot, '.npm', '_npx'), { recursive: true });
    fs.mkdirSync(path.join(treeRoot, '.nx', 'cache'), { recursive: true });
    fs.mkdirSync(path.join(treeRoot, '.angular', 'cache'), { recursive: true });
    fs.writeFileSync(path.join(treeRoot, 'src', 'index.ts'), 'export {};', 'utf8');
    fs.writeFileSync(path.join(treeRoot, 'package.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(treeRoot, 'node_modules', 'lodash', 'index.js'), 'module.exports={}', 'utf8');
    fs.writeFileSync(path.join(treeRoot, '.git', 'config'), '[core]', 'utf8');
    fs.writeFileSync(path.join(treeRoot, 'dist', 'bundle.js'), 'compiled', 'utf8');
    fs.writeFileSync(path.join(treeRoot, 'out', 'result.js'), 'compiled', 'utf8');
    fs.writeFileSync(path.join(treeRoot, 'cache', 'data.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(treeRoot, '.pnpm-store', 'v3', 'files', 'pkg.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(treeRoot, '.yarn', 'cache', 'lodash-npm.zip'), '', 'utf8');
    fs.writeFileSync(path.join(treeRoot, '.yarn', 'releases', 'yarn.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(treeRoot, '.yarn', 'unplugged', 'lodash', 'index.ts'), '', 'utf8');
    fs.writeFileSync(path.join(treeRoot, '.npm', '_npx', 'meta.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(treeRoot, '.nx', 'cache', 'hash.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(treeRoot, '.angular', 'cache', 'ng.json'), '{}', 'utf8');
  });

  afterAll(() => {
    fs.rmSync(treeRoot, { recursive: true, force: true });
  });

  it('returns tree with allowed files', () => {
    const svc = new FileService();
    const result = svc.listTree(treeWorkspace);
    const allPaths = collectPaths(result.tree);
    expect(allPaths).toContain(path.join('src', 'index.ts'));
    expect(allPaths).toContain('package.json');
  });

  it('never includes node_modules', () => {
    const svc = new FileService();
    const result = svc.listTree(treeWorkspace);
    const allPaths = collectPaths(result.tree);
    expect(allPaths.some(p => p.includes('node_modules'))).toBe(false);
  });

  it('never includes .git', () => {
    const svc = new FileService();
    const result = svc.listTree(treeWorkspace);
    const allPaths = collectPaths(result.tree);
    expect(allPaths.some(p => p.includes('.git'))).toBe(false);
  });

  it('never includes dist', () => {
    const svc = new FileService();
    const result = svc.listTree(treeWorkspace);
    const allPaths = collectPaths(result.tree);
    expect(allPaths.some(p => p.startsWith('dist'))).toBe(false);
  });

  it('never includes out', () => {
    const svc = new FileService();
    const result = svc.listTree(treeWorkspace);
    const allPaths = collectPaths(result.tree);
    expect(allPaths.some(p => p.startsWith('out'))).toBe(false);
  });

  it('never includes cache', () => {
    const svc = new FileService();
    const result = svc.listTree(treeWorkspace);
    const allPaths = collectPaths(result.tree);
    expect(allPaths.some(p => p.startsWith('cache'))).toBe(false);
  });

  it('never includes .pnpm-store', () => {
    const svc = new FileService();
    const result = svc.listTree(treeWorkspace);
    const allPaths = collectPaths(result.tree);
    expect(allPaths.some(p => p.includes('.pnpm-store'))).toBe(false);
  });

  it('.yarn/cache is hidden (cache subdir in SKIP_DIRS)', () => {
    const svc = new FileService();
    const result = svc.listTree(treeWorkspace);
    const allPaths = collectPaths(result.tree);
    expect(allPaths).not.toContain(path.join('.yarn', 'cache'));
  });

  it('.yarn/releases remains visible (source-controlled Yarn Berry files)', () => {
    const svc = new FileService();
    const result = svc.listTree(treeWorkspace);
    const allPaths = collectPaths(result.tree);
    // releases/yarn.json matches **/*.json allowedGlobs and is not in DEFAULT_BLOCKED_GLOBS
    expect(allPaths).toContain(path.join('.yarn', 'releases', 'yarn.json'));
  });

  it('.yarn itself is visible (source-controlled Yarn Berry dir)', () => {
    const svc = new FileService();
    const result = svc.listTree(treeWorkspace);
    const allPaths = collectPaths(result.tree);
    expect(allPaths).toContain('.yarn');
  });

  it('.yarn/unplugged directory node is hidden (isDirPathBlocked matches **/.yarn/unplugged/**)', () => {
    const svc = new FileService();
    const result = svc.listTree(treeWorkspace);
    const allPaths = collectPaths(result.tree);
    // Entire dir node excluded — no path contains "unplugged"
    expect(allPaths.some(p => p.includes('unplugged'))).toBe(false);
  });

  it('never includes .npm', () => {
    const svc = new FileService();
    const result = svc.listTree(treeWorkspace);
    const allPaths = collectPaths(result.tree);
    expect(allPaths.some(p => p.includes('.npm'))).toBe(false);
  });

  it('.nx/cache is hidden (cache subdir in SKIP_DIRS)', () => {
    const svc = new FileService();
    const result = svc.listTree(treeWorkspace);
    const allPaths = collectPaths(result.tree);
    expect(allPaths).not.toContain(path.join('.nx', 'cache'));
  });

  it('.angular/cache is hidden (cache subdir in SKIP_DIRS)', () => {
    const svc = new FileService();
    const result = svc.listTree(treeWorkspace);
    const allPaths = collectPaths(result.tree);
    expect(allPaths).not.toContain(path.join('.angular', 'cache'));
  });

  it('respects maxDepth=1 — no nested entries', () => {
    const svc = new FileService();
    const result = svc.listTree(treeWorkspace, '', 1);
    const allPaths = collectPaths(result.tree);
    // src/index.ts is depth 1; at maxDepth=1 dirs appear but their children do not
    expect(allPaths).not.toContain(path.join('src', 'index.ts'));
  });

  it('truncates when limit exceeded', () => {
    const svc = new FileService();
    const result = svc.listTree(treeWorkspace, '', 10, 1);
    expect(result.truncated).toBe(true);
    expect(result.totalNodes).toBe(1);
  });

  it('rejects path traversal in relativePath', () => {
    const svc = new FileService();
    expect(() => svc.listTree(treeWorkspace, '../../etc')).toThrow();
  });
});

function collectPaths(entries: import('@bridge/shared').TreeEntry[]): string[] {
  const result: string[] = [];
  for (const e of entries) {
    result.push(e.relativePath);
    if (e.children) result.push(...collectPaths(e.children));
  }
  return result;
}

describe('FileService.readFileRange', () => {
  const rangeRoot = path.join(os.tmpdir(), 'bridge-range-test');
  const rangeWorkspace: Workspace = {
    id: 'range-ws',
    name: 'Range Test',
    root: rangeRoot,
    allowedGlobs: ['**/*.ts'],
    blockedGlobs: [],
    writeMode: 'approval_required',
    createdAt: new Date().toISOString(),
  };

  beforeAll(() => {
    fs.mkdirSync(rangeRoot, { recursive: true });
    fs.writeFileSync(
      path.join(rangeRoot, 'multi.ts'),
      'line1\nline2\nline3\nline4\nline5',
      'utf8'
    );
  });

  afterAll(() => {
    fs.rmSync(rangeRoot, { recursive: true, force: true });
  });

  it('returns correct line range with line numbers', () => {
    const svc = new FileService();
    const result = svc.readFileRange(rangeWorkspace, 'multi.ts', 2, 4);
    expect(result.startLine).toBe(2);
    expect(result.endLine).toBe(4);
    expect(result.lines).toHaveLength(3);
    expect(result.lines[0]).toEqual({ lineNumber: 2, content: 'line2' });
    expect(result.lines[2]).toEqual({ lineNumber: 4, content: 'line4' });
  });

  it('reports correct totalLines', () => {
    const svc = new FileService();
    const result = svc.readFileRange(rangeWorkspace, 'multi.ts', 1, 2);
    expect(result.totalLines).toBe(5);
  });

  it('clamps endLine to file length', () => {
    const svc = new FileService();
    const result = svc.readFileRange(rangeWorkspace, 'multi.ts', 4, 999);
    expect(result.endLine).toBe(5);
    expect(result.lines).toHaveLength(2);
  });

  it('throws when startLine > endLine after clamping', () => {
    const svc = new FileService();
    expect(() => svc.readFileRange(rangeWorkspace, 'multi.ts', 10, 10)).toThrow();
  });

  it('blocks path traversal', () => {
    const svc = new FileService();
    expect(() => svc.readFileRange(rangeWorkspace, '../secret.ts', 1, 5)).toThrow();
  });

  it('blocks files not in allowedGlobs', () => {
    const svc = new FileService();
    fs.writeFileSync(path.join(rangeRoot, 'script.py'), 'print("hi")', 'utf8');
    expect(() => svc.readFileRange(rangeWorkspace, 'script.py', 1, 1)).toThrow(/Access denied/);
  });
});

describe('FileService.findFile', () => {
  const findRoot = path.join(os.tmpdir(), 'bridge-find-test');
  const findWorkspace: Workspace = {
    id: 'find-ws',
    name: 'Find Test',
    root: findRoot,
    allowedGlobs: ['**/*.ts', '**/*.json'],
    blockedGlobs: [],
    writeMode: 'approval_required',
    createdAt: new Date().toISOString(),
  };

  beforeAll(() => {
    fs.mkdirSync(path.join(findRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(findRoot, 'src', 'authService.ts'), '', 'utf8');
    fs.writeFileSync(path.join(findRoot, 'src', 'userController.ts'), '', 'utf8');
    fs.writeFileSync(path.join(findRoot, 'package.json'), '{}', 'utf8');
  });

  afterAll(() => {
    fs.rmSync(findRoot, { recursive: true, force: true });
  });

  it('finds file by partial name match', () => {
    const svc = new FileService();
    const result = svc.findFile(findWorkspace, 'auth');
    expect(result.matches.map(m => m.relativePath)).toContain(path.join('src', 'authService.ts'));
  });

  it('is case-insensitive', () => {
    const svc = new FileService();
    const result = svc.findFile(findWorkspace, 'AUTH');
    expect(result.matches.map(m => m.relativePath)).toContain(path.join('src', 'authService.ts'));
  });

  it('does not return files not in allowedGlobs', () => {
    const svc = new FileService();
    fs.writeFileSync(path.join(findRoot, 'src', 'secret.py'), '', 'utf8');
    const result = svc.findFile(findWorkspace, 'secret');
    expect(result.matches.map(m => m.relativePath)).not.toContain(path.join('src', 'secret.py'));
  });

  it('respects limit', () => {
    const svc = new FileService();
    const result = svc.findFile(findWorkspace, '', 1);
    expect(result.matches.length).toBeLessThanOrEqual(1);
  });
});

describe('FileService.repoOverview', () => {
  const overviewRoot = path.join(os.tmpdir(), 'bridge-overview-test');
  const overviewWorkspace: Workspace = {
    id: 'overview-ws',
    name: 'Overview Test',
    root: overviewRoot,
    allowedGlobs: ['**/*.ts', '**/*.json'],
    blockedGlobs: [],
    writeMode: 'approval_required',
    createdAt: new Date().toISOString(),
  };

  beforeAll(() => {
    fs.mkdirSync(path.join(overviewRoot, 'apps', 'web'), { recursive: true });
    fs.mkdirSync(path.join(overviewRoot, 'apps', 'api'), { recursive: true });
    fs.mkdirSync(path.join(overviewRoot, 'packages', 'core'), { recursive: true });
    fs.writeFileSync(
      path.join(overviewRoot, 'package.json'),
      JSON.stringify({ scripts: { dev: 'turbo dev', build: 'turbo build' } }),
      'utf8'
    );
    fs.writeFileSync(path.join(overviewRoot, 'pnpm-lock.yaml'), '', 'utf8');
  });

  afterAll(() => {
    fs.rmSync(overviewRoot, { recursive: true, force: true });
  });

  it('detects pnpm as package manager', () => {
    const svc = new FileService();
    const result = svc.repoOverview(overviewWorkspace);
    expect(result.packageManager).toBe('pnpm');
  });

  it('lists apps subdirectories', () => {
    const svc = new FileService();
    const result = svc.repoOverview(overviewWorkspace);
    expect(result.apps).toContain('web');
    expect(result.apps).toContain('api');
  });

  it('lists packages subdirectories', () => {
    const svc = new FileService();
    const result = svc.repoOverview(overviewWorkspace);
    expect(result.packages).toContain('core');
  });

  it('reads scripts from package.json', () => {
    const svc = new FileService();
    const result = svc.repoOverview(overviewWorkspace);
    expect(result.scripts).toEqual({ dev: 'turbo dev', build: 'turbo build' });
  });

  it('includes package.json in rootFiles', () => {
    const svc = new FileService();
    const result = svc.repoOverview(overviewWorkspace);
    expect(result.rootFiles).toContain('package.json');
  });
});

// ─── .bridgeignore ───────────────────────────────────────────────────────────

describe('loadBridgeIgnore', () => {
  const biRoot = path.join(os.tmpdir(), 'bridge-bi-parse-test');

  beforeAll(() => {
    fs.mkdirSync(biRoot, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(biRoot, { recursive: true, force: true });
  });

  it('returns [] when no .bridgeignore exists', () => {
    const noIgnoreDir = path.join(biRoot, 'empty');
    fs.mkdirSync(noIgnoreDir, { recursive: true });
    expect(loadBridgeIgnore(noIgnoreDir)).toEqual([]);
  });

  it('parses patterns correctly', () => {
    fs.writeFileSync(path.join(biRoot, '.bridgeignore'), 'build-output\ndist/**\n', 'utf8');
    expect(loadBridgeIgnore(biRoot)).toEqual(['build-output', 'dist/**']);
  });

  it('strips comments starting with #', () => {
    fs.writeFileSync(path.join(biRoot, '.bridgeignore'), '# comment\nbuild-output\n# another comment\n', 'utf8');
    expect(loadBridgeIgnore(biRoot)).toEqual(['build-output']);
  });

  it('strips blank lines', () => {
    fs.writeFileSync(path.join(biRoot, '.bridgeignore'), '\nbuild-output\n\ndist/**\n\n', 'utf8');
    expect(loadBridgeIgnore(biRoot)).toEqual(['build-output', 'dist/**']);
  });

  it('handles inline # not treated as comment (only leading #)', () => {
    fs.writeFileSync(path.join(biRoot, '.bridgeignore'), 'pattern-with-#hash\n', 'utf8');
    expect(loadBridgeIgnore(biRoot)).toEqual(['pattern-with-#hash']);
  });
});

describe('FileService with .bridgeignore', () => {
  const biWorkRoot = path.join(os.tmpdir(), 'bridge-bi-svc-test');
  const biWorkspace: Workspace = {
    id: 'bi-ws',
    name: 'BridgeIgnore Test',
    root: biWorkRoot,
    allowedGlobs: ['**/*.ts', '**/*.json'],
    blockedGlobs: [],
    writeMode: 'approval_required',
    createdAt: new Date().toISOString(),
  };

  beforeAll(() => {
    fs.mkdirSync(path.join(biWorkRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.join(biWorkRoot, 'graphify-out'), { recursive: true });
    fs.mkdirSync(path.join(biWorkRoot, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(biWorkRoot, 'src', 'index.ts'), 'export {};', 'utf8');
    fs.writeFileSync(path.join(biWorkRoot, 'src', 'secret.ts'), 'secret', 'utf8');
    fs.writeFileSync(path.join(biWorkRoot, 'package.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(biWorkRoot, 'graphify-out', 'result.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(biWorkRoot, 'reports', 'summary.ts'), 'data', 'utf8');
    // .bridgeignore: ignore project-specific output dirs and one file
    fs.writeFileSync(
      path.join(biWorkRoot, '.bridgeignore'),
      [
        '# Project-specific ignores',
        'graphify-out/**',
        'reports/**',
        'src/secret.ts',
        '',
        '# blank line above is ok',
      ].join('\n'),
      'utf8'
    );
  });

  afterAll(() => {
    fs.rmSync(biWorkRoot, { recursive: true, force: true });
  });

  it('ignored directory does not appear in list_tree', () => {
    const svc = new FileService();
    const result = svc.listTree(biWorkspace);
    const allPaths = collectPaths(result.tree);
    expect(allPaths.some(p => p.includes('graphify-out'))).toBe(false);
    expect(allPaths.some(p => p.includes('reports'))).toBe(false);
  });

  it('ignored file does not appear in listFiles', () => {
    const svc = new FileService();
    const files = svc.listFiles(biWorkspace);
    const paths = files.map(f => f.relativePath.replace(/\\/g, '/'));
    expect(paths).not.toContain('src/secret.ts');
    expect(paths.some(p => p.includes('graphify-out'))).toBe(false);
  });

  it('ignored file does not appear in findFile', () => {
    const svc = new FileService();
    const result = svc.findFile(biWorkspace, 'secret');
    expect(result.matches.map(m => m.relativePath.replace(/\\/g, '/'))).not.toContain('src/secret.ts');
  });

  it('ignored file does not appear in searchFiles results', () => {
    const svc = new FileService();
    const matches = svc.searchFiles(biWorkspace, 'secret');
    expect(matches.map(m => m.relativePath.replace(/\\/g, '/'))).not.toContain('src/secret.ts');
  });

  it('read_file rejects ignored file with clear error', () => {
    const svc = new FileService();
    expect(() => svc.readFile(biWorkspace, 'src/secret.ts')).toThrow(/Access denied.*\.bridgeignore/);
  });

  it('read_file_range rejects ignored file with clear error', () => {
    const svc = new FileService();
    expect(() => svc.readFileRange(biWorkspace, 'src/secret.ts', 1, 1)).toThrow(/Access denied.*\.bridgeignore/);
  });

  it('allowed file still readable when .bridgeignore exists', () => {
    const svc = new FileService();
    expect(() => svc.readFile(biWorkspace, 'src/index.ts')).not.toThrow();
  });

  it('built-in SKIP_DIRS still block node_modules even with .bridgeignore present', () => {
    const svc = new FileService();
    const result = svc.listTree(biWorkspace);
    const allPaths = collectPaths(result.tree);
    expect(allPaths.some(p => p.includes('node_modules'))).toBe(false);
  });

  it('.venv is skipped by built-in generic skip (no .bridgeignore needed)', () => {
    const venvDir = path.join(biWorkRoot, '.venv');
    fs.mkdirSync(venvDir, { recursive: true });
    fs.writeFileSync(path.join(venvDir, 'activate.ts'), '', 'utf8');
    const svc = new FileService();
    const result = svc.listTree(biWorkspace);
    const allPaths = collectPaths(result.tree);
    expect(allPaths.some(p => p.includes('.venv'))).toBe(false);
    fs.rmSync(venvDir, { recursive: true, force: true });
  });

  it('__pycache__ is skipped by built-in generic skip', () => {
    const pycDir = path.join(biWorkRoot, 'src', '__pycache__');
    fs.mkdirSync(pycDir, { recursive: true });
    fs.writeFileSync(path.join(pycDir, 'module.ts'), '', 'utf8');
    const svc = new FileService();
    const result = svc.listTree(biWorkspace);
    const allPaths = collectPaths(result.tree);
    expect(allPaths.some(p => p.includes('__pycache__'))).toBe(false);
    fs.rmSync(pycDir, { recursive: true, force: true });
  });
});

// ─── Pending Store ────────────────────────────────────────────────────────────

describe('PendingStore', () => {
  const makeInput = () => ({
    workspaceId: 'ws1',
    relativePath: 'src/index.ts',
    baseHash: 'abc123',
    newHash: 'def456',
    diff: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new',
    warnings: [],
  });

  it('creates a pending change with status pending', () => {
    const store = new PendingStore();
    const p = store.create(makeInput(), 'new content');
    expect(p.status).toBe('pending');
    expect(p.pendingChangeId).toBeTruthy();
  });

  it('stores and retrieves content separately', () => {
    const store = new PendingStore();
    const p = store.create(makeInput(), 'my new content');
    expect(store.getContent(p.pendingChangeId)).toBe('my new content');
  });

  it('returns null for unknown id', () => {
    const store = new PendingStore();
    expect(store.get('nonexistent')).toBeNull();
  });

  it('sets status to rejected and removes content', () => {
    const store = new PendingStore();
    const p = store.create(makeInput(), 'content');
    store.setStatus(p.pendingChangeId, 'rejected');
    expect(store.get(p.pendingChangeId)?.status).toBe('rejected');
    expect(store.getContent(p.pendingChangeId)).toBeNull();
  });

  it('sets status to applied and removes content', () => {
    const store = new PendingStore();
    const p = store.create(makeInput(), 'content');
    store.setStatus(p.pendingChangeId, 'applied');
    expect(store.get(p.pendingChangeId)?.status).toBe('applied');
    expect(store.getContent(p.pendingChangeId)).toBeNull();
  });

  it('marks entry as expired when TTL passes', () => {
    const store = new PendingStore();
    const p = store.create(makeInput(), 'content');
    // Backdating by manipulating the stored entry
    const entry = (store as any).store.get(p.pendingChangeId);
    const past = new Date(Date.now() - 1000).toISOString();
    (store as any).store.set(p.pendingChangeId, { ...entry, expiresAt: past });
    expect(store.get(p.pendingChangeId)?.status).toBe('expired');
  });
});

// ─── ChangeService targeted edits ────────────────────────────────────────────

describe('ChangeService targeted edits', () => {
  const editRoot = path.join(os.tmpdir(), 'bridge-edit-test');
  const editDataDir = path.join(os.tmpdir(), 'bridge-edit-data');
  const editWorkspace: Workspace = {
    id: 'edit-ws',
    name: 'Edit Workspace',
    root: editRoot,
    allowedGlobs: ['**/*.ts', '**/*.json'],
    blockedGlobs: [],
    writeMode: 'approval_required',
    createdAt: new Date().toISOString(),
  };
  let svc: ChangeService;
  const samplePath = path.join('src', 'sample.ts');
  const ORIGINAL = 'line 1\nline 2\nline 3\nline 4\nline 5';

  beforeAll(() => {
    fs.mkdirSync(path.join(editRoot, 'src'), { recursive: true });
    fs.mkdirSync(editDataDir, { recursive: true });
    fs.writeFileSync(path.join(editRoot, samplePath), ORIGINAL, 'utf8');
    svc = new ChangeService(editDataDir, new AuditLog(editDataDir), new PendingStore());
  });

  afterAll(() => {
    fs.rmSync(editRoot, { recursive: true, force: true });
    fs.rmSync(editDataDir, { recursive: true, force: true });
  });

  afterEach(() => {
    // Restore the file after each write test
    fs.writeFileSync(path.join(editRoot, samplePath), ORIGINAL, 'utf8');
  });

  it('previewReplaceRange creates pending but does not modify file', () => {
    const result = svc.previewReplaceRange(editWorkspace, {
      workspaceId: 'edit-ws', relativePath: samplePath, startLine: 2, endLine: 3, newContent: 'replaced',
    });
    expect(result.pendingChangeId).toBeDefined();
    expect(result.diff).toContain('replaced');
    expect(fs.readFileSync(path.join(editRoot, samplePath), 'utf8')).toBe(ORIGINAL);
  });

  it('previewInsertBefore creates pending but does not modify file', () => {
    const result = svc.previewInsertBefore(editWorkspace, {
      workspaceId: 'edit-ws', relativePath: samplePath, line: 2, content: 'inserted before',
    });
    expect(result.pendingChangeId).toBeDefined();
    expect(result.diff).toContain('inserted before');
    expect(fs.readFileSync(path.join(editRoot, samplePath), 'utf8')).toBe(ORIGINAL);
  });

  it('previewInsertAfter creates pending but does not modify file', () => {
    const result = svc.previewInsertAfter(editWorkspace, {
      workspaceId: 'edit-ws', relativePath: samplePath, line: 2, content: 'inserted after',
    });
    expect(result.pendingChangeId).toBeDefined();
    expect(result.diff).toContain('inserted after');
    expect(fs.readFileSync(path.join(editRoot, samplePath), 'utf8')).toBe(ORIGINAL);
  });

  it('apply_pending_change applies previewReplaceRange result', () => {
    const preview = svc.previewReplaceRange(editWorkspace, {
      workspaceId: 'edit-ws', relativePath: samplePath, startLine: 1, endLine: 1, newContent: 'REPLACED FIRST',
    });
    const applied = svc.applyPending(editWorkspace, preview.pendingChangeId);
    expect(applied.success).toBe(true);
    const newContent = fs.readFileSync(path.join(editRoot, samplePath), 'utf8');
    expect(newContent.split('\n')[0]).toBe('REPLACED FIRST');
  });

  it('previewInsertAfter result is applied correctly', () => {
    const preview = svc.previewInsertAfter(editWorkspace, {
      workspaceId: 'edit-ws', relativePath: samplePath, line: 2, content: 'AFTER LINE 2',
    });
    svc.applyPending(editWorkspace, preview.pendingChangeId);
    const lines = fs.readFileSync(path.join(editRoot, samplePath), 'utf8').split('\n');
    expect(lines[2]).toBe('AFTER LINE 2');
  });

  it('rejects startLine > endLine', () => {
    expect(() =>
      svc.previewReplaceRange(editWorkspace, {
        workspaceId: 'edit-ws', relativePath: samplePath, startLine: 4, endLine: 2, newContent: 'x',
      })
    ).toThrow(/invalid/i);
  });

  it('rejects line out of bounds for insertBefore', () => {
    expect(() =>
      svc.previewInsertBefore(editWorkspace, {
        workspaceId: 'edit-ws', relativePath: samplePath, line: 999, content: 'x',
      })
    ).toThrow(/out of range/i);
  });

  it('rejects path traversal', () => {
    expect(() =>
      svc.previewReplaceRange(editWorkspace, {
        workspaceId: 'edit-ws', relativePath: '../../etc/passwd', startLine: 1, endLine: 1, newContent: 'x',
      })
    ).toThrow();
  });

  it('rejects file blocked by .bridgeignore', () => {
    fs.writeFileSync(path.join(editRoot, '.bridgeignore'), 'src/secret.ts', 'utf8');
    fs.writeFileSync(path.join(editRoot, 'src', 'secret.ts'), 'secret\nline 2', 'utf8');
    try {
      expect(() =>
        svc.previewReplaceRange(editWorkspace, {
          workspaceId: 'edit-ws', relativePath: path.join('src', 'secret.ts'), startLine: 1, endLine: 1, newContent: 'x',
        })
      ).toThrow(/Access denied/);
    } finally {
      fs.rmSync(path.join(editRoot, '.bridgeignore'), { force: true });
      fs.rmSync(path.join(editRoot, 'src', 'secret.ts'), { force: true });
    }
  });

  it('applyImmediate previews + applies in one call', () => {
    const applied = svc.applyImmediate(editWorkspace, {
      workspaceId: 'edit-ws', relativePath: samplePath, newContent: 'ATOMIC WRITE',
    });
    expect(applied.success).toBe(true);
    expect(applied.backupId).toBeTruthy();
    expect(fs.readFileSync(path.join(editRoot, samplePath), 'utf8')).toBe('ATOMIC WRITE');
  });

  it('applyImmediate rejects a stale baseHash without writing', () => {
    expect(() =>
      svc.applyImmediate(editWorkspace, {
        workspaceId: 'edit-ws', relativePath: samplePath, newContent: 'SHOULD NOT LAND', baseHash: 'deadbeef',
      })
    ).toThrow(/Hash mismatch/);
    expect(fs.readFileSync(path.join(editRoot, samplePath), 'utf8')).toBe(ORIGINAL);
  });

  it('applyImmediate enforces glob access', () => {
    expect(() =>
      svc.applyImmediate(editWorkspace, {
        workspaceId: 'edit-ws', relativePath: '../../etc/passwd', newContent: 'x',
      })
    ).toThrow();
  });
});
