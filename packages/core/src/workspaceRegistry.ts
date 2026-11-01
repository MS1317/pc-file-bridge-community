import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import type { Workspace, WorkspaceInput, WorkspacePolicyUpdate } from '@bridge/shared';
import { DEFAULT_BLOCKED_GLOBS } from './globFilter';

const DEFAULT_ALLOWED_GLOBS = [
  '**/*.ts',
  '**/*.tsx',
  '**/*.js',
  '**/*.jsx',
  '**/*.mjs',
  '**/*.cjs',
  '**/*.css',
  '**/*.scss',
  '**/*.html',
  '**/*.json',
  '**/*.md',
  '**/*.mdx',
  '**/*.yaml',
  '**/*.yml',
  '**/*.toml',
  '**/*.txt',
  '**/*.svg',
  '**/*.xlsx',
];

export class WorkspaceRegistry {
  private registryPath: string;
  // Cache parsed workspaces, keyed by file mtime so a hand-edit of
  // workspaces.json is still picked up. Every API request used to re-read and
  // re-parse this file; now it only re-reads when the file actually changes.
  private cache: Workspace[] | null = null;
  private cacheMtimeMs = 0;

  constructor(dataDir: string) {
    this.registryPath = path.join(dataDir, 'workspaces.json');
    this.ensureFile();
  }

  private ensureFile(): void {
    if (!fs.existsSync(this.registryPath)) {
      fs.writeFileSync(this.registryPath, JSON.stringify([], null, 2), 'utf8');
    }
  }

  list(): Workspace[] {
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(this.registryPath).mtimeMs;
    } catch {
      /* fall through to read, which will surface the real error */
    }
    if (this.cache && mtimeMs === this.cacheMtimeMs) return this.cache;

    const raw = fs.readFileSync(this.registryPath, 'utf8');
    this.cache = JSON.parse(raw) as Workspace[];
    this.cacheMtimeMs = mtimeMs;
    return this.cache;
  }

  get(id: string): Workspace | null {
    return this.list().find((w) => w.id === id) ?? null;
  }

  add(input: WorkspaceInput): Workspace {
    const workspaces = this.list();

    // Validate root exists
    if (!fs.existsSync(input.root)) {
      throw new Error(`Workspace root does not exist: ${input.root}`);
    }

    const stat = fs.statSync(input.root);
    if (!stat.isDirectory()) {
      throw new Error(`Workspace root is not a directory: ${input.root}`);
    }

    const normalized = path.resolve(input.root);

    // Prevent duplicate roots
    if (workspaces.some((w) => path.resolve(w.root) === normalized)) {
      throw new Error(`A workspace with root "${normalized}" already exists`);
    }

    const workspace: Workspace = {
      id: nanoid(8),
      name: input.name,
      root: normalized,
      allowedGlobs: input.allowedGlobs ?? DEFAULT_ALLOWED_GLOBS,
      blockedGlobs: input.blockedGlobs ?? DEFAULT_BLOCKED_GLOBS,
      writeMode: input.writeMode ?? 'approval_required',
      createdAt: new Date().toISOString(),
    };

    workspaces.push(workspace);
    this.save(workspaces);
    return workspace;
  }

  remove(id: string): boolean {
    const workspaces = this.list();
    const idx = workspaces.findIndex((w) => w.id === id);
    if (idx === -1) return false;
    workspaces.splice(idx, 1);
    this.save(workspaces);
    return true;
  }

  /**
   * Replaces only a registered workspace's explicit glob policy. The workspace
   * root and identity remain immutable, so this cannot expand access to a
   * different directory. Default blocked rules are enforced separately by
   * checkGlobAccess and cannot be removed through this method.
   */
  updatePolicy(id: string, update: WorkspacePolicyUpdate): Workspace | null {
    const workspaces = this.list();
    const idx = workspaces.findIndex((workspace) => workspace.id === id);
    if (idx === -1) return null;

    const allowedGlobs = normalizeGlobPatterns(update.allowedGlobs, 'allowedGlobs');
    const blockedGlobs = normalizeGlobPatterns(update.blockedGlobs, 'blockedGlobs');
    const workspace = { ...workspaces[idx], allowedGlobs, blockedGlobs };
    workspaces[idx] = workspace;
    this.save(workspaces);
    return workspace;
  }

  private save(workspaces: Workspace[]): void {
    fs.writeFileSync(this.registryPath, JSON.stringify(workspaces, null, 2), 'utf8');
    // Invalidate — next list() re-reads with the fresh mtime. Guards against
    // coarse mtime resolution making a rapid write+read return stale data.
    this.cache = null;
    this.cacheMtimeMs = 0;
  }
}

function normalizeGlobPatterns(patterns: string[], field: string): string[] {
  if (!Array.isArray(patterns)) throw new Error(`${field} must be an array of glob patterns`);

  const normalized = patterns.map((pattern) => {
    if (typeof pattern !== 'string') throw new Error(`${field} must contain only strings`);
    const trimmed = pattern.trim();
    if (!trimmed) throw new Error(`${field} cannot contain empty glob patterns`);
    return trimmed;
  });

  return [...new Set(normalized)];
}
