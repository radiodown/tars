import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'tars-registration-'));
process.env.TARS_DATA_DIR = directory;
const { Store, now } = await import('../src/store.js');
const { Orchestrator } = await import('../src/orchestrator.js');
const { CEO_ID } = await import('../src/ceo.js');
const { managementSnapshot } = await import('../src/work-records.js');
after(() => rmSync(directory, { recursive: true, force: true }));

function fixture(run) {
  const store = new Store();
  store.db.exec('DELETE FROM records; DELETE FROM work_history;');
  store.put('settings', { id: 'main', maxConcurrent: 4 });
  const department = store.put('departments', { name: '개발' });
  const member = (role, extra = {}) => store.put('members', { role, name: role,
    departmentId: department.id, provider: 'claude', status: 'idle', ...extra });
  const ceo = member('ceo', { id: CEO_ID, departmentId: null });
  const leader = member('leader'), worker = member('member');
  const orchestrator = new Orchestrator(store);
  // Exercise registration boundaries without launching providers or mutating live data.
  orchestrator.run = async () => {};
  const workflow = orchestrator.workflow;
  const chat = () => orchestrator.chat({ prompt: '현재 상태 알려줘', projectId: null });
  const consult = () => orchestrator.consult({ leaderId: leader.id, prompt: '이 구조가 어떻게 돼?', projectId: null });
  const registration = { title: '업무 기록 개선', instruction: '등록한 업무별로 기록과 결과를 묶는다', projectId: null, acceptance: '업무별 기록 확인',
    progressPlan: { summary: '업무별 기록 정리', goal: '기록 개선 2건 검토', goals: [{ id: 'records', title: '기록 개선', target: 2, unit: '건', weight: 100, acceptance: '기록 확인' }] } };
  try { run({ store, orchestrator, workflow, ceo, leader, worker, chat, consult, registration }); }
  finally { store.db.close(); }
}

test('CEO and leader conversation starts do not create work', () => fixture(({ store, chat, consult }) => {
  chat(); consult();
  assert.equal(store.list('sessions').length, 2);
  assert.equal(store.list('requests').length, 0);
}));

test('only an active manager can register work and follow-ups reuse its ID', () => fixture(({ store, workflow, chat, ceo, worker, registration }) => {
  const session = chat();
  assert.throws(() => workflow.registerRequest(registration, { actor: 'user', session: null }), /팀장 또는 CEO/);
  const workerSession = store.put('sessions', { memberId: worker.id, status: 'running', projectId: null });
  assert.throws(() => workflow.registerRequest(registration, { actor: worker.id, session: workerSession }), /팀장 또는 CEO/);
  const request = workflow.registerRequest(registration, { actor: ceo.id, session });
  assert.equal(request.createdBy, ceo.id);
  assert.equal(request.sourceSessionId, session.id);
  assert(request.registeredAt);
  const later = store.put('sessions', { memberId: ceo.id, kind: 'ceo_chat', status: 'running', projectId: null });
  const linked = workflow.registerRequest({ ...registration, requestId: request.id }, { actor: ceo.id, session: later });
  assert.equal(linked.id, request.id);
  assert.equal(store.list('requests').length, 1);
  assert.deepEqual(store.get('sessions', later.id).requestIds, [request.id]);
  store.patch('sessions', later.id, { status: 'completed' });
  assert.throws(() => workflow.registerRequest(registration, { actor: ceo.id, session: later }), /팀장 또는 CEO/);
}));

test('leader answers remain conversations; deliberate plans register documents and tasks under one work item', () => fixture(({ store, orchestrator, leader, worker, consult, registration }) => {
  const session = consult();
  const plain = { summary: '구조에 대한 답변', work: null, agreement: '', specification: '', tasks: [] };
  orchestrator.applyPlan(session, leader, plain);
  assert.equal(store.list('requests').length, 0);
  assert.equal(store.list('documents').length, 0);
  assert.throws(() => orchestrator.applyPlan(session, leader, { ...plain, agreement: '자동 생성하면 안 됨' }), /등록할 업무/);
  orchestrator.applyPlan(session, leader, { ...plain, work: { title: registration.title, instruction: registration.instruction, acceptance: registration.acceptance, progressPlan: registration.progressPlan, requestId: null },
    agreement: '목표와 범위', specification: '구현 설계', tasks: [{ title: '구현', description: '업무 경계 구현', acceptance: '대화 제외', goalId: 'records', plannedUnits: 1, assigneeId: worker.id, dependsOn: [] }] });
  const [request] = store.list('requests');
  assert.equal(request.createdBy, leader.id);
  assert.equal(store.list('tasks')[0].requestId, request.id);
  assert(store.list('documents').every(doc => doc.requestId === request.id));
  orchestrator.applyPlan(session, leader, { ...plain, work: { title: request.title, instruction: request.instruction, requestId: request.id } });
  assert.equal(store.list('requests').length, 1);
  store.patch('requests', request.id, { status: 'reported', reportDocumentId: 'previous-report' });
  orchestrator.applyPlan(session, leader, { ...plain, work: { title: request.title, instruction: request.instruction, requestId: request.id },
    tasks: [{ title: '추가 구현', description: '후속 작업', acceptance: '후속 결과', goalId: 'records', plannedUnits: 1, assigneeId: worker.id, dependsOn: [] }] });
  assert.equal(store.list('requests').length, 1);
  assert.equal(store.get('requests', request.id).status, 'awaiting_approval');
  assert.equal(store.get('requests', request.id).reportDocumentId, null);
  assert.equal(store.list('tasks').length, 2);
}));

test('stopping a manager conversation pauses each work item it registered', () => fixture(({ store, orchestrator, workflow, chat, ceo, registration }) => {
  const session = chat();
  const identity = { actor: ceo.id, session };
  const first = workflow.registerRequest(registration, identity);
  const second = workflow.registerRequest({ ...registration, title: '별도 업무' }, identity);
  orchestrator.stop(session.id);
  assert.equal(store.get('requests', first.id).paused, true);
  assert.equal(store.get('requests', second.id).paused, true);
}));

test('task creation requires a registered work item and conversation-only records are absent from manager results', () => fixture(({ store, workflow, ceo, leader, registration }) => {
  const chat = store.put('sessions', { memberId: leader.id, status: 'completed', kind: 'plan', startedAt: now(), output: '일반 대화' });
  const conversation = workflow.request('일반 대화', null, 'user', { sourceSessionId: chat.id });
  store.patch('sessions', chat.id, { requestId: conversation.id });
  assert.throws(() => workflow.attachTask({ title: '작업', projectId: null }, leader.id), /먼저 팀장/);
  assert.throws(() => workflow.attachTask({ title: '작업', projectId: null }, leader.id, conversation.id), /대화 기록/);
  const snapshot = managementSnapshot(store, ceo);
  assert.equal(snapshot.requests.length, 0);
  assert.equal(snapshot.recentExecutions.length, 0);
  assert.equal(snapshot.members.find(member => member.id === leader.id).latest, null);
}));

test('deleting work retires pending steps and keeps execution and result records', () => fixture(({ store, workflow, leader }) => {
  const source = store.put('sessions', { status: 'running', memberId: leader.id, kind: 'member_chat' });
  const request = workflow.request('업무', null, leader.id, { registeredAt: now(), sourceSessionId: source.id });
  const task = store.put('tasks', { requestId: request.id, status: 'queued', dependsOn: [] });
  const done = store.put('tasks', { requestId: request.id, status: 'done', dependsOn: [], acceptedReportId: 'report' });
  const report = store.put('taskReports', { id: 'report', taskId: done.id });
  const job = store.put('workflowJobs', { taskId: task.id, status: 'queued' });
  const approval = store.put('workApprovals', { requestId: request.id, status: 'pending' });
  store.patch('requests', request.id, { pendingApprovalId: approval.id });
  const document = store.put('documents', { requestId: request.id, content: '저장된 문서' });
  const active = new Map(), operations = new Set();

  assert.throws(() => workflow.deleteRequest(request.id, active, operations), /연결된 실행/);
  store.patch('sessions', source.id, { status: 'completed' });
  active.set(source.id, {});
  assert.throws(() => workflow.deleteRequest(request.id, active, operations), /연결된 실행/);
  active.clear();
  const dependent = store.put('tasks', { status: 'assigned', dependsOn: [task.id, done.id] });
  assert.throws(() => workflow.deleteRequest(request.id, active, operations), /선행 작업/);
  store.patch('tasks', dependent.id, { dependsOn: [done.id] });
  const deleted = workflow.deleteRequest(request.id, active, operations);

  assert(deleted.deletedAt);
  assert.equal(store.get('requests', request.id).pendingApprovalId, null);
  assert.deepEqual(workflow.deleteRequest(request.id, active, operations), deleted);
  assert.equal(store.get('tasks', task.id).status, 'cancelled');
  assert.equal(store.get('tasks', done.id).status, 'done');
  assert.equal(store.get('workflowJobs', job.id).status, 'superseded');
  assert.equal(store.get('workApprovals', approval.id).status, 'superseded');
  assert.deepEqual(store.get('taskReports', report.id), report);
  assert.deepEqual(store.get('documents', document.id), document);
  assert.equal(store.get('sessions', source.id).status, 'completed');
  assert.throws(() => workflow.resumeRequest(request.id), /삭제된 업무/);
  assert.throws(() => workflow.requireWork(request.id, null), /삭제된 업무/);
  assert.throws(() => workflow.approvals.respond(request.id, approval.id, { decision: 'approve' }), /삭제된 업무/);
  workflow.reconcile();
  workflow.approvals.recover();
  assert.equal(store.list('workflowJobs').length, 1);
  assert.equal(store.list('workApprovals').length, 1);
}));

test('legacy task-backed work is deletable, while unrelated chat requests are retained', () => fixture(({ store, workflow }) => {
  const legacy = workflow.request('이전 업무');
  const chatRequest = workflow.request('일반 대화');
  store.put('tasks', { requestId: legacy.id, status: 'draft', dependsOn: [] });
  assert(workflow.deleteRequest(legacy.id, new Map(), new Set()).deletedAt);
  assert.throws(() => workflow.deleteRequest(chatRequest.id, new Map(), new Set()), { statusCode: 404 });
  assert.equal(store.get('requests', chatRequest.id).deletedAt, undefined);
}));

test('deleting a task retires its pending work while preserving history and completed dependencies', () => fixture(({ store, orchestrator, workflow }) => {
  const request = workflow.request('업무');
  const task = store.put('tasks', { requestId: request.id, status: 'review' });
  const done = store.put('tasks', { requestId: request.id, status: 'done', acceptedReportId: 'accepted' });
  const run = store.put('sessions', { taskId: task.id, kind: 'work', status: 'waiting_input', providerSessionId: 'provider', workspace: '/tmp' });
  store.patch('tasks', task.id, { sessionId: run.id });
  const job = store.put('workflowJobs', { taskId: task.id, status: 'blocked' });
  const report = store.put('taskReports', { taskId: task.id, sessionId: run.id });
  const dependent = store.put('tasks', { status: 'assigned', dependsOn: [task.id, done.id] });
  const active = new Map(), operations = new Set();

  assert.throws(() => workflow.deleteTask(task.id, active, operations), /관련 실행/);
  store.patch('sessions', run.id, { status: 'completed' });
  active.set(run.id, {});
  assert.throws(() => workflow.deleteTask(task.id, active, operations), /관련 실행/);
  active.clear();
  operations.add(task.id);
  assert.throws(() => workflow.deleteTask(task.id, active, operations), /작업 검토/);
  operations.clear();
  assert.throws(() => workflow.deleteTask(task.id, active, operations), /선행 작업/);
  store.patch('tasks', dependent.id, { dependsOn: [done.id] });

  const deleted = workflow.deleteTask(task.id, active, operations);
  assert(deleted.deletedAt);
  assert.deepEqual(workflow.deleteTask(task.id, active, operations), deleted);
  assert.equal(store.get('tasks', task.id).status, 'cancelled');
  assert.equal(store.get('workflowJobs', job.id).status, 'superseded');
  assert.deepEqual(store.get('taskReports', report.id), report);
  assert.equal(store.get('sessions', run.id).status, 'completed');
  assert.equal(store.history('tasks', task.id).events.filter(event => event.event === 'deleted').length, 1);
  assert.throws(() => orchestrator.continueSession(run.id, '재개'), /삭제된 작업/);

  assert(workflow.deleteTask(done.id, active, operations).deletedAt);
  assert.equal(store.get('tasks', done.id).status, 'done');
  assert.equal(store.get('tasks', done.id).acceptedReportId, 'accepted');
  assert.deepEqual(store.get('tasks', dependent.id).dependsOn, [done.id]);
  assert.deepEqual(store.get('requests', request.id), request);
}));
