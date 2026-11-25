/**
 * Stop the bridge: whatever listens on ports 4777, 4778 and 4779, plus the
 * watchers and runners that started it. Stopping only the listeners would let a
 * watcher start them again on the next file change, for example after git pull.
 */
import { spawnSync } from 'node:child_process';

const PORTS = [4777, 4778, 4779];
const WINDOWS = process.platform === 'win32';
// Ancestors that belong to the bridge. Anything else, such as your shell, ends the search.
const RUNNER = /ts-node-dev|concurrently|bridge-dev\.mjs|scripts[\/]pnpm\.mjs|vite\.mjs|pnpm(?:\.c?js)?"?\s.*\b(?:bridge:start|dev|dev:mcp|api|mcp|ui|relay|agent)\b/i;

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (result.error) {
    console.error(`[ERROR] ${command} is required to find bridge processes (${result.error.message}).`);
    process.exit(1);
  }
  return result.stdout;
}

/** Map of port -> Set of listening PIDs. */
function findListeners() {
  if (!WINDOWS) {
    return new Map(PORTS.map((port) => [
      port,
      new Set(run('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']).split(/\s+/).filter(Boolean).map(Number)),
    ]));
  }
  const listeners = new Map(PORTS.map((port) => [port, new Set()]));
  for (const line of run('netstat', ['-ano', '-p', 'TCP']).split(/\r?\n/)) {
    // Proto  Local address  Foreign address  State  PID. Listeners have foreign port 0.
    const [proto, local, foreign, , pid] = line.trim().split(/\s+/);
    if (proto !== 'TCP' || !foreign?.endsWith(':0') || !/^[1-9]\d*$/.test(pid ?? '')) continue;
    listeners.get(Number(local.slice(local.lastIndexOf(':') + 1)))?.add(Number(pid));
  }
  return listeners;
}

/** Map of pid -> { parent, command }. */
function readProcesses() {
  const processes = new Map();
  if (WINDOWS) {
    const script = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine -replace \'[\r\n\t]\', \' \')" }';
    for (const line of run('powershell.exe', ['-NoProfile', '-Command', script]).split(/\r?\n/)) {
      const [pid, parent, command = ''] = line.split('\t');
      if (pid) processes.set(Number(pid), { parent: Number(parent), command });
    }
  } else {
    for (const line of run('ps', ['-axo', 'pid=,ppid=,command=']).split('\n')) {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (match) processes.set(Number(match[1]), { parent: Number(match[2]), command: match[3] });
    }
  }
  return processes;
}

const listeners = findListeners();
const processes = readProcesses();

const own = new Set();
for (let pid = process.pid; processes.has(pid) && !own.has(pid); pid = processes.get(pid).parent) own.add(pid);

const targets = new Set();
for (const pids of listeners.values()) {
  for (const pid of pids) {
    targets.add(pid);
    let parent = processes.get(pid)?.parent;
    while (processes.has(parent) && !own.has(parent) && !targets.has(parent) && RUNNER.test(processes.get(parent).command)) {
      targets.add(parent);
      parent = processes.get(parent).parent;
    }
  }
}
// Sibling services and helpers started by the same runner.
for (let size = -1; size !== targets.size;) {
  size = targets.size;
  for (const [pid, { parent }] of processes) if (targets.has(parent) && !own.has(pid)) targets.add(pid);
}

for (const [port, pids] of listeners) {
  console.log(pids.size > 0 ? `[STOP] Port ${port}: PID ${[...pids].join(', ')}` : `[INFO] Port ${port}: no process found`);
}
let failed = 0;
for (const pid of targets) {
  try {
    process.kill(pid, WINDOWS ? 'SIGKILL' : 'SIGTERM');
  } catch (error) {
    if (error.code === 'ESRCH') continue;
    failed += 1;
    console.log(`[WARN] PID ${pid}: ${error.code === 'EPERM' ? 'access denied. Was the bridge started as administrator?' : error.message}`);
  }
}

console.log('');
if (targets.size === 0) console.log('[DONE] No bridge processes were running.');
else if (failed === 0) console.log(`[DONE] Stopped ${targets.size} process(es).`);
else process.exitCode = 1;
