import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'tars-work-approvals-'));
process.env.TARS_DATA_DIR = directory;
const { Store, now } = await import('../src/store.js');
const { Orchestrator } = await import('../src/orchestrator.js');
const { TaskWorkflow } = await import('../src/task-workflow.js');
const { continuationSource } = await import('../src/session-continuation.js');
const { ACCESS_VERSION } = await import('../src/agent-access.js');
const { renderTaskRecord } = await import('../src/work-records.js');
after(() => rmSync(directory, { recursive: true, force: true }));

async function fixture(run) {
  const store = new Store();
  store.db.exec('DELETE FROM records; DELETE FROM work_history;');
  store.put('settings', { id: 'main', maxConcurrent: 2, maxSessionMinutes: 1 });
  const department = store.put('departments', { name: '개발팀' });
  const create = role => store.put('members', { role, name: role, departmentId: role === 'ceo' ? null : department.id,
    provider: 'claude', model: '', reasoning: 'default', status: 'idle' });
  const leader = create('leader'), worker = create('member'), ceo = create('ceo');
  const source = store.put('sessions', { memberId: leader.id, departmentId: department.id, projectId: null, kind: 'plan',
    provider: 'claude', status: 'completed', startedAt: now(), endedAt: now(), prompt: '업무 구현을 협의하자', output: '정리한 협의안' });
  const workflow = new TaskWorkflow(store);
  const request = workflow.request('협의 범위 구현', null, leader.id, { registeredAt: now(), approvalRequired: true, sourceSessionId: source.id });
  store.patch('sessions', source.id, { requestId: request.id });
  const doc = store.put('documents', { kind: 'agreement', title: '협의 문서', content: '합의할 범위 A', version: 1, revisions: [], requestId: request.id, projectId: null });
  const task = workflow.attachTask({ title: '기능 구현', description: '범위 A 구현', acceptance: '기준 A 통과', departmentId: department.id,
    projectId: null, assigneeId: worker.id, documentIds: [doc.id], dependsOn: [], isolation: 'personal' }, leader.id, request.id);
  const approval = workflow.approvals.submitPlan(request.id, source.id);
  const respond = (decision, comment = '') => workflow.approvals.respond(request.id, approval.id, { decision, comment });
  const calls = [];
  const orchestrator = new Orchestrator(store, { launchRun: async ({ session, prompt, onSpawn }) => {
    calls.push({ session, prompt }); onSpawn(null);
    return { cancel() {}, promise: Promise.resolve({ output: '사용자 응답을 반영했습니다.', providerSessionId: 'fake-provider-session' }) };
  } });
  const deliver = async () => { await orchestrator.pumpJobs(); await Promise.all([...orchestrator.active.values()].map(value => value.promise)); };
  const report = ({ blocked = false } = {}) => {
    store.patch('tasks', task.id, { status: blocked ? 'blocked' : 'done' });
    const session = store.put('sessions', { memberId: ceo.id, departmentId: null, projectId: null, kind: 'request_report',
      provider: 'claude', status: 'completed', requestId: request.id, output: '최종 결과', prompt: '원래 결과 보고', startedAt: now() });
    const document = store.put('documents', { title: '최종 보고', kind: 'report', content: '완료된 결과와 증거', requestId: request.id,
      projectId: null, version: 1, revisions: [], sessionId: session.id });
    store.patch('requests', request.id, { reportDocumentId: document.id });
    return workflow.approvals.submitReport(request.id, session.id, document.id);
  };
  try { await run({ store, workflow, request, leader, worker, ceo, source, doc, task, approval, respond, orchestrator, calls, deliver, report }); }
  finally { await orchestrator.shutdown(); store.db.close(); }
}

test('pending consultation blocks both run requests and tasks already in the queue', () => fixture(async ({ store, request, workflow, task, orchestrator, calls }) => {
  assert.equal(store.get('requests', request.id).status, 'awaiting_approval');
  assert.throws(() => workflow.queueTask(task.id), /사용자 승인/);
  store.patch('tasks', task.id, { status: 'queued' });
  await orchestrator.pump();
  assert.equal(calls.length, 0);
  assert.equal(store.get('tasks', task.id).status, 'queued');
}));

test('only the user can respond, and a live source or empty feedback cannot be submitted', () => fixture(({ store, workflow, request, approval, source, leader, respond }) => {
  assert.throws(() => workflow.approvals.respond(request.id, approval.id, { decision: 'approve' }, leader.id), /사용자만/);
  assert.throws(() => respond('feedback'), /추가 의견/);
  store.patch('sessions', source.id, { status: 'running' });
  assert.throws(() => respond('approve'), /정상 종료/);
  store.patch('sessions', source.id, { status: 'failed' });
  assert.throws(() => respond('approve'), /정상 종료되지 않은/);
  assert.equal(respond('feedback', '실패한 응답을 확인하고 협의안을 다시 정리해줘').job.status, 'queued');
}));

test('changed documents reject stale approval but preserve the reviewed copy and allow revision feedback', () => fixture(({ store, doc, approval, respond }) => {
  store.patch('documents', doc.id, { content: '새 범위 B', version: 2 });
  assert.throws(() => respond('approve'), /변경되었습니다/);
  assert.equal(store.get('workApprovals', approval.id).snapshot.documents[0].content, '합의할 범위 A');
  const value = respond('feedback', '바뀐 내용을 다시 정리해줘');
  assert.equal(value.job.status, 'queued');
  assert.equal(respond('feedback', '바뀐 내용을 다시 정리해줘').job.id, value.job.id);
  assert.equal(store.list('workflowJobs').length, 1);
  assert.throws(() => respond('approve'), /이미 처리/);
}));

test('feedback waits for its original manager and returns as a new approval version with an immutable trail', () => fixture(async ({ store, leader, source, request, approval, respond, deliver, calls, task }) => {
  const { job } = respond('feedback', '범위를 줄이고 검증 방법을 명확히 해줘');
  store.patch('members', leader.id, { status: 'running' });
  await deliver();
  assert.equal(calls.length, 0);
  assert.equal(store.get('workflowJobs', job.id).status, 'queued');
  store.patch('members', leader.id, { status: 'idle' });
  await deliver();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].session.memberId, leader.id);
  assert.equal(calls[0].session.continuationOf, source.id);
  const session = store.get('sessions', calls[0].session.id);
  const context = JSON.parse(await readFile(session.feedbackPath, 'utf8'));
  assert.equal(context.original.sessionId, source.id);
  assert.equal(context.approval.response.comment, '범위를 줄이고 검증 방법을 명확히 해줘');
  const next = store.get('workApprovals', store.get('requests', request.id).pendingApprovalId);
  assert.equal(next.version, 2);
  assert.equal(next.sourceSessionId, session.id);
  assert.equal(store.get('workApprovals', approval.id).status, 'feedback');
  assert.match(renderTaskRecord(store, task.id), /범위를 줄이고 검증 방법/);
  assert.equal(store.get('tasks', task.id).status, 'assigned');
}));

test('plan approval dispatches its manager then queues only the approved tasks', () => fixture(async ({ store, task, request, respond, deliver, calls }) => {
  const { job } = respond('approve');
  assert.equal(store.get('tasks', task.id).status, 'assigned');
  await deliver();
  assert.equal(calls.length, 1);
  assert.equal(store.get('workflowJobs', job.id).status, 'done');
  assert.equal(store.get('requests', request.id).pendingApprovalId, null);
  assert.equal(store.get('tasks', task.id).status, 'queued');
}));

test('a scope change after approval prevents execution and requires a new consultation', () => fixture(({ store, task, workflow, respond }) => {
  respond('approve');
  store.patch('tasks', task.id, { acceptance: '새 기준 B' });
  assert.throws(() => workflow.queueTask(task.id), /사용자 승인/);
}));

test('report acceptance closes the work and sends its author an acknowledgement turn', () => fixture(async ({ store, workflow, request, report, deliver, calls }) => {
  const approval = report();
  assert.equal(store.get('requests', request.id).status, 'awaiting_acceptance');
  const { job } = workflow.approvals.respond(request.id, approval.id, { decision: 'approve', comment: '결과 확인했어' });
  await deliver();
  assert.equal(store.get('requests', request.id).status, 'accepted');
  assert.equal(store.get('requests', request.id).acceptedApprovalId, approval.id);
  assert.equal(calls[0].session.continuationOf, approval.sourceSessionId);
  assert.equal(calls[0].session.memberId, approval.memberId);
  assert.equal(store.get('workflowJobs', job.id).status, 'done');
  workflow.reconcile();
  assert.equal(store.list('workflowJobs').length, 1);
}));

test('acknowledging a blocked report never marks unfinished work complete', () => fixture(async ({ store, workflow, request, report, deliver, task }) => {
  const approval = report({ blocked: true });
  assert.equal(approval.snapshot.report.final, false);
  workflow.approvals.respond(request.id, approval.id, { decision: 'approve' });
  await deliver();
  assert.equal(store.get('requests', request.id).status, 'blocked');
  assert.equal(store.get('tasks', task.id).status, 'blocked');
  assert.equal(store.get('requests', request.id).acceptedAt, undefined);
}));

test('report feedback produces a new report to review, without falsely completing work', () => fixture(async ({ store, workflow, request, report, deliver, task }) => {
  const approval = report();
  workflow.approvals.respond(request.id, approval.id, { decision: 'feedback', comment: '검증 결과를 더 설명해줘' });
  assert.throws(() => workflow.queueTask(task.id), /사용자 승인/);
  await deliver();
  const current = store.get('requests', request.id);
  const next = store.get('workApprovals', current.pendingApprovalId);
  assert.equal(current.status, 'awaiting_acceptance');
  assert.equal(next.kind, 'report');
  assert.equal(next.version, 2);
  assert.notEqual(next.snapshot.report.id, approval.snapshot.report.id);
}));

test('queued responses survive recovery; cancelled responses run only after explicit retry', () => fixture(async ({ store, workflow, request, respond, deliver, calls }) => {
  const { job } = respond('feedback', '다시 검토해줘');
  workflow.recover();
  assert.equal(store.get('workflowJobs', job.id).status, 'queued');
  workflow.pauseRequest(request.id);
  await deliver();
  assert.equal(calls.length, 0);
  workflow.retryJob(job.id);
  await deliver();
  assert.equal(calls.length, 1);
}));

test('recovery exposes saved proposals once without creating approval or launching a provider', () => fixture(({ store, workflow, request, approval, calls }) => {
  store.delete('workApprovals', approval.id);
  store.patch('requests', request.id, { pendingApprovalId: null, approvalRequired: false, status: 'open' });
  workflow.recover(); workflow.recover();
  const items = store.list('workApprovals');
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'pending');
  assert.equal(items[0].restored, true);
  assert.equal(items[0].response, undefined);
  assert.equal(calls.length, 0);
  assert.equal(store.list('workflowJobs').length, 0);
}));

test('native continuation selects the cited session, never a newer unrelated conversation', () => fixture(({ store, leader }) => {
  const scope = { memberId: leader.id, provider: 'codex', codexAccount: 'codex2', projectId: null,
    workspace: '/fixture', model: 'model', reasoning: 'high', accessVersion: ACCESS_VERSION, status: 'completed' };
  const source = store.put('sessions', { ...scope, kind: 'plan', providerSessionId: 'original-thread' });
  store.put('sessions', { ...scope, kind: 'plan', providerSessionId: 'unrelated-thread' });
  const current = { ...scope, kind: 'user_followup', continuationOf: source.id };
  assert.equal(continuationSource(store, current, '/fixture').providerSessionId, 'original-thread');
  assert.equal(continuationSource(store, { ...current, codexAccount: 'codex' }, '/fixture'), null);
  assert.equal(continuationSource(store, current, '/other-workspace'), null);
}));

test('manager-only work returns a report for user acceptance after plan approval', () => fixture(async ({ store, workflow, request, source, task, deliver }) => {
  store.delete('tasks', task.id);
  const approval = workflow.approvals.submitPlan(request.id, source.id, { force: true });
  workflow.approvals.respond(request.id, approval.id, { decision: 'approve' });
  await deliver();
  const work = store.get('requests', request.id);
  assert.equal(work.status, 'awaiting_acceptance');
  assert.equal(store.get('workApprovals', work.pendingApprovalId).kind, 'report');
}));

test('failed continuation requires explicit retry and preserves the previous attempt in fresh context', () => fixture(async ({ store, workflow, respond, orchestrator, deliver, calls }) => {
  const original = orchestrator.launchRun;
  orchestrator.launchRun = async () => ({ cancel() {}, promise: Promise.resolve({ output: '일부 확인', failure: 'resume unavailable' }) });
  const { job } = respond('feedback', '다시 설명해줘');
  await deliver();
  const failed = store.get('workflowJobs', job.id);
  assert.equal(failed.status, 'blocked');
  await deliver();
  assert.equal(store.get('workflowJobs', job.id).sessionId, failed.sessionId);
  orchestrator.launchRun = original;
  workflow.retryJob(job.id);
  await deliver();
  assert.equal(calls[0].session.freshContinuation, true);
  const session = store.get('sessions', calls[0].session.id);
  const context = JSON.parse(await readFile(session.feedbackPath, 'utf8'));
  assert.equal(context.previousAttempt.sessionId, failed.sessionId);
  assert.equal(context.previousAttempt.error, 'resume unavailable');
}));

test('Claude launch resumes the specified provider session instead of the latest directory session', async () => {
  const { launch } = await import('../src/providers.js');
  const binary = join(directory, 'fake-claude.mjs');
  const argsPath = join(directory, 'claude-args.json');
  await writeFile(binary, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdin.resume();\nprocess.stdin.on('end', () => process.stdout.write(JSON.stringify({type:'result', result:'후속 응답', session_id:'original-claude'})+'\\n'));\n`, { mode: 0o700 });
  const previous = process.env.TARS_CLAUDE_BIN;
  process.env.TARS_CLAUDE_BIN = binary;
  try {
    const handle = await launch({ session: { id: 'claude-continuation', provider: 'claude', kind: 'user_followup', resumeClaudeId: 'original-claude', processToken: 'test-only' },
      member: { name: '팀장', provider: 'claude', model: '', reasoning: 'default' }, cwd: directory, prompt: '사용자 의견', minutes: 1, onEvent() {}, onSpawn() {} });
    const result = await handle.promise;
    assert.equal(result.failure, null);
    assert.equal(result.providerSessionId, 'original-claude');
    const args = JSON.parse(await readFile(argsPath, 'utf8'));
    assert.equal(args[args.indexOf('--resume') + 1], 'original-claude');
    assert(!args.includes('--continue'));
  } finally { if (previous === undefined) delete process.env.TARS_CLAUDE_BIN; else process.env.TARS_CLAUDE_BIN = previous; }
});
