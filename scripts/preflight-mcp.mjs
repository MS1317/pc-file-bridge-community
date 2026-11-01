import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridgeApiBaseUrl = 'http://127.0.0.1:4777';
const mcpBaseUrl = 'http://127.0.0.1:4779';

const mcpTokenPath = path.join(repoRoot, 'data', 'mcp-remote-token.txt');
let mcpToken = '';
if (fs.existsSync(mcpTokenPath)) {
  mcpToken = fs.readFileSync(mcpTokenPath, 'utf8').trim();
} else {
  console.warn('[WARN] data/mcp-remote-token.txt not found — MCP auth requests will fail.');
  console.warn('       Run `pnpm token:mcp` first to generate the token, then start the servers.');
}
const workspaceRoot = path.join(repoRoot, 'data', 'bridge-test-project');

const ALL_TOOLS = [
  'list_workspaces',
  'list_files',
  'search_files',
  'read_file',
  'list_tree',
  'read_file_range',
  'find_file',
  'repo_overview',
  'preview_replace_range',
  'preview_insert_before',
  'preview_insert_after',
  'preview_change',
  'list_pending_changes',

  'reject_pending_change',
  'recent_changes',

];

function repoPath(...parts) {
  return path.join(repoRoot, ...parts);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const json = await response.json();
  return { response, json };
}

async function postJson(url, body, extraHeaders = {}) {
  return fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
}

/** Auth via Authorization: Bearer header (programmatic / curl use) */
function mcpPost(body) {
  const headers = mcpToken ? { Authorization: `Bearer ${mcpToken}` } : {};
  return postJson(`${mcpBaseUrl}/mcp`, body, headers);
}

/** Auth via URL path token (ChatGPT "No Auth" mode) */
function mcpPostPath(body) {
  if (!mcpToken) throw new Error('mcpToken not loaded — cannot test path-token auth');
  return postJson(`${mcpBaseUrl}/mcp/${mcpToken}`, body);
}

function ok(message) {
  console.log(`[PASS] ${message}`);
}

function warn(message) {
  console.log(`[WARN] ${message}`);
}

function fail(message) {
  console.log(`[FAIL] ${message}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitForJson(url, attempts = 10, delayMs = 500) {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await fetchJson(url);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Failed to reach ${url}`);
}

function buildVerificationState() {
  const checkpoints = [
    repoPath('packages', 'shared', 'dist', 'index.js'),
    repoPath('packages', 'core', 'dist', 'index.js'),
    repoPath('apps', 'bridge-api', 'dist', 'index.js'),
    repoPath('apps', 'mcp-server', 'dist', 'index.js'),
    repoPath('apps', 'dashboard', 'dist', 'index.html'),
  ];
  return checkpoints.every((filePath) => fs.existsSync(filePath));
}

async function main() {
  console.log('MCP preflight checks');
  console.log('This does not create a tunnel or expose any port publicly.');
  console.log('');

  const buildLooksPresent = buildVerificationState();
  if (buildLooksPresent) {
    ok('Build artifacts are present for shared, core, bridge-api, mcp-server, and dashboard');
  } else {
    warn('Build artifacts are missing or incomplete. Run `corepack pnpm typecheck`, `corepack pnpm test`, and `corepack pnpm build` before tunnel testing');
  }

  console.log('');

  const bridgeHealth = await waitForJson(`${bridgeApiBaseUrl}/health`);
  assert(bridgeHealth.response.ok, 'bridge-api health check failed');
  assert(bridgeHealth.json?.ok === true, 'bridge-api returned a non-ok health payload');
  ok(`bridge-api health responded at ${bridgeApiBaseUrl}/health`);

  const mcpHealth = await waitForJson(`${mcpBaseUrl}/health`);
  assert(mcpHealth.response.ok, 'mcp-server health check failed');
  assert(mcpHealth.json?.ok === true, 'mcp-server returned a non-ok health payload');
  ok(`mcp-server health responded at ${mcpBaseUrl}/health`);

  // ── Header-auth checks ─────────────────────────────────────────────────────

  const initialize = await mcpPost({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {},
  });
  assert(initialize.response.ok, 'MCP initialize request failed (header auth)');
  assert(initialize.json?.result?.serverInfo?.name === 'chatgpt-pc-file-bridge-mcp', 'Unexpected MCP server name');
  ok('MCP initialize returned server metadata (Authorization: Bearer)');

  const toolsList = await mcpPost({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  });
  assert(toolsList.response.ok, 'MCP tools/list request failed (header auth)');
  const toolNames = (toolsList.json?.result?.tools ?? []).map((tool) => tool.name);
  for (const toolName of ALL_TOOLS) {
    assert(toolNames.includes(toolName), `Missing MCP tool (header auth): ${toolName}`);
  }
  ok(`MCP tools/list correct via header auth (${ALL_TOOLS.length} tools)`);

  // ── Path-token checks (ChatGPT "No Auth" mode) ─────────────────────────────

  const initializePath = await mcpPostPath({
    jsonrpc: '2.0',
    id: 10,
    method: 'initialize',
    params: {},
  });
  assert(initializePath.response.ok, 'MCP initialize request failed (path-token auth)');
  assert(initializePath.json?.result?.serverInfo?.name === 'chatgpt-pc-file-bridge-mcp', 'Unexpected MCP server name (path auth)');
  ok('MCP initialize returned server metadata (path-token /mcp/<token>)');

  const toolsListPath = await mcpPostPath({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/list',
    params: {},
  });
  assert(toolsListPath.response.ok, 'MCP tools/list request failed (path-token auth)');
  const toolNamesPath = (toolsListPath.json?.result?.tools ?? []).map((tool) => tool.name);
  for (const toolName of ALL_TOOLS) {
    assert(toolNamesPath.includes(toolName), `Missing MCP tool (path auth): ${toolName}`);
  }
  ok(`MCP tools/list correct via path-token auth (${ALL_TOOLS.length} tools)`);

  const listWorkspaces = await mcpPost({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'list_workspaces',
      arguments: {},
    },
  });
  assert(listWorkspaces.response.ok, 'MCP list_workspaces call failed');
  const workspaces = listWorkspaces.json?.result?.structuredContent?.workspaces ?? [];
  const dummyWorkspace = workspaces.find((workspace) => workspace.name === 'Bridge Test Project');
  assert(dummyWorkspace, `Dummy workspace is missing. Create and register ${workspaceRoot} before tunnel testing`);
  ok(`Dummy workspace is registered for first-pass tunnel testing (${workspaceRoot})`);

  console.log('');
  console.log('Safety reminders');
  console.log('- Never expose 4777 bridge-api');
  console.log('- Never expose 4778 dashboard');
  console.log('- Only expose 4779 mcp-server');
  console.log('- Test only with the dummy workspace first');

  if (!buildLooksPresent) {
    console.log('');
    console.log('Next required local verification');
    console.log('- Run `corepack pnpm typecheck`');
    console.log('- Run `corepack pnpm test`');
    console.log('- Run `corepack pnpm build`');
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : 'Unknown preflight error');
  process.exit(1);
});
