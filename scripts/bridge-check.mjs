/**
 * Run bridge verification checks: preflight + typecheck + test + build.
 * Requires bridge:start servers running on 4777/4779.
 */
import { runPnpm } from './pnpm.mjs';

const LINE = '='.repeat(52);

console.log('');
console.log(LINE);
console.log('  Bridge check');
console.log('  Requires: bridge:start servers running on 4777/4779');
console.log(LINE);
console.log('');

for (const label of ['preflight:mcp', 'typecheck', 'test', 'build']) {
  console.log(`\n--- ${label} ---`);
  const code = await runPnpm([label]);
  if (code !== 0) {
    console.error(`\n[FAIL] ${label} exited with status ${code}`);
    process.exit(code);
  }
  console.log(`[PASS] ${label}`);
}

console.log('');
console.log(LINE);
console.log('  All bridge:check checks passed.');
console.log(LINE);
console.log('');
