import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_INSTRUCTIONS, LEGACY_DEFAULT_INSTRUCTIONS, agentMcpConfig } from '../src/agent-access.js';
import { appServerTransport } from '../src/app-server-transport.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  try { await done; } finally { clearTimeout(timer); }
}
async function freePort() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve));
  return port;
}
function mcpClient(child) {
  let nextId = 0;
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const message = JSON.parse(line);
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

test('MCP registers real agents through the API and preserves validation, generated guidance and document revisions', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tars-agent-access-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, TARS_DATA_DIR: directory, TARS_BACKEND_PORT: String(port), TARS_AGENT_API_BASE: base, TARS_EXECUTION_TOKEN: 'test-execution-token' };
  // Seed only the isolated test database; preserve an edited instruction beside the legacy default.
  const seed = spawn(process.execPath, ['--input-type=module', '-e', `
    import { Store } from './backend/src/store.js';
    import { LEGACY_DEFAULT_INSTRUCTIONS } from './backend/src/agent-access.js';
    const store = new Store();
    for (const content of [LEGACY_DEFAULT_INSTRUCTIONS, '사용자가 편집한 지침']) store.put('documents', {
      title: '팀 공통 작업 원칙', kind: 'instruction', instructionMode: 'always', content,
      version: 1, revisions: [], departmentId: null, projectId: null,
    });
    store.db.close();
  `], { cwd: root, env, stdio: 'ignore' });
  let server, mcp, logs = '';
  try {
    assert.equal((await once(seed, 'exit'))[0], 0);
    server = spawn(process.execPath, ['backend/src/server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', data => { logs = (logs + data).slice(-6000); });
    server.stderr.on('data', data => { logs = (logs + data).slice(-6000); });
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      try { ready = (await fetch(`${base}/health`)).ok; } catch { /* Startup. */ }
      if (ready || server.exitCode !== null) break;
      await delay(100);
    }
    assert(ready, logs);
    // Test-only running identity, inserted after startup recovery into this isolated DB.
    const identity = spawn(process.execPath, ['--input-type=module', '-e', `
      import { Store } from './backend/src/store.js';
      import { CEO_ID } from './backend/src/ceo.js';
      const store = new Store();
      store.put('sessions', { memberId: CEO_ID, kind: 'ceo_chat', status: 'running', processToken: process.env.TARS_EXECUTION_TOKEN });
      store.db.close();
    `], { cwd: root, env, stdio: 'ignore' });
    assert.equal((await once(identity, 'exit'))[0], 0);
    const config = agentMcpConfig();
    mcp = spawn(config.command, config.args, { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const rpc = mcpClient(mcp);
    const initialized = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert(initialized.capabilities.tools);
    const tools = (await rpc('tools/list')).tools;
    assert(tools.some(tool => tool.name === 'tars_create_member'));
    const call = (name, args = {}) => rpc('tools/call', { name, arguments: args });
    const value = result => { assert.equal(result.isError, false, JSON.stringify(result)); return JSON.parse(result.content[0].text); };
    const department = value(await call('tars_create_department', { name: 'NGIPS 개발팀' }));
    const atlas = value(await call('tars_create_member', { name: '아틀라스', departmentId: department.id, role: 'leader',
      provider: 'codex', codexAccount: 'codex2', model: 'gpt-6-astra', reasoning: 'high', instructions: '승인된 이슈를 분석하고 배정합니다.' }));
    assert.equal(atlas.codexAccount, 'codex2');
    assert.equal(atlas.reasoning, 'high');
    const duplicate = await call('tars_create_member', { name: '중복 팀장', departmentId: department.id, role: 'leader', provider: 'codex' });
    assert.equal(duplicate.isError, true);
    const worker = value(await call('tars_create_member', { name: '구현 담당', departmentId: department.id, role: 'member', provider: 'claude' }));
    const unregistered = await call('tars_api', { method: 'POST', path: '/api/tasks', body: { title: '미등록 작업', departmentId: department.id } });
    assert.equal(unregistered.isError, true);
    const work = value(await call('tars_register_work', { title: 'NGIPS 분석', instruction: '이슈를 분석하고 결과를 보고한다' }));
    assert(work.registeredAt);
    const linked = value(await call('tars_register_work', { title: work.title, instruction: work.instruction, requestId: work.id }));
    assert.equal(linked.id, work.id);
    const design = value(await call('tars_api', { method: 'POST', path: '/api/documents', body: {
      title: '분석 설계', kind: 'specification', content: '분석 범위와 결과 형식', requestId: work.id,
    } }));
    assert.equal(design.requestId, work.id);
    const task = value(await call('tars_api', { method: 'POST', path: '/api/tasks', body: { title: '분석 작업', departmentId: department.id, assigneeId: worker.id } }));
    assert.equal(task.status, 'assigned');
    assert.equal(task.requestId, work.id);
    assert.equal(task.createdBy, '00000000-0000-4000-8000-000000000001');
    const rejected = await call('tars_api', { method: 'POST', path: `/api/tasks/${task.id}/complete`, body: {} });
    assert.equal(rejected.isError, true, 'Full tool access must retain task state validation');
    const state = value(await call('tars_get_state'));
    assert.equal(state.members.length, 3);
    assert.equal(state.tasks.length, 1);
    assert.equal(state.requests.length, 1);
    const upgraded = state.documents.find(doc => doc.content === DEFAULT_INSTRUCTIONS);
    assert.equal(upgraded.version, 2);
    assert.equal(upgraded.revisions[0].content, LEGACY_DEFAULT_INSTRUCTIONS);
    assert(state.documents.some(doc => doc.content === '사용자가 편집한 지침' && doc.version === 1));
    const revised = value(await call('tars_api', { method: 'PATCH', path: `/api/documents/${upgraded.id}`,
      body: { version: 2, content: `${DEFAULT_INSTRUCTIONS}\n테스트 추가 규칙` } }));
    assert.equal(revised.version, 3);
    assert.equal(revised.revisions.length, 2);
    assert.match(await readFile(join(directory, 'shared', 'instructions.md'), 'utf8'), /테스트 추가 규칙/);
    const profile = await readFile(join(directory, 'departments', department.id, 'members', atlas.id, 'instructions.md'), 'utf8');
    assert.match(profile, /구현, 실행/);
    assert.doesNotMatch(profile, /수정하지 않습니다/);
    const proposal = value(await call('tars_api', { method: 'POST', path: `/api/requests/${work.id}/proposal`, body: {} }));
    assert.equal(proposal.status, 'pending');
    const responsePath = `/api/requests/${work.id}/approvals/${proposal.id}/respond`;
    const aiApproval = await call('tars_api', { method: 'POST', path: responsePath, body: { decision: 'approve' } });
    assert.equal(aiApproval.isError, true);
    const whileRunning = await fetch(`${base}${responsePath}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'approve' }) });
    assert.equal(whileRunning.status, 409);
    // Hold scheduling in this isolated server so no real provider can be launched.
    const end = spawn(process.execPath, ['--input-type=module', '-e', `
      import { Store } from './backend/src/store.js';
      const store = new Store();
      store.patch('settings', 'main', { maxConcurrent: 0 });
      const source = store.list('sessions').find(item => item.processToken === process.env.TARS_EXECUTION_TOKEN);
      store.patch('sessions', source.id, { status: 'completed', output: '검토할 협의안' });
      store.db.close();
    `], { cwd: root, env, stdio: 'ignore' });
    assert.equal((await once(end, 'exit'))[0], 0);
    const respond = () => fetch(`${base}${responsePath}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'feedback', comment: '검증 항목을 구체적으로 적어줘' }) });
    const response = await respond();
    assert.equal(response.status, 200);
    const saved = await response.json();
    assert.equal(saved.job.sourceSessionId, proposal.sourceSessionId);
    assert.equal(saved.job.status, 'queued');
    assert.equal((await (await respond()).json()).job.id, saved.job.id);
    const readback = await (await fetch(`${base}/api/state`)).json();
    assert.equal(readback.requests[0].status, 'revision_requested');
    assert.equal(readback.workApprovals.find(item => item.id === proposal.id).response.comment, '검증 항목을 구체적으로 적어줘');
    assert.equal(readback.workflowJobs.filter(item => item.kind === 'user_followup').length, 1);
  } finally {
    if (mcp) await stop(mcp);
    if (server) await stop(server);
    await stop(seed);
    await rm(directory, { recursive: true, force: true });
  }
});

test('App Server grants command, file and requested network permissions without treating missing input as approval', { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tars-approval-rpc-'));
  const binary = join(directory, 'fake-app-server.mjs');
  await writeFile(binary, `#!${process.execPath}
import { createInterface } from 'node:readline';
const replies = [];
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
for await (const line of createInterface({ input: process.stdin })) {
 const message = JSON.parse(line);
 if (message.method === 'initialize') {
  send({id: message.id, result: {}});
  const requests = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'tool/requestUserInput'];
  requests.forEach((method, index) => send({id: 100 + index, method, params: {threadId: 't', permissions: {network: {enabled: true}}}}));
 } else if (message.method === 'test/replies') send({id: message.id, result: replies});
 else if (message.id >= 100) replies.push(message);
}
`, { mode: 0o700 });
  const requests = [];
  const rpc = appServerTransport(binary, { cwd: directory, processToken: 'test', onSpawn() {}, onNotification() {}, onFailure() {},
    onRequest: (method, params, granted) => requests.push({ method, granted }) });
  try {
    await rpc.call('initialize', {});
    for (let i = 0; i < 50 && requests.length < 4; i++) await delay(20);
    const replies = await rpc.call('test/replies', {});
    assert.equal(replies[0].result.decision, 'acceptForSession');
    assert.equal(replies[1].result.decision, 'acceptForSession');
    assert.deepEqual(replies[2].result, { permissions: { network: { enabled: true } }, scope: 'session' });
    assert.equal(replies[3].error.code, -32601);
    assert.deepEqual(requests.map(item => item.granted), [true, true, true, false]);
  } finally { await rpc.close(); await rm(directory, { recursive: true, force: true }); }
});
