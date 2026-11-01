import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import type { TerminalJobState, TerminalJobTerminationReason } from '@bridge/shared';
import { AuditLog } from './auditLog';
import {
  type PersistedTerminalJobState,
  TerminalJobStore,
} from './terminalJobStore';
import { safeEnvironment, stopProcessTree } from './terminalProcess';

function appendBounded(
  filePath: string,
  chunk: Buffer,
  currentBytes: number,
  maxBytes: number
): { bytes: number; truncated: boolean } {
  const remaining = maxBytes - currentBytes;
  if (remaining <= 0) return { bytes: currentBytes, truncated: true };
  const output = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
  fs.appendFileSync(filePath, output);
  return { bytes: currentBytes + output.length, truncated: chunk.length > remaining };
}

function terminalState(
  state: PersistedTerminalJobState,
  exitCode: number | null,
  errorMessage?: string
): TerminalJobState {
  if (state.timedOut) return 'timed_out';
  if (state.terminationReason === 'explicit_stop') return 'stopped';
  return errorMessage || exitCode !== 0 ? 'failed' : 'completed';
}

function audit(dataDir: string, state: PersistedTerminalJobState): void {
  const finishedAt = state.finishedAt ? Date.parse(state.finishedAt) : Date.now();
  new AuditLog(dataDir).append({
    id: `${state.jobId}-${finishedAt}`,
    timestamp: state.finishedAt ?? new Date(finishedAt).toISOString(),
    action: 'terminal_command',
    workspaceId: state.workspaceId,
    workspaceName: state.workspaceName,
    relativePath: state.relativeCwd,
    oldHash: null,
    newHash: null,
    backupId: '',
    command: state.command,
    exitCode: state.exitCode,
    timedOut: state.timedOut,
    durationMs: finishedAt - Date.parse(state.startedAt),
  });
}

async function main(): Promise<void> {
  const jobDir = process.argv[2];
  const dataDir = process.argv[3];
  if (!jobDir || !dataDir) throw new Error('Terminal worker requires job and data directories');

  const jobId = jobDir.split(/[\\/]/).pop() ?? '';
  const store = new TerminalJobStore(dataDir);
  let { state } = store.read(jobId);
  const policy = state.policy;
  if (state.state !== 'running' && state.state !== 'stopping') return;

  state = { ...state, workerProcessId: process.pid };
  store.writeState(state);

  let child: ChildProcess;
  try {
    child = spawn(state.command, {
      cwd: state.absoluteCwd,
      env: safeEnvironment(),
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to start terminal process';
    const output = appendBounded(
      store.outputPath(jobId, 'stderr'),
      Buffer.from(`${message}\n`),
      state.stderrBytes,
      policy.outputMaxBytes
    );
    state = {
      ...state,
      state: 'failed',
      terminationReason: 'process_error',
      finishedAt: new Date().toISOString(),
      signal: null,
      exitCode: null,
      stderrBytes: output.bytes,
      truncated: state.truncated || output.truncated,
    };
    audit(dataDir, state);
    store.writeState(state);
    return;
  }

  state = {
    ...state,
    processId: child.pid ?? null,
    processStartedAt: new Date().toISOString(),
  };
  store.writeState(state);

  let finished = false;
  let monitor: NodeJS.Timeout | undefined;
  let terminationReason: TerminalJobTerminationReason | null = state.terminationReason;

  const finish = (exitCode: number | null, signal: string | null, errorMessage?: string): void => {
    if (finished) return;
    finished = true;
    if (monitor) clearInterval(monitor);
    if (errorMessage) {
      const result = appendBounded(
        store.outputPath(jobId, 'stderr'),
        Buffer.from(`${errorMessage}\n`),
        state.stderrBytes,
        policy.outputMaxBytes
      );
      state = { ...state, stderrBytes: result.bytes, truncated: state.truncated || result.truncated };
    }
    state = {
      ...state,
      state: terminalState(state, exitCode, errorMessage),
      exitCode,
      signal,
      terminationReason: terminationReason ?? (errorMessage ? 'process_error' : 'process_exit'),
      finishedAt: new Date().toISOString(),
    };
    audit(dataDir, state);
    store.writeState(state);
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    const result = appendBounded(
      store.outputPath(jobId, 'stdout'),
      chunk,
      state.stdoutBytes,
      policy.outputMaxBytes
    );
    state = { ...state, stdoutBytes: result.bytes, truncated: state.truncated || result.truncated };
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    const result = appendBounded(
      store.outputPath(jobId, 'stderr'),
      chunk,
      state.stderrBytes,
      policy.outputMaxBytes
    );
    state = { ...state, stderrBytes: result.bytes, truncated: state.truncated || result.truncated };
  });
  child.once('error', (error) => finish(null, null, error.message));
  child.once('close', (exitCode, signal) => finish(exitCode, signal));

  const monitorJob = (): void => {
    if (finished) return;
    try {
      const control = store.read(jobId).control;
      const now = Date.now();
      if (control.stopRequested) {
        terminationReason = 'explicit_stop';
        state = { ...state, state: 'stopping', terminationReason };
        store.writeState(state);
        stopProcessTree(child);
      } else if (now >= Date.parse(control.leaseExpiresAt)) {
        terminationReason = 'lease_expired';
        state = { ...state, state: 'stopping', timedOut: true, terminationReason };
        store.writeState(state);
        stopProcessTree(child);
      } else if (now >= Date.parse(state.deadlineAt)) {
        terminationReason = 'runtime_expired';
        state = { ...state, state: 'stopping', timedOut: true, terminationReason };
        store.writeState(state);
        stopProcessTree(child);
      }
    } catch (error) {
      finish(null, null, error instanceof Error ? error.message : 'Terminal worker state failure');
    }
  };

  monitor = setInterval(monitorJob, policy.supervisorPollIntervalMs);
  monitorJob();
}

main().catch((error) => {
  console.error('Terminal worker failed:', error);
  process.exitCode = 1;
});
