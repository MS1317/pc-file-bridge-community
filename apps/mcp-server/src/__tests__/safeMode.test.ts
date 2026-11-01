import { buildServer } from '../server';

test('default MCP policy denies writes and terminals even when called directly', async () => {
  delete process.env.MCP_ENABLE_WRITES;
  delete process.env.MCP_ENABLE_TERMINAL;
  const bridgeApi = { health: async () => ({ status: 'running' }) } as any;
  const app = await buildServer({ bridgeApi, mcpTokenRef: { value: 'a'.repeat(64) } });
  const post = (name: string) => app.inject({ method: 'POST', url: '/mcp', headers: { authorization: 'Bearer ' + 'a'.repeat(64) }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } } });
  const listed = await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: 'Bearer ' + 'a'.repeat(64) }, payload: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
  const names = JSON.parse(listed.body).result.tools.map((t: any) => t.name);
  expect(names).not.toContain('apply_change');
  expect(names).not.toContain('run_terminal_command');
  for (const tool of ['apply_change', 'run_terminal_command']) {
    const result = await post(tool);
    expect(JSON.parse(result.body).error.message).toContain('disabled');
  }
  await app.close();
});
