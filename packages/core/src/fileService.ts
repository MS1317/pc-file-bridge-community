import fs from 'fs';
import path from 'path';
import type {
  Workspace,
  FileEntry,
  FileContent,
  SearchMatch,
  TreeEntry,
  TreeResult,
  FileRangeContent,
  FindFileResult,
  RepoOverview,
} from '@bridge/shared';
import { resolveAndGuard, toRelative } from './pathGuard';
import { checkGlobAccess, DEFAULT_BLOCKED_GLOBS, matchesAny } from './globFilter';
import { hashContent } from './fileHash';
import { loadBridgeIgnore } from './bridgeIgnore';
import { isSpreadsheetPath } from '@bridge/shared';

const MAX_FILE_SIZE = 1 * 1024 * 1024; // 1 MB
const MAX_SEARCH_RESULTS = 200;

// Generic build/tool/dependency directories always skipped during traversal.
// Add project-specific dirs via .bridgeignore in the workspace root instead.
const SKIP_DIRS = new Set([
  // Version control and dependencies
  'node_modules', '.git',
  // Build output
  'dist', 'build', '.next', '.nuxt', 'coverage', 'out',
  // Caches
  'cache', '.cache', '.parcel-cache', '.turbo',
  // Python
  '.venv', 'venv', '__pycache__',
  // Package-manager stores (entire dir is non-source)
  '.pnpm-store', '.npm', '.bun-install-cache',
  // .yarn, .nx, .angular are NOT fully skipped — only their cache subdirs are
  // blocked via DEFAULT_BLOCKED_GLOBS so source-controlled files remain visible
  // (e.g. .yarn/releases, .yarn/plugins, .yarn/patches, .nx/migrations.json)
]);

export class FileService {
  // Single stat that doubles as the existence check (readFileSync throws ENOENT
  // anyway, so a separate existsSync was a redundant syscall).
  private statFile(absPath: string, relativePath: string): fs.Stats {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch {
      throw new Error(`File not found: ${relativePath}`);
    }
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${relativePath}`);
    }
    return stat;
  }

  listFiles(workspace: Workspace): FileEntry[] {
    const ignorePatterns = loadBridgeIgnore(workspace.root);
    const results: FileEntry[] = [];
    this.walk(workspace.root, workspace.root, workspace, results, ignorePatterns);
    return results;
  }

  private walk(
    rootDir: string,
    currentDir: string,
    workspace: Workspace,
    results: FileEntry[],
    ignorePatterns: string[]
  ): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absPath = path.join(currentDir, entry.name);

      // Skip symlinks to avoid escaping workspace
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const rel = toRelative(rootDir, absPath);
        if (this.isDirIgnored(rel, ignorePatterns)) continue;
        if (this.isDirPathBlocked(rel, workspace, ignorePatterns)) continue;
        this.walk(rootDir, absPath, workspace, results, ignorePatterns);
      } else if (entry.isFile()) {
        const rel = toRelative(rootDir, absPath);
        const check = checkGlobAccess(rel, workspace, ignorePatterns);
        if (!check.allowed) continue;

        let stat: fs.Stats;
        try {
          stat = fs.statSync(absPath);
        } catch {
          continue;
        }

        results.push({
          relativePath: rel,
          absolutePath: absPath,
          sizeBytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        });
      }
    }
  }

  readFile(workspace: Workspace, relativePath: string): FileContent {
    const ignorePatterns = loadBridgeIgnore(workspace.root);
    const check = checkGlobAccess(relativePath, workspace, ignorePatterns);
    if (!check.allowed) {
      throw new Error(`Access denied: ${check.reason}`);
    }

    const absPath = resolveAndGuard(workspace.root, relativePath);

    if (isSpreadsheetPath(relativePath)) {
      throw new Error('Spreadsheet files must be read with spreadsheet actions');
    }

    const stat = this.statFile(absPath, relativePath);
    if (stat.size > MAX_FILE_SIZE) {
      throw new Error(
        `File too large (${stat.size} bytes, max ${MAX_FILE_SIZE} bytes): ${relativePath}`
      );
    }

    const content = fs.readFileSync(absPath, 'utf8');
    return {
      relativePath,
      content,
      hash: hashContent(content),
      sizeBytes: stat.size,
      encoding: 'utf8',
    };
  }

  listTree(
    workspace: Workspace,
    relativePath: string = '',
    maxDepth: number = 4,
    limit: number = 500
  ): TreeResult {
    const ignorePatterns = loadBridgeIgnore(workspace.root);
    const safeMaxDepth = Math.min(Math.max(1, maxDepth), 10);
    const safeLimit = Math.min(Math.max(1, limit), 2000);
    const startDir = relativePath
      ? resolveAndGuard(workspace.root, relativePath)
      : workspace.root;

    const counter = { count: 0 };
    const tree = this.walkTree(workspace.root, startDir, relativePath, workspace, ignorePatterns, 0, safeMaxDepth, counter, safeLimit);
    return {
      workspaceId: workspace.id,
      relativePath,
      tree,
      truncated: counter.count >= safeLimit,
      totalNodes: counter.count,
    };
  }

  private walkTree(
    rootDir: string,
    currentDir: string,
    relBase: string,
    workspace: Workspace,
    ignorePatterns: string[],
    depth: number,
    maxDepth: number,
    counter: { count: number },
    limit: number
  ): TreeEntry[] {
    if (depth >= maxDepth || counter.count >= limit) return [];

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const result: TreeEntry[] = [];

    for (const entry of entries) {
      if (counter.count >= limit) break;
      if (entry.isSymbolicLink()) continue;

      const relPath = relBase ? path.join(relBase, entry.name) : entry.name;

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (this.isDirIgnored(relPath, ignorePatterns)) continue;
        if (this.isDirPathBlocked(relPath, workspace, ignorePatterns)) continue;
        counter.count++;
        const children = this.walkTree(
          rootDir,
          path.join(currentDir, entry.name),
          relPath,
          workspace,
          ignorePatterns,
          depth + 1,
          maxDepth,
          counter,
          limit
        );
        result.push({ name: entry.name, relativePath: relPath, type: 'dir', children });
      } else if (entry.isFile()) {
        const check = checkGlobAccess(relPath, workspace, ignorePatterns);
        if (!check.allowed) continue;
        counter.count++;
        let sizeBytes: number | undefined;
        try {
          sizeBytes = fs.statSync(path.join(currentDir, entry.name)).size;
        } catch { /* ignore */ }
        result.push({ name: entry.name, relativePath: relPath, type: 'file', sizeBytes });
      }
    }

    return result;
  }

  readFileRange(
    workspace: Workspace,
    relativePath: string,
    startLine: number,
    endLine: number
  ): FileRangeContent {
    const ignorePatterns = loadBridgeIgnore(workspace.root);
    const check = checkGlobAccess(relativePath, workspace, ignorePatterns);
    if (!check.allowed) {
      throw new Error(`Access denied: ${check.reason}`);
    }

    const absPath = resolveAndGuard(workspace.root, relativePath);

    if (isSpreadsheetPath(relativePath)) {
      throw new Error('Spreadsheet files must be read with spreadsheet actions');
    }

    const stat = this.statFile(absPath, relativePath);
    if (stat.size > MAX_FILE_SIZE) {
      throw new Error(
        `File too large (${stat.size} bytes, max ${MAX_FILE_SIZE} bytes): ${relativePath}`
      );
    }

    const content = fs.readFileSync(absPath, 'utf8');
    const allLines = content.split('\n');
    const totalLines = allLines.length;

    const clampedStart = Math.max(1, startLine);
    const clampedEnd = Math.min(totalLines, endLine);

    if (clampedStart > clampedEnd) {
      throw new Error(
        `startLine (${startLine}) must be <= endLine (${endLine}) and within file range 1–${totalLines}`
      );
    }

    const lines = allLines.slice(clampedStart - 1, clampedEnd).map((lineContent, i) => ({
      lineNumber: clampedStart + i,
      content: lineContent,
    }));

    return { relativePath, startLine: clampedStart, endLine: clampedEnd, totalLines, lines };
  }

  findFile(workspace: Workspace, query: string, limit: number = 50): FindFileResult {
    const safeLimit = Math.min(Math.max(1, limit), 200);
    const lowerQuery = query.toLowerCase();
    const files = this.listFiles(workspace); // bridgeIgnore applied inside listFiles
    const matches = files
      .filter(f => path.basename(f.relativePath).toLowerCase().includes(lowerQuery))
      .slice(0, safeLimit)
      .map(f => ({
        relativePath: f.relativePath,
        sizeBytes: f.sizeBytes,
        modifiedAt: f.modifiedAt,
      }));
    return { workspaceId: workspace.id, query, matches };
  }

  repoOverview(workspace: Workspace): RepoOverview {
    const root = workspace.root;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch { /* ignore */ }

    const rootFiles = entries.filter(e => !e.isSymbolicLink() && e.isFile()).map(e => e.name);
    const rootDirs = entries.filter(e => !e.isSymbolicLink() && e.isDirectory());

    let packageManager: string | null = null;
    if (rootFiles.includes('pnpm-lock.yaml') || rootFiles.includes('pnpm-workspace.yaml')) {
      packageManager = 'pnpm';
    } else if (rootFiles.includes('yarn.lock')) {
      packageManager = 'yarn';
    } else if (rootFiles.includes('bun.lockb')) {
      packageManager = 'bun';
    } else if (rootFiles.includes('package-lock.json')) {
      packageManager = 'npm';
    } else if (rootFiles.includes('package.json')) {
      packageManager = 'npm';
    }

    let scripts: Record<string, string> = {};
    if (rootFiles.includes('package.json')) {
      try {
        const pkgJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        if (pkgJson.scripts && typeof pkgJson.scripts === 'object') {
          scripts = pkgJson.scripts as Record<string, string>;
        }
      } catch { /* ignore */ }
    }

    const readSubdirs = (dirName: string): string[] => {
      try {
        return fs
          .readdirSync(path.join(root, dirName), { withFileTypes: true })
          .filter(e => !e.isSymbolicLink() && e.isDirectory() && !SKIP_DIRS.has(e.name))
          .map(e => e.name);
      } catch {
        return [];
      }
    };

    const apps = rootDirs.some(d => d.name === 'apps') ? readSubdirs('apps') : [];
    const packages = rootDirs.some(d => d.name === 'packages') ? readSubdirs('packages') : [];

    return { workspaceId: workspace.id, packageManager, rootFiles, apps, packages, scripts };
  }

  searchFiles(workspace: Workspace, query: string, globPattern?: string): SearchMatch[] {
    const files = this.listFiles(workspace); // bridgeIgnore applied inside listFiles
    const matches: SearchMatch[] = [];
    const lowerQuery = query.toLowerCase();

    for (const file of files) {
      if (matches.length >= MAX_SEARCH_RESULTS) break;

      if (globPattern && !matchesAny(file.relativePath, [globPattern])) {
        continue;
      }

      if (file.sizeBytes > MAX_FILE_SIZE) continue;

      let content: string;
      try {
        content = fs.readFileSync(file.absolutePath, 'utf8');
      } catch {
        continue;
      }

      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const col = line.toLowerCase().indexOf(lowerQuery);
        if (col !== -1) {
          matches.push({
            relativePath: file.relativePath,
            line: i + 1,
            column: col + 1,
            preview: line.trim().slice(0, 200),
          });
          if (matches.length >= MAX_SEARCH_RESULTS) break;
        }
      }
    }

    return matches;
  }

  // Returns true if a directory is blocked by DEFAULT_BLOCKED_GLOBS, .bridgeignore,
  // or workspace blockedGlobs. Probes relPath/dummy so "my-dir/**" patterns hit correctly.
  private isDirPathBlocked(
    relPath: string,
    workspace: Pick<Workspace, 'blockedGlobs'>,
    bridgeIgnorePatterns: string[]
  ): boolean {
    const probe = relPath.replace(/\\/g, '/') + '/dummy';
    if (matchesAny(probe, DEFAULT_BLOCKED_GLOBS)) return true;
    if (matchesAny(probe, bridgeIgnorePatterns)) return true;
    if (matchesAny(probe, workspace.blockedGlobs)) return true;
    return false;
  }

  /**
   * Returns true if a directory should be skipped based on .bridgeignore patterns.
   * Checks both the dir path itself and whether its contents would be blocked.
   */
  private isDirIgnored(relPath: string, patterns: string[]): boolean {
    if (patterns.length === 0) return false;
    const normalized = relPath.replace(/\\/g, '/');
    // Match dir path itself (e.g., pattern "my-output" matches dir "my-output")
    if (matchesAny(normalized, patterns)) return true;
    // Match contents — if "my-output/**" would block files inside, skip the dir
    if (matchesAny(normalized + '/dummy', patterns)) return true;
    return false;
  }
}
