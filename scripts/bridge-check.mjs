/**
 * Run bridge verification checks: preflight + typecheck + test + build.
 * Requires bridge:start servers running on 4777/4779.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const LINE = '='.repeat(52);

console.log('');
console.log(LINE);
console.log('  Bridge check');
console.log('  Requires: bridge:start servers running on 4777/4779');
console.log(LINE);
console.log('');

function run(label, args) {
  console.log(`\n--- ${label} ---`);
  const result = spawnSync('corepack', ['pnpm', ...args], {
    stdio: 'inherit',
    shell: true,
    cwd: repoRoot,
  });
  if (result.status !== 0) {
    console.error(`\n[FAIL] ${label} exited with status ${result.status ?? 1}`);
    process.exit(result.status ?? 1);
  }
  console.log(`[PASS] ${label}`);
}

run('preflight:mcp', ['preflight:mcp']);
run('typecheck', ['typecheck']);
run('test', ['test']);
run('build', ['build']);

console.log('');
console.log(LINE);
console.log('  All bridge:check checks passed.');
console.log(LINE);
console.log('');
