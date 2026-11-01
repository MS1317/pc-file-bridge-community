import fs from 'fs';
import os from 'os';
import path from 'path';
import { FileService } from '../fileService';
import { checkGlobAccess } from '../globFilter';
import { WorkspaceRegistry } from '../workspaceRegistry';

describe('WorkspaceRegistry policy updates', () => {
  let dataDir: string;
  let firstRoot: string;
  let secondRoot: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-policy-data-'));
    firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-policy-first-'));
    secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-policy-second-'));
    fs.mkdirSync(path.join(firstRoot, 'logs', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(firstRoot, 'logs', 'brain.log'), 'brain log');
    fs.writeFileSync(path.join(firstRoot, 'logs', 'sessions', 'session.jsonl'), '{"event":"test"}\n');
    fs.writeFileSync(path.join(firstRoot, 'runtime.db'), 'not readable');
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
  });

  it('persists a policy update, exposes log files, and keeps default database blocking intact', () => {
    const registry = new WorkspaceRegistry(dataDir);
    const first = registry.add({ name: 'Runtime data', root: firstRoot });
    const second = registry.add({ name: 'Unaffected', root: secondRoot });
    const secondPolicy = { allowedGlobs: [...second.allowedGlobs], blockedGlobs: [...second.blockedGlobs] };

    const updated = registry.updatePolicy(first.id, {
      allowedGlobs: [...first.allowedGlobs, '**/*.log', '**/*.jsonl'],
      blockedGlobs: first.blockedGlobs.filter((pattern) => pattern !== '**/*.db'),
    });

    expect(updated).toMatchObject({ id: first.id, root: path.resolve(firstRoot) });
    expect(updated?.allowedGlobs).toEqual(expect.arrayContaining(['**/*.log', '**/*.jsonl']));
    expect(updated?.blockedGlobs).not.toContain('**/*.db');

    // A fresh registry simulates bridge restart/reconnect reading the persisted source of truth.
    const persisted = new WorkspaceRegistry(dataDir).get(first.id)!;
    expect(persisted.allowedGlobs).toEqual(expect.arrayContaining(['**/*.log', '**/*.jsonl']));
    expect(persisted.blockedGlobs).not.toContain('**/*.db');
    expect(new WorkspaceRegistry(dataDir).get(second.id)).toMatchObject(secondPolicy);

    const service = new FileService();
    const listed = service.listFiles(persisted).map((entry) => entry.relativePath.replace(/\\/g, '/'));
    expect(listed).toEqual(expect.arrayContaining(['logs/brain.log', 'logs/sessions/session.jsonl']));
    expect(service.readFile(persisted, 'logs/brain.log').content).toBe('brain log');
    expect(() => service.readFile(persisted, 'runtime.db')).toThrow(/Access denied/);
    expect(() => service.readFile(persisted, '../outside.log')).toThrow();
  });

  it('does not let an allowed pattern override a default or explicit blocked pattern', () => {
    const workspace = {
      allowedGlobs: ['**/*.db', '**/*.log'],
      blockedGlobs: ['**/private/**'],
    };

    expect(checkGlobAccess('runtime.db', workspace).allowed).toBe(false);
    expect(checkGlobAccess('private/current.log', workspace).allowed).toBe(false);
    expect(checkGlobAccess('logs/current.log', workspace).allowed).toBe(true);
  });
});
