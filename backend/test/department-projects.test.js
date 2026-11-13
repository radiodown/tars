import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const directory = mkdtempSync(join(tmpdir(), 'tars-department-projects-'));
process.env.TARS_DATA_DIR = directory;
const { Store, ROOT, id } = await import('../src/store.js');
const { Orchestrator } = await import('../src/orchestrator.js');
const { consultationSchema } = await import('../src/contracts.js');
after(() => rmSync(directory, { recursive: true, force: true }));

function fixture(run) {
  const store = new Store();
  const orchestrator = new Orchestrator(store);
  // Exercise session creation and project resolution without invoking an AI.
  orchestrator.run = async () => {};
  const project = store.put('projects', { name: '소스 A', path: directory });
  const otherProject = store.put('projects', { name: '소스 B', path: directory });
  const department = store.put('departments', { name: '개발팀', projectId: project.id });
  const leader = store.put('members', { name: '팀장', departmentId: department.id, role: 'leader', provider: 'claude', status: 'idle' });
  try { run({ store, orchestrator, project, otherProject, department, leader }); }
  finally { store.db.close(); }
}

for (const method of ['consult', 'report']) {
  test(`${method} uses the department project when projectId is omitted`, () => fixture(({ store, orchestrator, project, leader }) => {
    const session = orchestrator[method](consultationSchema.parse({ leaderId: leader.id, prompt: '진행 상황을 정리해줘' }));
    assert.equal(session.projectId, project.id);
    assert.equal(store.require('sessions', session.id).projectId, project.id);
  }));

  test(`${method} preserves an explicit project or null for scoped API callers`, () => {
    for (const withoutProject of [false, true]) fixture(({ orchestrator, otherProject, leader }) => {
      const projectId = withoutProject ? null : otherProject.id;
      const session = orchestrator[method](consultationSchema.parse({ leaderId: leader.id, projectId, prompt: '기존 업무를 정리해줘' }));
      assert.equal(session.projectId, projectId);
    });
  });

  test(`${method} supports departments without an assigned project, including legacy records`, () => {
    for (const legacy of [false, true]) fixture(({ store, orchestrator, department, leader }) => {
      if (legacy) store.put('departments', { id: department.id, name: department.name });
      else store.patch('departments', department.id, { projectId: null });
      const session = orchestrator[method](consultationSchema.parse({ leaderId: leader.id, prompt: '문서를 작성해줘' }));
      assert.equal(session.projectId, null);
    });
  });
}

test('each leader uses its own department default and later changes leave existing sessions intact', () => fixture(({ store, orchestrator, department, project, otherProject, leader }) => {
  const first = orchestrator.consult({ leaderId: leader.id, prompt: '첫 협의' });
  const secondDepartment = store.put('departments', { name: '운영팀', projectId: otherProject.id });
  const secondLeader = store.put('members', { name: '운영팀장', departmentId: secondDepartment.id, role: 'leader', provider: 'claude', status: 'idle' });
  assert.equal(orchestrator.consult({ leaderId: secondLeader.id, prompt: '운영 협의' }).projectId, otherProject.id);
  store.patch('departments', department.id, { projectId: otherProject.id });
  store.patch('members', leader.id, { status: 'idle' });
  orchestrator.active.clear();
  assert.equal(orchestrator.report({ leaderId: leader.id, prompt: '변경 후 보고' }).projectId, otherProject.id);
  assert.equal(store.require('sessions', first.id).projectId, project.id);
}));

test('an inherited project is validated before a session starts', () => fixture(({ store, orchestrator, department, leader }) => {
  store.patch('departments', department.id, { projectId: id() });
  const before = store.list('sessions').length;
  assert.throws(() => orchestrator.consult({ leaderId: leader.id, prompt: '협의' }), { statusCode: 404 });
  assert.equal(store.list('sessions').length, before);
  assert.equal(store.require('members', leader.id).status, 'idle');
}));

test('the inherited project is used to validate linked work', () => fixture(({ store, orchestrator, project, otherProject, leader }) => {
  const request = store.put('requests', { projectId: project.id, createdBy: leader.id, registeredAt: new Date().toISOString(), status: 'open' });
  const session = orchestrator.consult({ leaderId: leader.id, prompt: '후속 협의', requestId: request.id });
  assert.equal(session.projectId, project.id);
  assert.equal(session.requestId, request.id);
  store.patch('members', leader.id, { status: 'idle' });
  orchestrator.active.clear();
  const unrelated = store.put('requests', { projectId: otherProject.id, createdBy: leader.id, registeredAt: new Date().toISOString(), status: 'open' });
  assert.throws(() => orchestrator.consult({ leaderId: leader.id, prompt: '다른 업무', requestId: unrelated.id }), /프로젝트/);
}));

test('department APIs validate assignments and preserve them across updates and server restarts', { timeout: 20000 }, async () => {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, TARS_DATA_DIR: join(directory, 'api'), TARS_BACKEND_PORT: String(port) };
  let server;
  async function start() {
    let logs = '';
    server = spawn(process.execPath, ['backend/src/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [server.stdout, server.stderr]) stream.on('data', data => { logs = (logs + data).slice(-6000); });
    for (let attempt = 0; attempt < 80; attempt++) {
      try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* Startup. */ }
      if (server.exitCode !== null) break;
      await delay(50);
    }
    assert.fail(logs || 'Test API did not start');
  }
  async function stop() {
    if (!server || server.exitCode !== null || server.signalCode !== null) return;
    const done = once(server, 'exit');
    server.kill('SIGTERM');
    const timer = setTimeout(() => server.kill('SIGKILL'), 3000);
    try { await done; } finally { clearTimeout(timer); }
  }
  async function call(path, method, body, status = 200) {
    const response = await fetch(`${base}/api${path}`, { method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }
  try {
    await start();
    const project = await call('/projects', 'POST', { name: '테스트 소스', path: directory });
    await call('/departments', 'POST', { name: '잘못된 부서', projectId: id() }, 404);
    const department = await call('/departments', 'POST', { name: '개발팀', projectId: project.id });
    assert.equal(department.projectId, project.id);
    await call(`/departments/${department.id}`, 'PATCH', { projectId: id() }, 404);
    const renamed = await call(`/departments/${department.id}`, 'PATCH', { name: '제품 개발팀' });
    assert.equal(renamed.projectId, project.id);
    const unassigned = await call('/departments', 'POST', { name: '기획팀' });
    assert.equal(unassigned.projectId, null);
    await stop();
    await start();
    const state = await call('/state', 'GET');
    assert.equal(state.departments.find(item => item.id === department.id).projectId, project.id);
    assert.equal(state.departments.find(item => item.id === unassigned.id).projectId, null);
    assert(!state.departments.some(item => item.name === '잘못된 부서'));
    assert.equal((await call(`/departments/${department.id}`, 'PATCH', { projectId: null })).projectId, null);
  } finally { await stop(); }
});
