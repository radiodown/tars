import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
test('fresh CLI and MCP work against an old server without restart; no fallback on other errors', { timeout: 10000 }, async () => {
  const hits = [];
  let status = 404;
  const server = createServer((request, response) => {
    hits.push({ method: request.method, path: request.url });
    response.setHeader('content-type', 'application/json');
    if (request.url.startsWith('/api/team-activity') || request.url.startsWith('/api/agent-state')) {
      response.writeHead(status); response.end(JSON.stringify({ error: 'unavailable' })); return;
    }
    response.end(JSON.stringify({ members: [{ id: '00000000-0000-4000-8000-000000000001', name: 'CASE', status: 'idle' }],
      sessions: [], departments: [], projects: [], tasks: [], requests: [], workApprovals: [], documents: [{ content: 'OMIT DOCUMENT' }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const env = { ...process.env, TARS_AGENT_API_BASE: `http://127.0.0.1:${server.address().port}` };
  async function run(args, input) {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.end(input || '');
    const [code] = await once(child, 'exit');
    return { code, stdout, stderr };
  }
  try {
    const cli = await run(['scripts/tars-team-activity.mjs', '{"limit":1}']);
    assert.equal(cli.code, 0, cli.stderr);
    const snapshot = JSON.parse(cli.stdout);
    assert.equal(snapshot.source, 'state-fallback');
    assert.equal(snapshot.members[0].name, 'CASE');
    assert.doesNotMatch(cli.stdout, /OMIT DOCUMENT/);
    assert.deepEqual(hits.map(item => item.method), ['GET', 'GET']);
    const mcp = await run(['backend/src/agent-mcp.js'], [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tars_get_team_activity', arguments: {} } },
    ].map(item => JSON.stringify(item)).join('\n') + '\n');
    const replies = mcp.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert(replies[0].result.tools.some(tool => tool.name === 'tars_get_team_activity'));
    assert.equal(JSON.parse(replies[1].result.content[0].text).source, 'state-fallback');
    const compact = await run(['backend/src/agent-mcp.js'], JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tars_get_state', arguments: {} } }) + '\n');
    const compactResult = JSON.parse(compact.stdout).result;
    assert.equal(compactResult.isError, false);
    assert.equal(JSON.parse(compactResult.content[0].text).members[0].name, 'CASE');
    assert.doesNotMatch(compactResult.content[0].text, /OMIT DOCUMENT/);
    status = 503;
    const before = hits.length;
    const failed = await run(['scripts/tars-team-activity.mjs']);
    assert.equal(failed.code, 1);
    assert.equal(hits.length, before + 1, '503 must not be masked by a second request');
    const invalid = await run(['scripts/tars-team-activity.mjs', '{"offset":-1}']);
    assert.equal(invalid.code, 1);
    assert.equal(hits.length, before + 1, 'invalid arguments must not reach the server');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
