import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { nanoid } from 'nanoid';
import type {
  TerminalExecutionPolicy,
  TerminalJobResult,
  TerminalJobState,
  TerminalJobTerminationReason,
  TerminalRunRequest,
  TerminalRunResult,
  Workspace,
} from '@bridge/shared';
import { TERMINAL_EXECUTION_POLICY } from '@bridge/shared';
import { resolveAndGuard } from './pathGuard';
import type { AuditLog } from './auditLog';
import {
  type PersistedTerminalJobSnapshot,
  type PersistedTerminalJobState,
  TerminalJobStore,
} from './terminalJobStore';
import { isProcessAlive, safeEnvironment, stopProcessTree } from './terminalProcess';

interface PreparedTerminalRun {
  command: string;
  relativeCwd: string;
  absoluteCwd: string;
  timeoutMs: number;
}

export interface TerminalServiceOptions {
  policy?: TerminalExecutionPolicy;
  now?: () => number;
  workerPath?: string;
}

function capture(
  target: Buffer[],
  chunk: Buffer,
  currentBytes: number,
  truncated: { value: boolean },
  maxBytes: number
): number {
  const remaining = maxBytes - currentBytes;
  if (remaining <= 0) {
    truncated.value = true;
    return currentBytes;
  }
  if (chunk.length > remaining) {
    target.push(chunk.subarray(0, remaining));
    truncated.value = true;
    return maxBytes;
  }
  target.push(chunk);
  return currentBytes + chunk.length;
}

export class TerminalService {
  private readonly policy: TerminalExecutionPolicy;
  private readonly now: () => number;
  private readonly store: TerminalJobStore;
  private readonly workerPath?: string;

  constructor(
    private readonly auditLog: AuditLog,
    private readonly dataDir: string,
    options: TerminalServiceOptions = {}
  ) {
    this.policy = options.policy ?? TERMINAL_EXECUTION_POLICY;
    this.now = options.now ?? Date.now;
    this.store = new TerminalJobStore(dataDir, this.policy);
    this.workerPath = options.workerPath;
  }

  async run(workspace: Workspace, request: TerminalRunRequest): Promise<TerminalRunResult> {
    const prepared = this.prepare(
      workspace,
      request,
      this.policy.synchronousMaxTimeoutMs,
      this.policy.synchronousDefaultTimeoutMs
    );
    const startedAt = this.now();

    const result = await new Promise<TerminalRunResult>((resolve, reject) => {
      const child = spawn(prepared.command, {
        cwd: prepared.absoluteCwd,
        detached: process.platform !== 'win32',
        env: safeEnvironment(),
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const truncated = { value: false };
      let timedOut = false;

      child.stdout!.on('data', (chunk: Buffer) => {
        stdoutBytes = capture(stdout, chunk, stdoutBytes, truncated, this.policy.outputMaxBytes);
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        stderrBytes = capture(stderr, chunk, stderrBytes, truncated, this.policy.outputMaxBytes);
      });

      const timer = setTimeout(() => {
        timedOut = true;
        stopProcessTree(child);
      }, prepared.timeoutMs);

      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (exitCode, signal) => {
        clearTimeout(timer);
        const result: TerminalRunResult = {
          command: prepared.command,
          relativeCwd: prepared.relativeCwd,
          exitCode,
          signal,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          timedOut,
          truncated: truncated.value,
          durationMs: this.now() - startedAt,
        };
        this.auditLog.append({
          id: nanoid(12),
          timestamp: new Date().toISOString(),
          action: 'terminal_command',
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          relativePath: prepared.relativeCwd,
          oldHash: null,
          newHash: null,
          backupId: '',
          command: prepared.command,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
        });
        resolve(result);
      });
    });

    return result;
  }

  start(workspace: Workspace, request: TerminalRunRequest): TerminalJobResult {
    this.store.prune(this.now());
    const prepared = this.prepare(
      workspace,
      request,
      undefined,
      this.policy.asynchronousDefaultTimeoutMs
    );
    const startedAt = this.now();
    const jobId = nanoid(12);
    const leaseId = nanoid(24);
    const state: PersistedTerminalJobState = {
      version: 1,
      jobId,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      command: prepared.command,
      relativeCwd: prepared.relativeCwd,
      absoluteCwd: prepared.absoluteCwd,
      timeoutMs: prepared.timeoutMs,
      policy: this.policy,
      startedAt: new Date(startedAt).toISOString(),
      deadlineAt: new Date(startedAt + prepared.timeoutMs).toISOString(),
      state: 'running',
      processId: null,
      processStartedAt: null,
      workerProcessId: null,
      exitCode: null,
      signal: null,
      timedOut: false,
      truncated: false,
      stdoutBytes: 0,
      stderrBytes: 0,
      terminationReason: null,
      finishedAt: null,
    };
    const control = {
      version: 1 as const,
      jobId,
      leaseId,
      leaseExpiresAt: new Date(startedAt + this.policy.supervisorLeaseMs).toISOString(),
      stopRequested: false,
    };
    this.store.create(state, control);

    try {
      const worker = spawn(process.execPath, [this.resolveWorkerPath(), this.store.jobDirectory(jobId), this.dataDir], {
        cwd: prepared.absoluteCwd,
        detached: true,
        env: safeEnvironment(),
        stdio: 'ignore',
        windowsHide: true,
      });
      worker.unref();
      const snapshot = this.store.read(jobId);
      if ((snapshot.state.state === 'running' || snapshot.state.state === 'stopping') && worker.pid) {
        this.store.writeState({ ...snapshot.state, workerProcessId: worker.pid });
      }
      worker.once('error', (error) => this.failWorkerStart(jobId, error.message));
    } catch (error) {
      this.failWorkerStart(jobId, error instanceof Error ? error.message : 'Failed to start terminal worker');
    }

    return this.toJobResult(this.store.read(jobId));
  }

  status(workspace: Workspace, jobId: string): TerminalJobResult {
    this.store.prune(this.now());
    return this.toJobResult(this.recoverLostWorker(this.store.read(jobId), workspace.id));
  }

  renew(workspace: Workspace, jobId: string, leaseId: string): TerminalJobResult {
    const snapshot = this.recoverLostWorker(this.store.read(jobId), workspace.id);
    if (snapshot.control.leaseId !== leaseId) throw new Error('Terminal job lease not found');
    if (snapshot.state.state !== 'running' && snapshot.state.state !== 'stopping') {
      return this.toJobResult(snapshot);
    }
    const now = this.now();
    if (Date.parse(snapshot.control.leaseExpiresAt) <= now) {
      throw new Error('Terminal job lease expired');
    }
    this.store.writeControl({
      ...snapshot.control,
      leaseExpiresAt: new Date(now + this.policy.supervisorLeaseMs).toISOString(),
    });
    return this.toJobResult(this.store.read(jobId));
  }

  stop(workspace: Workspace, jobId: string): TerminalJobResult {
    const snapshot = this.recoverLostWorker(this.store.read(jobId), workspace.id);
    if (snapshot.state.state !== 'running' && snapshot.state.state !== 'stopping') {
      return this.toJobResult(snapshot);
    }
    if (!snapshot.control.stopRequested) {
      this.store.writeControl({ ...snapshot.control, stopRequested: true });
    }
    return this.toJobResult(this.recoverLostWorker(this.store.read(jobId), workspace.id));
  }

  private prepare(
    workspace: Workspace,
    request: TerminalRunRequest,
    maxTimeoutMs: number | undefined,
    defaultTimeoutMs: number
  ): PreparedTerminalRun {
    const command = request.command?.trim();
    if (!command) throw new Error('command is required');
    if (command.length > this.policy.commandMaxLength) {
      throw new Error(`command must be at most ${this.policy.commandMaxLength} characters`);
    }

    const timeoutMs = request.timeoutMs ?? defaultTimeoutMs;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < this.policy.minimumTimeoutMs ||
      (maxTimeoutMs !== undefined && timeoutMs > maxTimeoutMs)
    ) {
      const maximum = maxTimeoutMs === undefined ? '' : ` and at most ${maxTimeoutMs}`;
      throw new Error(`timeoutMs must be a safe integer at least ${this.policy.minimumTimeoutMs}${maximum}`);
    }

    const absoluteCwd = resolveAndGuard(workspace.root, request.relativeCwd?.trim() || '.');
    if (!fs.existsSync(absoluteCwd) || !fs.statSync(absoluteCwd).isDirectory()) {
      throw new Error('relativeCwd must be an existing directory inside the workspace');
    }
    return {
      command,
      relativeCwd: path.relative(workspace.root, absoluteCwd) || '.',
      absoluteCwd,
      timeoutMs,
    };
  }

  private recoverLostWorker(snapshot: PersistedTerminalJobSnapshot, workspaceId: string): PersistedTerminalJobSnapshot {
    if (snapshot.state.workspaceId !== workspaceId) throw new Error('Terminal job not found');
    if (
      snapshot.state.state !== 'running' &&
      snapshot.state.state !== 'stopping'
    ) return snapshot;
    if (!snapshot.state.workerProcessId || isProcessAlive(snapshot.state.workerProcessId)) return snapshot;

    if (snapshot.state.processId && isProcessAlive(snapshot.state.processId)) {
      stopProcessTree(snapshot.state.processId);
    }
    const finishedAt = new Date(this.now()).toISOString();
    const state: PersistedTerminalJobState = {
      ...snapshot.state,
      state: snapshot.state.timedOut
        ? 'timed_out'
        : snapshot.control.stopRequested
          ? 'stopped'
          : 'failed',
      terminationReason: snapshot.state.timedOut
        ? snapshot.state.terminationReason
        : snapshot.control.stopRequested
          ? 'explicit_stop'
          : 'worker_lost',
      finishedAt,
    };
    this.store.writeState(state);
    this.recordAudit(state);
    return { state, control: snapshot.control };
  }

  private failWorkerStart(jobId: string, errorMessage: string): void {
    try {
      const snapshot = this.store.read(jobId);
      if (snapshot.state.state !== 'running' && snapshot.state.state !== 'stopping') return;
      const state: PersistedTerminalJobState = {
        ...snapshot.state,
        state: 'failed',
        terminationReason: 'process_error',
        finishedAt: new Date(this.now()).toISOString(),
      };
      fs.appendFileSync(this.store.outputPath(jobId, 'stderr'), `${errorMessage}\n`);
      this.store.writeState(state);
      this.recordAudit(state);
    } catch {
      // The original start error remains visible through the API request.
    }
  }

  private recordAudit(state: PersistedTerminalJobState): void {
    const finishedAt = state.finishedAt ? Date.parse(state.finishedAt) : this.now();
    this.auditLog.append({
      id: nanoid(12),
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

  private toJobResult(snapshot: PersistedTerminalJobSnapshot): TerminalJobResult {
    const { state, control } = snapshot;
    const visibleState: TerminalJobState = state.state === 'running' && control.stopRequested
      ? 'stopping'
      : state.state;
    const finishedAt = state.finishedAt ? Date.parse(state.finishedAt) : this.now();
    return {
      jobId: state.jobId,
      leaseId: control.leaseId,
      state: visibleState,
      processId: state.processId,
      processStartedAt: state.processStartedAt,
      workerProcessId: state.workerProcessId,
      leaseExpiresAt: visibleState === 'running' || visibleState === 'stopping' ? control.leaseExpiresAt : null,
      terminationReason: state.terminationReason,
      command: state.command,
      relativeCwd: state.relativeCwd,
      exitCode: state.exitCode,
      signal: state.signal,
      stdout: this.store.readOutput(state.jobId, 'stdout'),
      stderr: this.store.readOutput(state.jobId, 'stderr'),
      timedOut: state.timedOut,
      truncated: state.truncated,
      durationMs: finishedAt - Date.parse(state.startedAt),
    };
  }

  private resolveWorkerPath(): string {
    if (this.workerPath) return this.workerPath;
    const candidates = [
      path.join(__dirname, 'terminalWorker.js'),
      path.join(__dirname, '..', 'dist', 'terminalWorker.js'),
    ];
    const workerPath = candidates.find((candidate) => fs.existsSync(candidate));
    if (!workerPath) throw new Error('Terminal worker is not built');
    return workerPath;
  }
}
