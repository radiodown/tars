import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'tars-workflow-'));
process.env.TARS_DATA_DIR = directory;
const { Store, id, now } = await import('../src/store.js');
const { TaskWorkflow } = await import('../src/task-workflow.js');
const { Orchestrator } = await import('../src/orchestrator.js');
const { executionIdentity, assertTaskActor } = await import('../src/agent-identity.js');
const { renderTaskRecord, WorkStatusFiles } = await import('../src/work-records.js');
const { taskRecordPath } = await import('../src/task-artifacts.js');
const { contextFor } = await import('../src/workspaces.js');
after(() => rmSync(directory, { recursive: true, force: true }));

const result = (summary = '구현 결과') => ({ summary, workPerformed: ['파일 수정'],
  artifacts: [{ path: 'result.txt', description: '결과 파일' }],
  verification: [{ criterion: '정상 결과 파일', status: 'passed', evidence: 'result.txt 확인' }], remaining: [], followUp: [] });
const verdict = (decision = 'accepted') => ({ decision, rationale: '완료 기준과 파일 내용 대조',
  checks: [{ criterion: '정상 결과 파일', status: decision === 'accepted' ? 'passed' : 'failed', evidence: 'result.txt의 내용을 직접 확인' }],
  reworkInstructions: decision === 'rework' ? '결과 파일의 오류를 수정하세요.' : '', knowledge: ['검토된 결론 · 해당 프로젝트에만 적용'] });

async function fixture(run) {
  const store = new Store();
  store.db.exec('DELETE FROM records; DELETE FROM work_history;');
  store.put('settings', { id: 'main', maxConcurrent: 2, maxSessionMinutes: 1, maxReworkAttempts: 2 });
  const department = store.put('departments', { name: '개발' });
  const member = role => store.put('members', { name: role, role, departmentId: role === 'ceo' ? null : department.id,
    provider: 'claude', model: '', reasoning: 'default', status: 'idle', instructions: '', specialty: '' });
  const ceo = member('ceo'), leader = member('leader'), worker = member('member');
  const workflow = new TaskWorkflow(store);
  const request = workflow.request('결과 파일 작성', null, leader.id, { registeredAt: now(), departmentId: department.id });
  const task = workflow.attachTask({ title: '작업', description: '결과 파일 작성', acceptance: '정상 결과 파일', projectId: null,
    departmentId: department.id, assigneeId: worker.id, isolation: 'personal', dependsOn: [], documentIds: [] }, leader.id, request.id);
  const workspace = join(directory, 'fixtures', task.id);
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'result.txt'), '정상 결과');
  store.patch('tasks', task.id, { workspace });
  const start = () => {
    const session = store.put('sessions', { kind: 'work', taskId: task.id, requestId: task.requestId, memberId: worker.id,
      status: 'running', startedAt: now(), processToken: id(), provider: 'claude' });
    store.patch('tasks', task.id, { status: 'running', sessionId: session.id });
    return session;
  };
  try { await run({ store, workflow, task, workspace, worker, leader, ceo, start }); }
  finally { store.db.close(); }
}

test('submission atomically saves an immutable result, task state, history and one review job', () => fixture(async ({ store, workflow, task, start }) => {
  const session = start();
  const report = await workflow.submit(session, result());
  assert.equal((await workflow.submit(session, result('중복 응답'))).id, report.id);
  assert.equal(store.list('taskReports').length, 1);
  assert.equal(store.list('workflowJobs').length, 1);
  assert.equal(store.get('tasks', task.id).status, 'review');
  assert.equal(store.get('tasks', task.id).acceptedReportId, null);
  assert(store.history('tasks', task.id).events.some(event => event.event === 'submitted' && event.actor === session.memberId));
}));

test('a failed enqueue rolls back the result and task transition together', () => fixture(async ({ store, workflow, task, start }) => {
  const session = start();
  workflow.job = () => { throw new Error('queue storage failure'); };
  await assert.rejects(workflow.submit(session, result()), /queue storage failure/);
  assert.equal(store.list('taskReports').length, 0);
  assert.equal(store.get('tasks', task.id).status, 'running');
  assert(!store.history('tasks', task.id).events.some(event => event.event === 'submitted'));
}));

test('acceptance preserves reviewer identity, adopted version and scoped reusable knowledge', () => fixture(async ({ store, workflow, task, leader, worker, start }) => {
  const session = start();
  const report = await workflow.submit(session, result());
  await assert.rejects(workflow.review(task.id, report.id, verdict(), worker.id), /검토자/);
  const reviewed = await workflow.review(task.id, report.id, verdict(), leader.id);
  assert.equal(store.get('tasks', task.id).acceptedReportId, report.id);
  assert.equal(reviewed.artifactHash, report.artifacts.hash);
  assert.equal(store.list('documents')[0].sourceReviewId, reviewed.id);
  assert.match(renderTaskRecord(store, task.id), /채택됨/);
  assert.equal((await workflow.review(task.id, report.id, verdict(), leader.id)).id, reviewed.id);
  await assert.rejects(workflow.review(task.id, report.id, verdict('rework'), leader.id), /이미 검토/);
}));

test('changed artifact or specification cannot be approved using an old result', () => fixture(async ({ store, workflow, task, leader, workspace, start }) => {
  const report = await workflow.submit(start(), result());
  await writeFile(join(workspace, 'result.txt'), '검토 중 변경');
  await assert.rejects(workflow.review(task.id, report.id, verdict(), leader.id), /산출물이 변경/);
  await writeFile(join(workspace, 'result.txt'), '정상 결과');
  store.patch('tasks', task.id, { acceptance: '새 기준' });
  await assert.rejects(workflow.review(task.id, report.id, verdict(), leader.id), /완료 기준/);
  assert.equal(store.list('taskReviews').length, 0);
}));

test('Git results preserve an immutable patch and reject subsequent code changes', () => fixture(async ({ store, workflow, task, workspace, leader, start }) => {
  execFileSync('git', ['init', '-q', workspace]);
  // An empty tree is sufficient for this fixture; no commit is created.
  const baselineTree = execFileSync('git', ['-C', workspace, 'mktree'], { input: '', encoding: 'utf8' }).trim();
  store.patch('tasks', task.id, { isolation: 'worktree', baselineTree });
  const report = await workflow.submit(start(), result());
  const original = await readFile(report.artifacts.patchPath, 'utf8');
  assert.match(original, /result.txt/);
  await writeFile(join(workspace, 'extra.txt'), '새 변경');
  await assert.rejects(workflow.review(task.id, report.id, verdict(), leader.id), /산출물이 변경/);
  assert.equal(await readFile(report.artifacts.patchPath, 'utf8'), original);
}));

test('symlink targets are included in artifact identity', () => fixture(async ({ workflow, task, workspace, leader, start }) => {
  const target = join(directory, `${task.id}-outside.txt`);
  await writeFile(target, '원래 결과');
  await symlink(target, join(workspace, 'linked.txt'));
  const report = await workflow.submit(start(), result());
  await writeFile(target, '다른 결과');
  await assert.rejects(workflow.review(task.id, report.id, verdict(), leader.id), /산출물이 변경/);
}));

test('missing evidence and outstanding requirements prevent acceptance', () => fixture(async ({ workflow, task, leader, start }) => {
  const report = await workflow.submit(start(), { ...result(), remaining: ['장비 검증 필요'] });
  await assert.rejects(workflow.review(task.id, report.id, verdict(), leader.id), /미완료/);
}));

test('acceptance requires evidence for every registered completion criterion', () => fixture(async ({ store, workflow, task, leader, start }) => {
  store.patch('tasks', task.id, { acceptance: '정상 결과 파일\n오류 처리 확인' });
  const report = await workflow.submit(start(), result());
  await assert.rejects(workflow.review(task.id, report.id, verdict(), leader.id), /모든 완료 기준/);
  await workflow.review(task.id, report.id, { ...verdict(), checks: [
    { criterion: 'C1', status: 'passed', evidence: '파일 확인' }, { criterion: 'C2', status: 'passed', evidence: '오류 입력 검증 기록 확인' },
  ] }, leader.id);
  assert.equal(store.get('tasks', task.id).status, 'done');
}));

test('request pause holds queued work until explicit resumption', () => fixture(async ({ store, workflow, task }) => {
  let started = 0;
  const orchestrator = new Orchestrator(store, { launchRun: async ({ onSpawn }) => {
    started++; onSpawn(null);
    return { cancel() {}, promise: Promise.resolve({ output: JSON.stringify(result()), structured: result() }) };
  } });
  try {
    orchestrator.queue(task.id);
    workflow.pauseRequest(task.requestId);
    await orchestrator.pump();
    assert.equal(started, 0);
    workflow.resumeRequest(task.requestId);
    await orchestrator.pump();
    await Promise.all([...orchestrator.active.values()].map(run => run.promise));
    assert.equal(started, 1);
  } finally { await orchestrator.shutdown(); }
}));

test('rework retains previous reports and stops after two automatic attempts', () => fixture(async ({ store, workflow, task, leader, start }) => {
  const ids = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const session = start();
    const report = await workflow.submit(session, result(`결과 ${attempt + 1}`));
    ids.push(report.id);
    await workflow.review(task.id, report.id, verdict('rework'), leader.id);
    store.patch('sessions', session.id, { status: 'completed' });
    assert.equal(store.get('tasks', task.id).status, attempt < 2 ? 'queued' : 'blocked');
  }
  assert.equal(new Set(ids).size, 3);
  assert.equal(store.list('taskReviews').length, 3);
  assert.equal(store.get('tasks', task.id).reworkCount, 2);
  workflow.reconcile();
  assert(store.list('workflowJobs').some(job => job.kind === 'request_escalation'));
}));

test('user stop cancels pending review and prevents subsequent automatic reporting', () => fixture(async ({ store, workflow, task, leader, start }) => {
  const report = await workflow.submit(start(), result());
  workflow.pauseTask(task.id, 'user', true);
  await assert.rejects(workflow.review(task.id, report.id, verdict(), leader.id), /검토 대상/);
  workflow.reconcile();
  assert.equal(store.list('workflowJobs').length, 1);
  assert.equal(store.list('workflowJobs')[0].status, 'cancelled');
}));

test('queued jobs survive recovery; interrupted jobs require explicit resumption', () => fixture(async ({ store, workflow, start }) => {
  await workflow.submit(start(), result());
  workflow.recover();
  assert.equal(store.list('workflowJobs')[0].status, 'queued');
  store.patch('workflowJobs', store.list('workflowJobs')[0].id, { status: 'running' });
  workflow.recover();
  assert.equal(store.list('workflowJobs')[0].status, 'blocked');
}));

test('request reports are deduplicated and stale aggregate results are not published', () => fixture(async ({ store, workflow, task, leader, ceo, start }) => {
  const session = start();
  const report = await workflow.submit(session, result());
  await workflow.review(task.id, report.id, verdict(), leader.id);
  store.patch('sessions', session.id, { status: 'completed' });
  workflow.reconcile(); workflow.reconcile();
  const jobs = store.list('workflowJobs').filter(job => job.kind === 'request_report');
  assert.equal(jobs.length, 1);
  store.patch('workflowJobs', jobs[0].id, { status: 'running' });
  store.patch('tasks', task.id, { status: 'blocked', error: '조건 변경' });
  assert.equal(workflow.finishRequest(jobs[0].id, { id: id(), memberId: ceo.id }, '오래된 완료 보고'), null);
  assert.equal(store.get('requests', task.requestId).reportDocumentId, null);
}));

test('migration preserves all saved attempts without inventing historical reviews or scheduling work', () => fixture(async ({ store, workflow, task, start }) => {
  const session = start();
  store.patch('sessions', session.id, { status: 'completed', output: '기존 결과' });
  store.patch('tasks', task.id, { requestId: null, status: 'done', report: '기존 결과' });
  workflow.recover(); workflow.recover(); workflow.reconcile();
  assert.equal(store.list('taskReports').length, 1);
  assert.equal(store.list('taskReviews').length, 0);
  assert.equal(store.list('workflowJobs').length, 0);
  assert.match(renderTaskRecord(store, task.id), /검토 기록 없음/);
}));

test('execution identity is validated and workers cannot accept or run arbitrary tasks', () => fixture(async ({ store, task, worker, start }) => {
  const session = start();
  const identity = executionIdentity(store, session.processToken);
  assert.equal(identity.actor, worker.id);
  assert.throws(() => assertTaskActor(store, task, identity, '완료'), /담당 팀장/);
  assert.throws(() => executionIdentity(store, 'invalid'), /실행 신원/);
  store.patch('sessions', session.id, { status: 'completed' });
  assert.throws(() => executionIdentity(store, session.processToken), /실행 신원/);
  assert(!JSON.stringify(store.snapshot()).includes(session.processToken));
}));

test('a generated record failure does not lose the stored result', () => fixture(async ({ store, workflow, task, start }) => {
  const report = await workflow.submit(start(), result());
  await mkdir(join(directory, 'tasks'), { recursive: true });
  await writeFile(join(directory, 'tasks', task.id), 'block directory creation');
  const files = new WorkStatusFiles(store);
  try { await files.flush(); } finally { await files.close(); }
  assert(store.get('tasks', task.id).recordError);
  assert.equal(store.get('taskReports', report.id).result.summary, '구현 결과');
  assert.match(renderTaskRecord(store, task.id), /구현 결과/);
}));

test('late automatic review cannot overwrite a manual rework decision', () => fixture(async ({ store, task }) => {
  let release;
  const orchestrator = new Orchestrator(store, { launchRun: async ({ session, onSpawn }) => {
    onSpawn(null);
    if (session.kind === 'task_review') return { cancel() {}, promise: new Promise(resolve => { release = resolve; }) };
    return { cancel() {}, promise: Promise.resolve({ output: JSON.stringify(result()), structured: result() }) };
  } });
  try {
    orchestrator.queue(task.id);
    await orchestrator.pump();
    await Promise.all([...orchestrator.active.values()].map(run => run.promise));
    await orchestrator.pump();
    for (let index = 0; !release && index < 100; index++) await new Promise(resolve => setTimeout(resolve, 10));
    assert(release);
    await orchestrator.workflow.review(task.id, store.get('tasks', task.id).latestReportId, verdict('rework'), 'user');
    release({ output: JSON.stringify(verdict()), structured: verdict() });
    await Promise.all([...orchestrator.active.values()].map(run => run.promise));
    assert.equal(store.get('tasks', task.id).status, 'queued');
    assert.equal(store.list('taskReviews').length, 1);
    assert.equal(store.list('taskReviews')[0].authorId, 'user');
  } finally { release?.({ failure: 'test cleanup' }); await orchestrator.shutdown(); }
}));

test('full orchestrator advances worker -> review -> request report, with no live AI calls', () => fixture(async ({ store, task, workspace }) => {
  const calls = [];
  const orchestrator = new Orchestrator(store, { launchRun: async ({ session, onSpawn, prompt }) => {
    calls.push(session.kind);
    assert(prompt.includes(session.processToken));
    onSpawn(null);
    const structured = session.kind === 'work' ? result() : session.kind === 'task_review' ? verdict() : null;
    return { cancel() {}, promise: Promise.resolve({ output: structured ? JSON.stringify(structured) : '요청의 결과와 검증 근거를 보고합니다.', structured }) };
  } });
  try {
    orchestrator.queue(task.id);
    // Claude retains the existing fixture workspace. Each pump represents scheduler delivery.
    for (let index = 0; index < 3; index++) {
      await orchestrator.pump();
      await Promise.all([...orchestrator.active.values()].map(run => run.promise));
    }
    assert.deepEqual(calls, ['work', 'task_review', 'request_report']);
    assert.equal(store.get('tasks', task.id).status, 'done');
    assert.equal(store.get('requests', task.requestId).status, 'awaiting_acceptance');
    await orchestrator.statusFiles.flush();
    assert.match(await readFile(taskRecordPath(task.id), 'utf8'), /검토/);
    assert.equal(await readFile(join(workspace, 'result.txt'), 'utf8'), '정상 결과');
    const context = await contextFor(store, store.get('members', task.assigneeId), null);
    assert.match(context, /검토된 지식/);
  } finally { await orchestrator.shutdown(); }
}));
