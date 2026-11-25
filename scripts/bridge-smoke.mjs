/**
 * Start the bridge the way the README says, run the preflight, then shut down.
 * CI runs this from a clean checkout so a broken first run cannot ship.
 * Ports 4777, 4778 and 4779 must be free.
 */
import { spawnSync } from 'node:child_process';
import { runPnpm, spawnPnpm } from './pnpm.mjs';

const SERVICES = ['http://127.0.0.1:4777/health', 'http://127.0.0.1:4778/', 'http://127.0.0.1:4779/health'];
const START_TIMEOUT_MS = 120_000;

async function isUp(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2_000) })).ok;
  } catch {
    return false;
  }
}

function stop(child) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
}

for (const url of SERVICES) {
  if (await isUp(url)) {
    console.error(`[FAIL] ${url} is already in use. Run bridge:stop first.`);
    process.exit(1);
  }
}

const bridge = spawnPnpm(['bridge:start'], { detached: process.platform !== 'win32' });
let code = 1;
try {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let down = SERVICES;
  while (down.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const states = await Promise.all(down.map(isUp));
    down = down.filter((_, index) => !states[index]);
  }
  if (down.length > 0) console.error(`[FAIL] Not reachable after start: ${down.join(', ')}`);
  else code = await runPnpm(['preflight:mcp']);
} finally {
  stop(bridge);
}
process.exit(code);
