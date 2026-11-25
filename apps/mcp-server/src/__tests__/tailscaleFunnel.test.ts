const { MCP_HEALTH_URL, MCP_TARGET, runTailscaleTunnel } = require('../../../../scripts/tailscale-funnel.cjs') as {
  MCP_HEALTH_URL: string;
  MCP_TARGET: string;
  runTailscaleTunnel: (action: string, dependencies?: Record<string, unknown>) => Promise<void>;
};

describe('opt-in Tailscale Funnel commands', () => {
  let fetchImpl: jest.Mock;
  let spawnImpl: jest.Mock;
  let output: jest.Mock;
  let serveConfig: unknown;

  const published = (port: string, handlers: Record<string, { Proxy: string }>) => ({
    TCP: { [port]: { HTTPS: true } },
    Web: { ['pc.example.ts.net:' + port]: { Handlers: handlers } },
  });
  // Commands that change something, without the status read that precedes them.
  const changes = () => spawnImpl.mock.calls.filter(([, args]) => args[0] !== 'serve');

  beforeEach(() => {
    fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, data: { status: 'running', bridgeApiHealthy: true } }),
    });
    serveConfig = {};
    spawnImpl = jest.fn().mockImplementation((_command: string, args: string[]) => ({
      status: 0, signal: null, error: undefined,
      stdout: args[0] === 'serve' ? JSON.stringify(serveConfig) : undefined,
    }));
    output = jest.fn();
  });

  it('checks the complete local health chain and exposes only MCP port 4779', async () => {
    await runTailscaleTunnel('on', { fetchImpl, spawnImpl, output });

    expect(fetchImpl).toHaveBeenCalledWith(MCP_HEALTH_URL, expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal) }));
    expect(spawnImpl).toHaveBeenCalledWith('tailscale', [
      'funnel', '--https=443', '--bg', MCP_TARGET,
    ], { stdio: 'inherit', shell: false, windowsHide: true });
    expect(changes()).toHaveLength(1);
    expect(changes()[0][1].join(' ')).not.toContain('4777');
    expect(changes()[0][1].join(' ')).not.toContain('4778');
    expect(changes()[0][1]).not.toContain('--yes');
    expect(output).toHaveBeenCalledWith(expect.stringContaining('/mcp/<MCP remote token>'));
  });

  it('uses TAILSCALE_HTTPS_PORT for matching start and stop commands', async () => {
    const originalHttpsPort = process.env.TAILSCALE_HTTPS_PORT;
    process.env.TAILSCALE_HTTPS_PORT = '10000';
    try {
      await runTailscaleTunnel('on', { fetchImpl, spawnImpl, output });
      serveConfig = published('10000', { '/': { Proxy: MCP_TARGET } });
      await runTailscaleTunnel('off', { fetchImpl, spawnImpl, output });
    } finally {
      if (originalHttpsPort === undefined) delete process.env.TAILSCALE_HTTPS_PORT;
      else process.env.TAILSCALE_HTTPS_PORT = originalHttpsPort;
    }

    expect(changes()[0][1]).toEqual([
      'funnel', '--https=10000', '--bg', MCP_TARGET,
    ]);
    expect(changes()[1][1]).toEqual([
      'funnel', '--https=10000', '--bg', MCP_TARGET, 'off',
    ]);
    expect(output).toHaveBeenCalledWith(expect.stringContaining('HTTPS port 10000'));
  });

  it('rejects an unsupported HTTPS port before contacting MCP or Tailscale', async () => {
    await expect(runTailscaleTunnel('on', { fetchImpl, spawnImpl, output, httpsPort: '9999' }))
      .rejects.toThrow('TAILSCALE_HTTPS_PORT must be one of: 443, 8443, 10000');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'MCP unavailable', response: { ok: false, status: 503, json: async () => ({ ok: false }) } },
    { label: 'bridge API degraded', response: { ok: true, status: 200, json: async () => ({ ok: true, data: { status: 'degraded', bridgeApiHealthy: false } }) } },
  ])('does not open a Funnel when health fails: $label', async ({ response }) => {
    fetchImpl.mockResolvedValueOnce(response);
    await expect(runTailscaleTunnel('on', { fetchImpl, spawnImpl, output })).rejects.toThrow('not healthy');
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('reports a local health connection failure without calling Tailscale', async () => {
    fetchImpl.mockRejectedValueOnce(new Error('connection refused'));
    await expect(runTailscaleTunnel('on', { fetchImpl, spawnImpl, output })).rejects.toThrow('Start bridge-api and mcp-server first');
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('reports Funnel status without enabling or disabling anything', async () => {
    await runTailscaleTunnel('status', { fetchImpl, spawnImpl, output });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(spawnImpl).toHaveBeenCalledWith('tailscale', ['funnel', 'status'], expect.objectContaining({ shell: false }));
  });

  it('turns off the same HTTPS Funnel configuration without resetting other Tailscale settings', async () => {
    serveConfig = published('443', { '/': { Proxy: MCP_TARGET } });
    await runTailscaleTunnel('off', { fetchImpl, spawnImpl, output });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(spawnImpl).toHaveBeenCalledWith('tailscale', [
      'funnel', '--https=443', '--bg', MCP_TARGET, 'off',
    ], expect.objectContaining({ shell: false }));
    expect(changes()[0][1]).not.toContain('reset');
  });

  it.each<{ label: string; handlers: Record<string, { Proxy: string }> }>([
    { label: 'another app', handlers: { '/': { Proxy: 'http://127.0.0.1:5199' } } },
    { label: 'another path on our port', handlers: { '/': { Proxy: MCP_TARGET }, '/private': { Proxy: 'http://127.0.0.1:5199' } } },
  ])('never replaces, publishes or removes $label', async ({ handlers }) => {
    serveConfig = published('443', handlers);
    await expect(runTailscaleTunnel('on', { fetchImpl, spawnImpl, output })).rejects.toThrow('already publishes another app');
    await expect(runTailscaleTunnel('off', { fetchImpl, spawnImpl, output })).rejects.toThrow('left alone');
    expect(changes()).toHaveLength(0);
  });

  it('can be started again while already running, and does nothing when there is nothing to stop', async () => {
    await runTailscaleTunnel('off', { fetchImpl, spawnImpl, output });
    expect(changes()).toHaveLength(0);
    serveConfig = published('443', { '/': { Proxy: MCP_TARGET } });
    await runTailscaleTunnel('on', { fetchImpl, spawnImpl, output });
    expect(changes()).toHaveLength(1);
  });

  it('changes nothing when the current Tailscale configuration cannot be read', async () => {
    spawnImpl.mockReturnValueOnce({ status: 1, signal: null, error: undefined, stdout: '' });
    await expect(runTailscaleTunnel('on', { fetchImpl, spawnImpl, output })).rejects.toThrow('Could not read');
    expect(changes()).toHaveLength(0);
  });

  it('returns actionable errors for missing CLI and nonzero CLI results', async () => {
    spawnImpl.mockReturnValueOnce({
      status: null,
      signal: null,
      error: Object.assign(new Error('not found'), { code: 'ENOENT' }),
    });
    await expect(runTailscaleTunnel('status', { fetchImpl, spawnImpl, output })).rejects.toThrow('Tailscale CLI was not found');

    spawnImpl.mockReturnValueOnce({ status: 1, signal: null, error: undefined });
    await expect(runTailscaleTunnel('status', { fetchImpl, spawnImpl, output })).rejects.toThrow('tailnet Funnel policy');
  });

  it('rejects unknown actions with the available commands', async () => {
    await expect(runTailscaleTunnel('reset', { fetchImpl, spawnImpl, output })).rejects.toThrow('tunnel:tailscale:status');
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});
