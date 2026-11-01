import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Workspace } from '@bridge/shared';
import { TERMINAL_EXECUTION_POLICY } from '@bridge/shared';
import { AuditLog } from '../auditLog';
import { TerminalService } from '../terminalService';

async function waitForTerminal(service: TerminalService, workspace: Workspace, jobId: string, attempts = 300) {
  let result = service.status(workspace, jobId);
  for (let attempt = 0; (result.state === 'running' || result.state === 'stopping') && attempt < attempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    result = service.status(workspace, jobId);
  }
  return result;
}

function sleepingCommand(milliseconds: number): string {
  return `node -e "process.chdir(require('os').tmpdir()); setTimeout(() => {}, ${milliseconds})"`;
}

describe('TerminalService', () => {
  let dataDir: string;
  let workspaceRoot: string;
  let workspace: Workspace;
  let service: TerminalService;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-terminal-data-'));
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-terminal-workspace-'));
    fs.mkdirSync(path.join(workspaceRoot, 'nested'));
    workspace = {
      id: 'terminal-ws',
      name: 'Terminal Workspace',
      root: workspaceRoot,
      allowedGlobs: ['**/*'],
      blockedGlobs: [],
      writeMode: 'approval_required',
      createdAt: new Date().toISOString(),
    };
    service = new TerminalService(new AuditLog(dataDir), dataDir);
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    delete process.env.BRIDGE_TEST_SECRET;
  });

  it('runs in a guarded workspace directory without inherited secrets and records an audit entry', async () => {
    process.env.BRIDGE_TEST_SECRET = 'must-not-leak';
    const result = await service.run(workspace, {
      workspaceId: workspace.id,
      relativeCwd: 'nested',
      command: `node -p "process.cwd() + '|' + (process.env.BRIDGE_TEST_SECRET || 'missing')"`,
    });

    expect(result.exitCode).toBe(0);
    expect(result.relativeCwd).toBe('nested');
    expect(result.stdout.trim()).toBe(`${path.join(workspaceRoot, 'nested')}|missing`);
    expect(new AuditLog(dataDir).readRecent(1)[0]).toMatchObject({
      action: 'terminal_command',
      workspaceId: workspace.id,
      command: result.command,
      exitCode: 0,
    });
  });

  it('rejects a working directory outside the workspace', async () => {
    await expect(service.run(workspace, {
      workspaceId: workspace.id,
      relativeCwd: '..',
      command: 'node --version',
    })).rejects.toThrow('outside workspace');
  });

  it('terminates commands at the requested timeout', async () => {
    const result = await service.run(workspace, {
      workspaceId: workspace.id,
      // Keep the child bounded: restricted Windows test runners can deny taskkill,
      // while the service still needs to report that the requested timeout fired.
      command: `node -e "setTimeout(() => {}, 500)"`,
      timeoutMs: 100,
    });
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(3_000);
  });

  it('starts a job and exposes its eventual result by opaque job id', async () => {
    const started = service.start(workspace, {
      workspaceId: workspace.id,
      command: 'node -e "console.log(\'done\')"',
      timeoutMs: 5_000,
    });
    expect(started.jobId).toBeTruthy();
    expect(started.state).toBe('running');

    let result = service.status(workspace, started.jobId);
    for (let attempt = 0; result.state === 'running' && attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      result = service.status(workspace, started.jobId);
    }

    expect(result.state).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('done');
  });

  it('keeps a long requested lifetime separate from a renewable supervisor lease', async () => {
    const policy = {
      ...TERMINAL_EXECUTION_POLICY,
      supervisorLeaseMs: 1_000,
      supervisorPollIntervalMs: 20,
    };
    const longRunning = new TerminalService(new AuditLog(dataDir), dataDir, { policy });
    const formerOneHourBoundary = 60 * 60 * 1_000;
    const started = longRunning.start(workspace, {
      workspaceId: workspace.id,
      command: sleepingCommand(1_000),
      timeoutMs: formerOneHourBoundary + 1,
    });

    let running = longRunning.status(workspace, started.jobId);
    for (let attempt = 0; (running.processId === null || running.workerProcessId === null) && attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      running = longRunning.status(workspace, started.jobId);
    }

    expect(running.state).toBe('running');
    expect(running.processId).not.toBeNull();
    expect(running.workerProcessId).not.toBeNull();
    const renewed = longRunning.renew(workspace, started.jobId, started.leaseId);
    expect(renewed.state).toBe('running');
    expect(renewed.jobId).toBe(started.jobId);
    expect(renewed.leaseId).toBe(started.leaseId);
    expect(renewed.processId).toBe(running.processId);
    expect(renewed.workerProcessId).toBe(running.workerProcessId);
    expect(fs.readdirSync(path.join(dataDir, 'terminal-jobs'))).toHaveLength(1);

    const stopRequested = longRunning.stop(workspace, started.jobId);
    expect(stopRequested.jobId).toBe(started.jobId);
    const stopped = await waitForTerminal(longRunning, workspace, started.jobId);
    expect(stopped.state).toBe('stopped');
    expect(stopped.terminationReason).toBe('explicit_stop');
    expect(stopped.timedOut).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
  });

  it('expires an unrenewed lease as timed_out instead of successful completion', async () => {
    const policy = {
      ...TERMINAL_EXECUTION_POLICY,
      supervisorLeaseMs: 100,
      supervisorPollIntervalMs: 10,
    };
    const expiring = new TerminalService(new AuditLog(dataDir), dataDir, { policy });
    const started = expiring.start(workspace, {
      workspaceId: workspace.id,
      command: sleepingCommand(1_000),
      timeoutMs: 5_000,
    });

    const result = await waitForTerminal(expiring, workspace, started.jobId);
    expect(result.state).toBe('timed_out');
    expect(result.terminationReason).toBe('lease_expired');
    expect(result.timedOut).toBe(true);
    expect(result.state).not.toBe('completed');
    await new Promise((resolve) => setTimeout(resolve, 1_100));
  });

  it('keeps completed and failed processes in their terminal states', async () => {
    const completed = service.start(workspace, {
      workspaceId: workspace.id,
      command: 'node -e "console.log(\'completed\')"',
    });
    const completedResult = await waitForTerminal(service, workspace, completed.jobId);
    expect(completedResult.state).toBe('completed');
    expect(completedResult.terminationReason).toBe('process_exit');
    expect(completedResult.exitCode).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(service.status(workspace, completed.jobId).state).toBe('completed');

    const failed = service.start(workspace, {
      workspaceId: workspace.id,
      command: 'node -e "process.exit(7)"',
    });
    const failedResult = await waitForTerminal(service, workspace, failed.jobId);
    expect(failedResult.state).toBe('failed');
    expect(failedResult.terminationReason).toBe('process_exit');
    expect(failedResult.exitCode).toBe(7);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(service.status(workspace, failed.jobId).state).toBe('failed');
  });

  it('recovers persisted ownership across service instances without spawning another process', async () => {
    const policy = {
      ...TERMINAL_EXECUTION_POLICY,
      supervisorLeaseMs: 1_000,
      supervisorPollIntervalMs: 20,
    };
    const firstService = new TerminalService(new AuditLog(dataDir), dataDir, { policy });
    const started = firstService.start(workspace, {
      workspaceId: workspace.id,
      command: sleepingCommand(1_000),
      timeoutMs: 5_000,
    });
    let beforeRestart = firstService.status(workspace, started.jobId);
    for (let attempt = 0; beforeRestart.processId === null && attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      beforeRestart = firstService.status(workspace, started.jobId);
    }

    const recoveredService = new TerminalService(new AuditLog(dataDir), dataDir, { policy });
    const afterRestart = recoveredService.status(workspace, started.jobId);
    expect(afterRestart.state).toBe('running');
    expect(afterRestart.jobId).toBe(started.jobId);
    expect(afterRestart.processId).toBe(beforeRestart.processId);
    expect(afterRestart.workerProcessId).toBe(beforeRestart.workerProcessId);

    const renewed = recoveredService.renew(workspace, started.jobId, started.leaseId);
    expect(renewed.processId).toBe(beforeRestart.processId);
    expect(fs.readdirSync(path.join(dataDir, 'terminal-jobs'))).toHaveLength(1);

    recoveredService.stop(workspace, started.jobId);
    const stopped = await waitForTerminal(recoveredService, workspace, started.jobId);
    expect(stopped.state).toBe('stopped');
    expect(stopped.terminationReason).toBe('explicit_stop');
    await new Promise((resolve) => setTimeout(resolve, 1_100));
  });
});
