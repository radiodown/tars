import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'tars-review-expansion-'));
process.env.TARS_DATA_DIR = directory;
const { Store, id, now } = await import('../src/store.js');
const { WorkApprovals } = await import('../src/work-approvals.js');
const { SessionInputs, workerProgress } = await import('../src/session-inputs.js');
const { handoffCommand, setHandoff } = await import('../src/session-lifecycle.js');
const { codexThreadAccess, codexTurnAccess, sessionModel } = await import('../src/agent-access.js');
const { readTerminal, createTerminalRecorder } = await import('../src/terminal.js');
const { webState } = await import('../src/web-state.js');
after(() => rmSync(directory, { recursive: true, force: true }));
function fixture(fn) {
  const store = new Store();
  store.db.exec('DELETE FROM records; DELETE FROM work_history;'); store.cache.clear();
  const leader = store.put('members', { name: 'leader', role: 'leader', departmentId: 'department', status: 'idle' });
  const worker = store.put('members', { name: 'worker', role: 'member', departmentId: 'department', status: 'idle' });
  const request = store.put('requests', { title: '기능', instruction: '범위 A', acceptance: '기준 A', projectId: null,
    approvalMode: 'scope', approvalRequired: true, createdBy: leader.id, registeredAt: now() });
  const source = store.put('sessions', { status: 'completed', memberId: leader.id, requestId: request.id, output: '협의안' });
  const task = store.put('tasks', { title: '작업', requestId: request.id, status: 'assigned', acceptance: '성공', departmentId: 'department', assigneeId: worker.id, dependsOn: [] });
  const approvals = new WorkApprovals(store);
  return Promise.resolve().then(() => fn({ store, leader, worker, request, source, task, approvals })).finally(() => store.db.close());
}
test('scope approval survives task decomposition, reassignment and document corrections; scope changes invalidate it', () => fixture(({ store, request, source, task, approvals }) => {
  const approval = approvals.submitPlan(request.id, source.id);
  approvals.respond(request.id, approval.id, { decision: 'approve' });
  store.patch('tasks', task.id, { title: '문구 수정', dependsOn: ['another'] });
  store.put('tasks', { requestId: request.id, title: '세분화한 작업', status: 'draft' });
  store.put('documents', { requestId: request.id, kind: 'agreement', content: '오타 수정', version: 2 });
  assert.equal(approvals.canExecute(request.id), true);
  store.patch('requests', request.id, { acceptance: '기준 B' });
  assert.equal(approvals.canExecute(request.id), false);
}));
test('opt-in task approval still protects the approved task list', () => fixture(({ store, request, source, task, approvals }) => {
  store.patch('requests', request.id, { approvalMode: 'tasks' });
  const approval = approvals.submitPlan(request.id, source.id);
  approvals.respond(request.id, approval.id, { decision: 'approve' });
  store.patch('tasks', task.id, { description: '범위 변경' });
  assert.equal(approvals.canExecute(request.id), false);
}));
test('question answers resume the same execution; stop and recovery close unresolved inputs', () => fixture(async ({ store, source }) => {
  store.patch('sessions', source.id, { status: 'running' });
  const inputs = new SessionInputs(store);
  const pending = inputs.ask(source.id, [{ id: 'answer', question: '진행할까요?' }]);
  assert.equal(store.require('sessions', source.id).status, 'waiting_input');
  const question = store.list('inputRequests')[0];
  assert.throws(() => inputs.answer(question.id, { answers: {} }), /모든 질문/);
  inputs.answer(question.id, { answers: { answer: ['네'] } });
  assert.deepEqual(await pending, { answers: { answer: { answers: ['네'] } } });
  assert.equal(store.require('sessions', source.id).status, 'running');
  const cancelled = inputs.ask(source.id, [{ id: 'answer', question: '다음?' }]);
  const rejection = assert.rejects(cancelled, /실행이 종료/); inputs.cancel(source.id); await rejection;
}));
test('worker progress survives and cannot write another task', () => fixture(({ store, worker, source, task }) => {
  const session = store.patch('sessions', source.id, { kind: 'work', status: 'running', memberId: worker.id, taskId: task.id });
  store.patch('tasks', task.id, { sessionId: session.id });
  workerProgress(store, { actor: worker.id, session }, 'progress', { message: '분석 완료', next: '구현' });
  assert.equal(store.require('tasks', task.id).lastProgress, '분석 완료');
  assert.throws(() => workerProgress(store, { actor: 'another', session }, 'block', { message: '오류' }), /현재 담당/);
}));
test('CLI handoff is quoted, persistent and excludes a running member', () => fixture(({ store, source, leader }) => {
  const session = store.patch('sessions', source.id, { provider: 'codex', codexAccount: 'codex2', workspace: "/tmp/it's a folder", providerSessionId: 'thread' });
  assert.equal(handoffCommand(session), "cd -- '/tmp/it'\\''s a folder' && 'codex2' resume 'thread'");
  setHandoff(store, session.id, true);
  assert.equal(store.require('members', leader.id).handoffSessionId, session.id);
  setHandoff(store, session.id, false);
  store.patch('sessions', session.id, { status: 'running' });
  assert.throws(() => setHandoff(store, session.id, true), /실행을 끝낸/);
}));
test('roles use read-only or scoped workspace writes and model overrides apply by session kind', () => {
  assert.equal(codexThreadAccess({ kind: 'member_chat' }).sandbox, 'read-only');
  assert.equal(codexThreadAccess({ kind: 'work' }).sandbox, 'workspace-write');
  assert.deepEqual(codexTurnAccess({ kind: 'work' }, '/tmp/work').sandboxPolicy.writableRoots, ['/tmp/work']);
  assert.equal(sessionModel({ model: 'base', reasoning: 'high', sessionProfiles: { review: { model: 'review', reasoning: 'medium' } } }, 'task_review').model, 'review');
});
test('terminal pages preserve long output and UTF-8 across byte offsets', async () => {
  const session = { id: id() }, path = join(directory, 'sessions', session.id);
  mkdirSync(path, { recursive: true });
  const raw = '한글🙂'.repeat(5000);
  writeFileSync(join(path, 'terminal.log'), raw);
  let offset = 0, text = '';
  while (offset < Buffer.byteLength(raw)) { const chunk = await readTerminal(session, { offset, limit: 101 }); assert(chunk.nextOffset > offset); offset = chunk.nextOffset; text += chunk.content; }
  assert.equal(text, raw);
  const recorder = createTerminalRecorder(path); recorder.write('OUTPUT', 'x'.repeat(14000)); await recorder.flush();
  const last = await readTerminal(session); assert(last.content.includes('x'.repeat(14000)));
});
test('web lists omit heavy bodies and tokens', () => {
  const state = webState({ sessions: [{ id: 's', output: 'full', processToken: 'secret', request: { big: true } }],
    documents: [{ id: 'd', content: 'body', revisions: [1] }], workApprovals: [{ id: 'a', snapshot: { big: true }, content: 'body' }] });
  assert.equal(state.sessions[0].output, undefined); assert.equal(state.sessions[0].processToken, undefined);
  assert.equal(state.documents[0].content, undefined); assert.equal(state.workApprovals[0].snapshot, undefined);
});

test('scope approval before tasks lets the manager create tasks without a second approval', () => fixture(async ({ store, leader, worker, request, source, task, approvals }) => {
  const { Orchestrator } = await import('../src/orchestrator.js');
  store.delete('tasks', task.id);
  const approval = approvals.submitPlan(request.id, source.id);
  const { job } = approvals.respond(request.id, approval.id, { decision: 'approve' });
  assert(job);
  const followup = store.put('sessions', { memberId: leader.id, kind: 'user_followup', requestId: request.id, workflowJobId: job.id, status: 'running', output: '작업 배정' });
  store.patch('workflowJobs', job.id, { status: 'running', sessionId: followup.id });
  const next = store.put('tasks', { title: '추가 초안', requestId: request.id, status: 'assigned', acceptance: '기준 A', assigneeId: worker.id, departmentId: 'department', dependsOn: [] });
  const orchestrator = new Orchestrator(store);
  orchestrator.finishFollowup(followup);
  assert.equal(store.require('tasks', next.id).status, 'queued');
  assert.equal(store.require('requests', request.id).pendingApprovalId, null);
  assert.equal(store.list('workApprovals').length, 1);
}));
test('blocked report exposes retry and stop without marking work accepted', () => fixture(({ store, request, source, task, approvals }) => {
  const plan = approvals.submitPlan(request.id, source.id); approvals.respond(request.id, plan.id, { decision: 'approve' });
  store.patch('tasks', task.id, { status: 'blocked' });
  const reportSource = store.put('sessions', { memberId: source.memberId, requestId: request.id, kind: 'request_escalation', status: 'completed' });
  const document = store.put('documents', { title: '차단', content: '일시 장애', version: 1 });
  const report = approvals.submitReport(request.id, reportSource.id, document.id);
  approvals.respond(request.id, report.id, { decision: 'retry' });
  assert.equal(store.require('tasks', task.id).status, 'queued');
  assert.equal(store.require('requests', request.id).status, 'open');
  store.patch('tasks', task.id, { status: 'blocked' });
  const next = approvals.submitReport(request.id, reportSource.id, document.id);
  approvals.respond(request.id, next.id, { decision: 'stop' });
  assert.equal(store.require('requests', request.id).paused, true);
  assert.notEqual(store.require('requests', request.id).status, 'accepted');
}));
test('Claude file writes cannot escape through symlinks or a new parent path', async () => {
  const { guardFileWrite } = await import('../src/claude-sandbox.js');
  const { symlink, mkdir } = await import('node:fs/promises');
  const root = join(directory, 'guard-work'), outside = join(directory, 'guard-outside');
  await mkdir(root); await mkdir(outside); await symlink(outside, join(root, 'escape'));
  const input = file_path => ({ tool_name: 'Write', tool_input: { file_path } });
  assert.deepEqual(await guardFileWrite(input('nested/new.txt'), { kind: 'work' }, root), {});
  assert.equal((await guardFileWrite(input('escape/file.txt'), { kind: 'work' }, root)).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await guardFileWrite(input('../outside.txt'), { kind: 'work' }, root)).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await guardFileWrite(input('allowed.txt'), { kind: 'member_chat' }, root)).hookSpecificOutput.permissionDecision, 'deny');
});

test('later manager task decomposition queues within approved scope without another approval', () => fixture(async ({ store, leader, worker, request, source, task, approvals }) => {
  const { Orchestrator } = await import('../src/orchestrator.js');
  const approval = approvals.submitPlan(request.id, source.id); approvals.respond(request.id, approval.id, { decision: 'approve' });
  const next = store.put('tasks', { title: '추가 작업', requestId: request.id, status: 'assigned', assigneeId: worker.id, acceptance: '기준 A', dependsOn: [] });
  const orchestrator = new Orchestrator(store);
  assert.equal(approvals.submitPlan(request.id, source.id), null);
  orchestrator.queueApprovedDrafts(request.id, leader.id);
  assert.equal(store.require('tasks', next.id).status, 'queued');
  assert.equal(store.list('workApprovals').length, 1);
  store.patch('requests', request.id, { acceptance: '다른 범위' });
  const blocked = store.put('tasks', { title: '범위 밖', requestId: request.id, status: 'assigned', assigneeId: worker.id, acceptance: '다른 범위', dependsOn: [] });
  orchestrator.queueApprovedDrafts(request.id, leader.id);
  assert.equal(store.require('tasks', blocked.id).status, 'assigned');
}));
test('read-only Claude commands retain actual exit status without writing cwd tracking files', async () => {
  const { readOnlyCommand } = await import('../src/claude-sandbox.js');
  const { spawnSync } = await import('node:child_process');
  for (const status of [0, 7]) {
    const hook = readOnlyCommand({ tool_name: 'Bash', tool_input: { command: `sh -c 'exit ${status}'` } }, { kind: 'task_review' });
    const command = hook.hookSpecificOutput.updatedInput.command;
    // Equivalent to the CLI's eval-command && pwd-tracking shell sequence.
    const result = spawnSync('bash', ['-c', 'eval "$1" && printf UNEXPECTED_WRITE', 'bash', command], { encoding: 'utf8' });
    assert.equal(result.status, status); assert.equal(result.stdout, '');
  }
});

test('blocked report rescope retries are idempotent and schedule only one follow-up', () => fixture(({ store, request, source, task, approvals }) => {
  const plan = approvals.submitPlan(request.id, source.id); approvals.respond(request.id, plan.id, { decision: 'approve' });
  store.patch('tasks', task.id, { status: 'blocked' });
  const reportSource = store.put('sessions', { memberId: source.memberId, requestId: request.id, kind: 'request_escalation', status: 'completed' });
  const document = store.put('documents', { title: '차단', content: '기준 조정 필요', version: 1 });
  const report = approvals.submitReport(request.id, reportSource.id, document.id);
  const first = approvals.respond(request.id, report.id, { decision: 'rescope', comment: '완료 기준을 재협의하세요.' });
  const second = approvals.respond(request.id, report.id, { decision: 'rescope', comment: '완료 기준을 재협의하세요.' });
  assert.equal(second.job.id, first.job.id);
  assert.equal(store.require('requests', request.id).status, 'revision_requested');
}));

test('progress and associated activity emit only a committed session delta', () => fixture(async ({ store, source }) => {
  const { saveSessionActivity, readSessionActivity } = await import('../src/session-activity.js');
  store.patch('sessions', source.id, { status: 'waiting_input' });
  let changes = 0, updates = 0;
  store.on('change', () => changes++);
  store.on('session-progress', () => { updates++; assert.equal(store.require('sessions', source.id).progress, '사용자 답변 대기'); });
  store.patchProgress(source.id, () => ({ progress: '사용자 답변 대기', ...saveSessionActivity(store, source.id,
    { items: [{ id: 'tool', status: 'running' }], omitted: 0, revision: 1, current: 'tool' }) }));
  assert.equal(changes, 0); assert.equal(updates, 1);
  assert.equal(readSessionActivity(store, source.id).items[0].status, 'running');
}));
