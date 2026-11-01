const { MCP_HEALTH_URL, MCP_TARGET, runTailscaleTunnel } = require('../../../../scripts/tailscale-funnel.cjs') as {
  MCP_HEALTH_URL: string;
  MCP_TARGET: string;
  runTailscaleTunnel: (action: string, dependencies?: Record<string, unknown>) => Promise<void>;
};

describe('opt-in Tailscale Funnel commands', () => {
  let fetchImpl: jest.Mock;
  let spawnImpl: jest.Mock;
  let output: jest.Mock;

  beforeEach(() => {
    fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, data: { status: 'running', bridgeApiHealthy: true } }),
    });
    spawnImpl = jest.fn().mockReturnValue({ status: 0, signal: null, error: undefined });
    output = jest.fn();
  });

  it('checks the complete local health chain and exposes only MCP port 4779', async () => {
    await runTailscaleTunnel('on', { fetchImpl, spawnImpl, output });

    expect(fetchImpl).toHaveBeenCalledWith(MCP_HEALTH_URL, expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal) }));
    expect(spawnImpl).toHaveBeenCalledWith('tailscale', [
      'funnel', '--https=443', '--bg', MCP_TARGET,
    ], { stdio: 'inherit', shell: false, windowsHide: true });
    expect(spawnImpl.mock.calls[0][1].join(' ')).not.toContain('4777');
    expect(spawnImpl.mock.calls[0][1].join(' ')).not.toContain('4778');
    expect(spawnImpl.mock.calls[0][1]).not.toContain('--yes');
    expect(output).toHaveBeenCalledWith(expect.stringContaining('/mcp/<MCP remote token>'));
  });

  it('uses TAILSCALE_HTTPS_PORT for matching start and stop commands', async () => {
    const originalHttpsPort = process.env.TAILSCALE_HTTPS_PORT;
    process.env.TAILSCALE_HTTPS_PORT = '10000';
    try {
      await runTailscaleTunnel('on', { fetchImpl, spawnImpl, output });
      await runTailscaleTunnel('off', { fetchImpl, spawnImpl, output });
    } finally {
      if (originalHttpsPort === undefined) delete process.env.TAILSCALE_HTTPS_PORT;
      else process.env.TAILSCALE_HTTPS_PORT = originalHttpsPort;
    }

    expect(spawnImpl.mock.calls[0][1]).toEqual([
      'funnel', '--https=10000', '--bg', MCP_TARGET,
    ]);
    expect(spawnImpl.mock.calls[1][1]).toEqual([
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
    await runTailscaleTunnel('off', { fetchImpl, spawnImpl, output });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(spawnImpl).toHaveBeenCalledWith('tailscale', [
      'funnel', '--https=443', '--bg', MCP_TARGET, 'off',
    ], expect.objectContaining({ shell: false }));
    expect(spawnImpl.mock.calls[0][1]).not.toContain('reset');
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
