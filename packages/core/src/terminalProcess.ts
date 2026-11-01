import { spawn, type ChildProcess } from 'child_process';

const SAFE_ENV_KEYS = new Set([
  'APPDATA', 'COMSPEC', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'LANG', 'LC_ALL',
  'LOCALAPPDATA', 'PATH', 'PATHEXT', 'PROGRAMDATA', 'PROGRAMFILES',
  'PROGRAMFILES(X86)', 'SHELL', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR',
  'USER', 'USERPROFILE', 'WINDIR',
]);

export function safeEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => SAFE_ENV_KEYS.has(key.toUpperCase()))
  );
}

export function isProcessAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function stopProcessTree(target: ChildProcess | number): void {
  const pid = typeof target === 'number' ? target : target.pid;
  if (!pid) return;

  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (typeof target !== 'number') {
      const fallback = setTimeout(() => target.kill(), 500);
      fallback.unref();
      target.once('close', () => clearTimeout(fallback));
      killer.once('error', () => target.kill());
      killer.once('close', () => target.kill());
    } else {
      const fallback = (): void => {
        try { process.kill(pid); } catch { /* process may already be gone */ }
      };
      killer.once('error', fallback);
      killer.once('close', (code) => { if (code !== 0) fallback(); });
    }
    return;
  }

  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* process may already be gone */ }
  }
}
