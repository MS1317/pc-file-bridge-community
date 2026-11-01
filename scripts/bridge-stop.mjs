/**
 * Kill any processes occupying bridge ports 4777, 4778, 4779.
 * Uses netstat -ano (Windows) to find PIDs, then taskkill to terminate them.
 */
import { execSync, spawnSync } from 'node:child_process';

const PORTS = [4777, 4778, 4779];

function findPidsForPorts(ports) {
  const portSet = new Set(ports);
  const portPids = new Map();
  for (const port of portSet) portPids.set(port, new Set());

  let output;
  try {
    output = execSync('netstat -ano', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
  } catch {
    return portPids;
  }

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    // Expected columns: Proto LocalAddr ForeignAddr State PID  (TCP)
    //                   Proto LocalAddr ForeignAddr PID         (UDP)
    if (parts.length < 4) continue;
    const proto = parts[0];
    if (proto !== 'TCP' && proto !== 'UDP') continue;

    const localAddr = parts[1];
    const pid = parts[parts.length - 1];
    if (!/^\d+$/.test(pid) || pid === '0') continue;

    const lastColon = localAddr.lastIndexOf(':');
    if (lastColon === -1) continue;
    const port = parseInt(localAddr.slice(lastColon + 1), 10);
    if (portSet.has(port)) {
      portPids.get(port).add(pid);
    }
  }

  return portPids;
}

const portPids = findPidsForPorts(PORTS);
let killed = 0;

for (const [port, pids] of portPids) {
  if (pids.size === 0) {
    console.log(`[INFO] Port ${port}: no process found`);
    continue;
  }
  for (const pid of pids) {
    const result = spawnSync('taskkill', ['/F', '/PID', pid], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    if (result.status === 0) {
      console.log(`[STOP] Port ${port}: killed PID ${pid}`);
      killed++;
    } else {
      const msg = (result.stderr ?? result.stdout ?? '').trim();
      console.log(`[WARN] Port ${port}: PID ${pid} — ${msg || 'could not kill (may have already exited)'}`);
    }
  }
}

console.log('');
console.log(killed > 0 ? `[DONE] Killed ${killed} process(es).` : '[DONE] No bridge processes were running.');
