import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Set the data root before loading application modules. Never touch the user's DB.
const directory = mkdtempSync(join(tmpdir(), 'tars-work-history-'));
process.env.TARS_DATA_DIR = directory;
const { Store, id, now } = await import('../src/store.js');
const { WorkStatusFiles, managementSnapshot, managerStatusPath, requestSnapshot, writeExecutionRecord } = await import('../src/work-records.js');
const { Orchestrator } = await import('../src/orchestrator.js');
after(() => rmSync(directory, { recursive: true, force: true }));

async function withStore(run) {
  const store = new Store();
  store.db.exec("DELETE FROM work_history; DELETE FROM records WHERE kind <> 'settings';");
  try { await run(store); } finally { store.db.close(); }
}
function organization(store) {
  const department = store.put('departments', { name: '개발팀' });
  const ceo = store.put('members', { name: 'TARS', role: 'ceo', departmentId: null, status: 'idle' });
  const leader = store.put('members', { name: '팀장', role: 'leader', departmentId: department.id, status: 'idle' });
  const worker = store.put('members', { name: '작업자', role: 'member', departmentId: department.id, status: 'idle' });
  return { department, ceo, leader, worker };
}
function taskFor(store, worker, extra = {}) {
  return store.put('tasks', { title: '최초 task', description: '최초 지시', acceptance: '명시된 완료 기준',
    status: 'assigned', assigneeId: worker.id, departmentId: worker.departmentId, projectId: null,
    dependsOn: [], documentIds: [], createdBy: 'user', ...extra });
}
function attempt(store, worker, task, extra = {}) {
  return store.put('sessions', { memberId: worker.id, departmentId: worker.departmentId, taskId: task.id,
    projectId: task.projectId, kind: 'work', provider: 'codex', codexAccount: 'codex2', model: 'test-model',
    transport: 'app-server', status: 'preparing', progress: '작업 문맥 준비 중', output: '', startedAt: now(), heartbeatAt: now(),
    request: requestSnapshot(store, worker, 'work', { taskId: task.id, projectId: task.projectId }), ...extra });
}

test('status history is atomic, while token deltas and heartbeats do not inflate it', () => withStore(store => {
  const { worker } = organization(store);
  const task = taskFor(store, worker);
  const session = attempt(store, worker, task);
  store.patch('sessions', session.id, { status: 'running', progress: 'AI 응답 대기 중' });
  const before = store.history('sessions', session.id).total;
  store.patch('sessions', session.id, { heartbeatAt: now(), output: '한 글자' });
  store.patch('sessions', session.id, { heartbeatAt: now(), output: '한 글자 더' });
  assert.equal(store.history('sessions', session.id).total, before);
  store.patch('sessions', session.id, { progress: '작업 중: 파일 수정', activityNote: '오류 처리 분기를 수정했습니다.' });
  assert.equal(store.history('sessions', session.id).total, before + 2);
  assert.throws(() => store.transaction(() => {
    store.patch('sessions', session.id, { status: 'completed', endedAt: now() });
    throw new Error('rollback');
  }), /rollback/);
  assert.equal(store.get('sessions', session.id).status, 'running');
  assert.equal(store.history('sessions', session.id).total, before + 2);
}));

test('task edits, user steering, review and integration retain their actor and provenance', () => withStore(store => {
  const { worker } = organization(store);
  const task = taskFor(store, worker);
  const session = attempt(store, worker, task);
  store.patch('sessions', session.id, { steering: [{ id: id(), prompt: '기존 API도 유지하세요.', createdAt: now() }] });
  store.patch('tasks', task.id, { title: '수정 task', description: '변경된 지시', status: 'review', sessionId: session.id }, { actor: 'user' });
  store.patch('tasks', task.id, { status: 'done' }, { actor: 'user' });
  store.patch('tasks', task.id, { integratedAt: now() }, { actor: 'user' });
  const events = store.history('tasks', task.id).events;
  assert.equal(events.find(event => event.event === 'instruction').details.prompt, '기존 API도 유지하세요.');
  assert.equal(events.find(event => event.event === 'instruction').actor, 'user');
  assert.deepEqual(events.find(event => event.event === 'edited').details.description, { from: '최초 지시', to: '변경된 지시' });
  assert.equal(events.find(event => event.status === 'done').actor, 'user');
  assert(events.some(event => event.event === 'integrated'));
  assert.equal(store.get('sessions', session.id).request.task.description, '최초 지시');
}));

test('retries retain earlier request/result files and distinguish execution from review', () => withStore(async store => {
  const { leader, worker } = organization(store);
  const plan = store.put('sessions', { memberId: leader.id, kind: 'plan', status: 'completed', prompt: '원본 사용자 요청', output: '계획', startedAt: now(), endedAt: now() });
  const task = taskFor(store, worker, { createdBy: leader.id, originSessionId: plan.id });
  const first = attempt(store, worker, task);
  store.patch('tasks', task.id, { status: 'review' });
  store.patch('sessions', first.id, { status: 'completed', endedAt: now(), progress: '결과 도착', output: '첫 실행 결과 · 미검증' });
  await writeExecutionRecord(store, first.id);
  const saved = store.get('sessions', first.id);
  const original = await readFile(saved.recordPath, 'utf8');
  assert.match(original, /원본 사용자 요청/);
  assert.match(original, /기록 시점 작업 상태: review/);
  store.patch('tasks', task.id, { description: '후속 지시', status: 'running' });
  const second = attempt(store, worker, store.get('tasks', task.id));
  store.patch('sessions', second.id, { status: 'failed', endedAt: now(), progress: '권한 오류', output: '일부만 처리' });
  store.patch('tasks', task.id, { status: 'blocked' });
  await writeExecutionRecord(store, second.id);
  assert.equal(await readFile(saved.recordPath, 'utf8'), original);
  assert.notEqual(saved.recordPath, store.get('sessions', second.id).recordPath);
  assert.equal(saved.request.source.sessionId, plan.id);
  assert.equal(saved.request.requestedBy.name, leader.name);
  assert.equal(saved.resultSnapshot.taskStatus, 'review');
  assert.equal(store.get('sessions', second.id).request.instruction, '후속 지시');
}));

test('history pagination is lossless and separate from the 500-entry activity feed', () => withStore(store => {
  const { worker } = organization(store);
  const task = taskFor(store, worker);
  const session = attempt(store, worker, task);
  for (let index = 0; index < 125; index++) store.patch('sessions', session.id, { progress: `단계 ${index}` });
  const expected = store.history('sessions', session.id).total;
  for (let index = 0; index < 510; index++) store.event(`최근 알림 ${index}`);
  assert.equal(store.list('events').length, 500);
  const seen = new Set();
  let before;
  do {
    const page = store.history('sessions', session.id, { before, limit: 20 });
    for (const event of page.events) { assert(!seen.has(event.sequence)); seen.add(event.sequence); }
    before = page.nextBefore;
  } while (before);
  assert.equal(seen.size, expected);
}));

test('manager views show busy members across projects, freshness, and department boundaries', () => withStore(store => {
  const { ceo, leader, worker } = organization(store);
  const outsider = store.put('members', { name: '다른 부서', role: 'member', departmentId: id(), status: 'idle' });
  const task = taskFor(store, worker, { projectId: id() });
  const session = attempt(store, worker, task, { status: 'running', heartbeatAt: new Date(Date.now() - 60000).toISOString(), lastActivityAt: null });
  store.patch('members', worker.id, { status: 'running', currentSessionId: session.id });
  const snapshot = managementSnapshot(store, leader, id());
  assert.equal(snapshot.tasks.length, 0);
  assert.equal(snapshot.members.length, 1);
  assert.equal(snapshot.members[0].isWorking, true);
  assert.equal(snapshot.members[0].observation, 'stale');
  assert.equal(snapshot.members[0].lastActivityAt, null);
  assert(managementSnapshot(store, ceo).members.some(member => member.id === outsider.id));
  store.patch('sessions', session.id, { status: 'completed', endedAt: now() });
  store.patch('members', worker.id, { status: 'idle', currentSessionId: null });
  assert.equal(managementSnapshot(store, leader).members[0].isWorking, false);
}));

test('manager status files reflect the latest database without invoking an AI', () => withStore(async store => {
  const { leader, worker } = organization(store);
  const task = taskFor(store, worker);
  const session = attempt(store, worker, task, { status: 'running' });
  store.patch('members', worker.id, { status: 'running', currentSessionId: session.id });
  const files = new WorkStatusFiles(store);
  files.start();
  try {
    await files.flush();
    const before = JSON.parse(await readFile(managerStatusPath(leader), 'utf8'));
    assert.equal(before.members[0].sessionId, session.id);
    store.patch('sessions', session.id, { status: 'cancelled', endedAt: now() });
    store.patch('members', worker.id, { status: 'idle', currentSessionId: null });
  } finally { await files.close(); }
  const after = JSON.parse(await readFile(managerStatusPath(leader), 'utf8'));
  assert.equal(after.members[0].isWorking, false);
  assert.equal(after.recentExecutions[0].status, 'cancelled');
}));

test('restart recovery records interruption and blocked task, without replaying execution', () => withStore(async store => {
  const { worker } = organization(store);
  const task = taskFor(store, worker, { status: 'running' });
  const session = attempt(store, worker, task, { status: 'running' });
  store.patch('members', worker.id, { status: 'running', currentSessionId: session.id });
  const orchestrator = new Orchestrator(store);
  try { await orchestrator.recover(); }
  finally { await orchestrator.shutdown(); }
  const recovered = store.get('sessions', session.id);
  assert.equal(recovered.status, 'interrupted');
  assert.equal(recovered.resultSnapshot.taskStatus, 'blocked');
  assert.equal(store.get('members', worker.id).status, 'idle');
  assert.equal(store.list('sessions').length, 1);
  assert(store.history('tasks', task.id).events.some(event => event.status === 'interrupted'));
  assert.match(await readFile(recovered.recordPath, 'utf8'), /서버 종료로 중단/);
}));
