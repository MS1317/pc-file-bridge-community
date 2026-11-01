import fs from 'fs';
import path from 'path';
import type {
  TerminalExecutionPolicy,
  TerminalJobState,
  TerminalJobTerminationReason,
} from '@bridge/shared';
import { TERMINAL_EXECUTION_POLICY } from '@bridge/shared';
import { writeFileAtomically } from './backupStore';

const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{12,64}$/;

export interface PersistedTerminalJobState {
  version: 1;
  jobId: string;
  workspaceId: string;
  workspaceName: string;
  command: string;
  relativeCwd: string;
  absoluteCwd: string;
  timeoutMs: number;
  policy: TerminalExecutionPolicy;
  startedAt: string;
  deadlineAt: string;
  state: TerminalJobState;
  processId: number | null;
  processStartedAt: string | null;
  workerProcessId: number | null;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  terminationReason: TerminalJobTerminationReason | null;
  finishedAt: string | null;
}

export interface PersistedTerminalJobControl {
  version: 1;
  jobId: string;
  leaseId: string;
  leaseExpiresAt: string;
  stopRequested: boolean;
}

export interface PersistedTerminalJobSnapshot {
  state: PersistedTerminalJobState;
  control: PersistedTerminalJobControl;
}

export type TerminalOutputStream = 'stdout' | 'stderr';

function writePersistedFile(filePath: string, content: Buffer): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      writeFileAtomically(filePath, content);
      return;
    } catch (error) {
      if (process.platform !== 'win32' || attempt >= 4) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

export class TerminalJobStore {
  private readonly rootDir: string;

  constructor(
    dataDir: string,
    private readonly policy: TerminalExecutionPolicy = TERMINAL_EXECUTION_POLICY
  ) {
    this.rootDir = path.join(dataDir, 'terminal-jobs');
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  create(state: PersistedTerminalJobState, control: PersistedTerminalJobControl): void {
    const jobDir = this.jobDir(state.jobId);
    fs.mkdirSync(jobDir);
    fs.writeFileSync(this.outputPath(state.jobId, 'stdout'), '', 'utf8');
    fs.writeFileSync(this.outputPath(state.jobId, 'stderr'), '', 'utf8');
    this.writeState(state);
    this.writeControl(control);
  }

  read(jobId: string): PersistedTerminalJobSnapshot {
    const state = this.parseState(jobId, fs.readFileSync(this.statePath(jobId), 'utf8'));
    const control = this.parseControl(jobId, fs.readFileSync(this.controlPath(jobId), 'utf8'));
    return { state, control };
  }

  writeState(state: PersistedTerminalJobState): void {
    writePersistedFile(this.statePath(state.jobId), Buffer.from(JSON.stringify(state, null, 2), 'utf8'));
  }

  writeControl(control: PersistedTerminalJobControl): void {
    writePersistedFile(this.controlPath(control.jobId), Buffer.from(JSON.stringify(control, null, 2), 'utf8'));
  }

  outputPath(jobId: string, stream: TerminalOutputStream): string {
    return path.join(this.jobDir(jobId), `${stream}.log`);
  }

  jobDirectory(jobId: string): string {
    return this.jobDir(jobId);
  }

  readOutput(jobId: string, stream: TerminalOutputStream): string {
    try {
      return fs.readFileSync(this.outputPath(jobId, stream)).subarray(0, this.policy.outputMaxBytes).toString('utf8');
    } catch {
      return '';
    }
  }

  listJobIds(): string[] {
    return fs.readdirSync(this.rootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && JOB_ID_PATTERN.test(entry.name))
      .map((entry) => entry.name);
  }

  prune(now = Date.now()): void {
    for (const jobId of this.listJobIds()) {
      try {
        const state = this.parseState(jobId, fs.readFileSync(this.statePath(jobId), 'utf8'));
        if (
          state.finishedAt &&
          state.state !== 'running' &&
          state.state !== 'stopping' &&
          now - Date.parse(state.finishedAt) > this.policy.completedRetentionMs
        ) {
          fs.rmSync(this.jobDir(jobId), { recursive: true, force: true });
        }
      } catch {
        // Preserve malformed records for explicit recovery instead of treating them as empty state.
      }
    }
  }

  private jobDir(jobId: string): string {
    if (!JOB_ID_PATTERN.test(jobId)) throw new Error('Invalid terminal job id');
    return path.join(this.rootDir, jobId);
  }

  private statePath(jobId: string): string {
    return path.join(this.jobDir(jobId), 'state.json');
  }

  private controlPath(jobId: string): string {
    return path.join(this.jobDir(jobId), 'control.json');
  }

  private parseState(jobId: string, raw: string): PersistedTerminalJobState {
    const state = JSON.parse(raw) as PersistedTerminalJobState;
    if (state.version !== 1 || state.jobId !== jobId) throw new Error('Invalid terminal job state');
    return state;
  }

  private parseControl(jobId: string, raw: string): PersistedTerminalJobControl {
    const control = JSON.parse(raw) as PersistedTerminalJobControl;
    if (control.version !== 1 || control.jobId !== jobId) throw new Error('Invalid terminal job control');
    return control;
  }
}
