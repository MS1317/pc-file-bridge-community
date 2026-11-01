const { spawnSync } = require('child_process');

const MCP_HEALTH_URL = 'http://127.0.0.1:4779/health';
const MCP_TARGET = 'http://127.0.0.1:4779';
const DEFAULT_HTTPS_PORT = '443';
const SUPPORTED_HTTPS_PORTS = new Set(['443', '8443', '10000']);

function getHttpsPort(httpsPort = process.env.TAILSCALE_HTTPS_PORT) {
  const port = String(httpsPort ?? DEFAULT_HTTPS_PORT);
  if (!SUPPORTED_HTTPS_PORTS.has(port)) {
    throw new Error('TAILSCALE_HTTPS_PORT must be one of: ' + Array.from(SUPPORTED_HTTPS_PORTS).join(', ') + '.');
  }
  return port;
}

function report(message, write = (line) => process.stdout.write(`${line}\n`)) {
  write(message);
}

function runTailscale(args, spawnImpl = spawnSync) {
  const result = spawnImpl('tailscale', args, {
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error('Tailscale CLI was not found. Install and sign in to Tailscale, then make sure `tailscale` is available on PATH.');
    }
    throw new Error(`Could not run Tailscale CLI: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const status = result.status === null ? `signal ${result.signal ?? 'unknown'}` : `exit code ${result.status}`;
    throw new Error(`Tailscale Funnel command failed with ${status}. Check Tailscale status and your tailnet Funnel policy.`);
  }
}

async function startFunnel({ fetchImpl = globalThis.fetch, spawnImpl = spawnSync, output, httpsPort } = {}) {
  const port = getHttpsPort(httpsPort);
  let response;
  try {
    response = await fetchImpl(MCP_HEALTH_URL, {
      method: 'GET',
      signal: AbortSignal.timeout(3_000),
    });
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : '';
    throw new Error(`Cannot reach the local MCP health endpoint at ${MCP_HEALTH_URL}.${detail} Start bridge-api and mcp-server first.`);
  }

  let health;
  try {
    health = await response.json();
  } catch {
    throw new Error('The local MCP health endpoint did not return JSON. Start or repair mcp-server before opening a tunnel.');
  }

  if (!response.ok || health?.ok !== true || health?.data?.status !== 'running' || health?.data?.bridgeApiHealthy !== true) {
    throw new Error('MCP or bridge-api is not healthy. Start both local services and pass `pnpm preflight:mcp` before opening a tunnel.');
  }

  // This exact target keeps bridge-api (4777) and the dashboard (4778) local.
  runTailscale(['funnel', '--https=' + port, '--bg', MCP_TARGET], spawnImpl);
  report('Tailscale Funnel is enabled for the MCP server on HTTPS port ' + port + ' only.', output);
  report('Use the HTTPS URL printed above with `/mcp/<MCP remote token>`. Get the token with `pnpm token:mcp`.', output);
}

function showStatus({ spawnImpl = spawnSync } = {}) {
  runTailscale(['funnel', 'status'], spawnImpl);
}

function stopFunnel({ spawnImpl = spawnSync, output, httpsPort } = {}) {
  const port = getHttpsPort(httpsPort);
  // Tailscale requires the original flags and target for the matching `off` command.
  runTailscale(['funnel', '--https=' + port, '--bg', MCP_TARGET, 'off'], spawnImpl);
  report('Tailscale Funnel on HTTPS port ' + port + ' has been turned off.', output);
}

async function runTailscaleTunnel(action, dependencies = {}) {
  if (action === 'on') return startFunnel(dependencies);
  if (action === 'status') return showStatus(dependencies);
  if (action === 'off') return stopFunnel(dependencies);
  throw new Error('Usage: pnpm tunnel:tailscale, pnpm tunnel:tailscale:status, or pnpm tunnel:tailscale:off');
}

if (require.main === module) {
  runTailscaleTunnel(process.argv[2]).catch((error) => {
    const message = error instanceof Error ? error.message : 'Unknown Tailscale tunnel error';
    process.stderr.write(`[tailscale-funnel] ${message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  MCP_HEALTH_URL,
  MCP_TARGET,
  getHttpsPort,
  runTailscaleTunnel,
  startFunnel,
  showStatus,
  stopFunnel,
};
