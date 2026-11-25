/**
 * Run pnpm from inside a package script, using the same pnpm that is already
 * running. Works for a global install, Corepack and standalone pnpm, and does
 * not require `pnpm` or `corepack` to be on PATH.
 *   node ./scripts/pnpm.mjs --filter bridge-api dev
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Spawn pnpm from the repository root. `options` override the spawn defaults. */
export function spawnPnpm(args, options = {}) {
  const execPath = process.env.npm_execpath ?? '';
  const defaults = { stdio: 'inherit', cwd: repoRoot, ...options };
  if (/pnpm[^/\\]*\.[cm]?js$/i.test(execPath)) return spawn(process.execPath, [execPath, ...args], defaults);
  if (/pnpm[^/\\]*$/i.test(execPath)) return spawn(execPath, args, defaults);
  return spawn('pnpm', args, { ...defaults, shell: process.platform === 'win32' });
}

/** Resolves with the exit code. */
export function runPnpm(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawnPnpm(args, options);
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPnpm(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`Could not run pnpm (${error.message}). Install it with: npm install -g pnpm@9`);
      process.exit(1);
    },
  );
}
