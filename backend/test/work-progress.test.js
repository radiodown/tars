import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { progressPlanSchema } from '../src/contracts.js';
import { workProgress } from '../../shared/work-progress.mjs';

const directory = mkdtempSync(join(tmpdir(), 'tars-work-progress-'));
process.env.TARS_DATA_DIR = directory;
const { Store } = await import('../src/store.js');
const { TaskWorkflow } = await import('../src/task-workflow.js');
const { workerProgress } = await import('../src/session-inputs.js');
const { validateProgressPlanChange, validateProgressAllocation, WORK_PROGRESS_GUIDE_TITLE } = await import('../src/work-progress.js');
const { initializeDefaultInstructions } = await import('../src/guidance.js');
after(() => rmSync(directory, { recursive: true, force: true }));
const plan = () => ({ summary: '로그인 오류 수정과 회귀 검증', goal: 'API 3개와 검증 8건 검토 완료', goals: [
  { id: 'api', title: 'API 수정', target: 3, unit: '개', weight: 60, acceptance: '정상·오류 응답 검증' },
  { id: 'tests', title: '회귀 검증', target: 8, unit: '건', weight: 40, acceptance: '시나리오 통과 기록' },
] });
function fixture(run) {
  const store = new Store();
  store.db.exec('DELETE FROM records; DELETE FROM work_history;');
  store.put('settings', { id: 'main' });
  const department = store.put('departments', { name: '개발' });
  const leader = store.put('members', { name: '팀장', role: 'leader', departmentId: department.id });
  const worker = store.put('members', { name: '팀원', role: 'member', departmentId: department.id });
  const source = store.put('sessions', { memberId: leader.id, status: 'running', kind: 'member_chat', projectId: null });
  const workflow = new TaskWorkflow(store);
  const raw = { title: '로그인 개선', instruction: '로그인 수정', acceptance: 'API와 회귀 시나리오 검토', progressPlan: plan() };
  const identity = { actor: leader.id, session: source };
  const request = workflow.registerRequest(raw, identity);
  const attach = (extra = {}) => workflow.attachTask({ title: 'API 수정', acceptance: '기능 검증', departmentId: department.id,
    assigneeId: worker.id, projectId: null, goalId: 'api', plannedUnits: 1, ...extra }, leader.id, request.id);
  try { return run({ store, workflow, request, raw, identity, leader, worker, source, attach }); }
  finally { store.db.close(); }
}

test('requires explicit measurable goals for new work; validates limits, unique IDs and total weight', () => fixture(({ workflow, raw, identity }) => {
  assert.throws(() => workflow.registerRequest({ ...raw, progressPlan: undefined }, identity), /progressPlan/);
  assert.throws(() => workflow.registerRequest({ ...raw, acceptance: '' }, identity), /acceptance/);
  for (const change of [p => { p.goals[0].weight = 59; }, p => { p.goals[1].id = 'api'; }, p => { p.goals[0].target = 0; }, p => { p.goals[0].target = 1.5; }, p => { p.summary = 'x'.repeat(161); }]) {
    const invalid = plan(); change(invalid);
    assert.equal(progressPlanSchema.safeParse(invalid).success, false);
  }
}));

test('allocations enforce target capacity, require criteria, and do not shrink targets on cancellation', () => fixture(({ store, request, attach }) => {
  const task = attach({ plannedUnits: 2 });
  assert.throws(() => attach({ plannedUnits: 2 }), /초과/);
  assert.throws(() => attach({ goalId: 'unknown' }), /goalId/);
  assert.throws(() => attach({ acceptance: '' }), /완료 기준/);
  assert.doesNotThrow(() => validateProgressAllocation(store, request, { ...task, plannedUnits: 3 }, task.id));
  store.patch('tasks', task.id, { status: 'cancelled', completedUnits: 2 });
  attach({ plannedUnits: 3 });
  const progress = workProgress(request, store.list('tasks'));
  assert.equal(progress.goals[0].target, 3);
  assert.equal(progress.goals[0].allocated, 3);
  assert.equal(progress.percent, 0);
  assert.equal(progress.reportedPercent, 0);
}));

test('worker reports cumulative bounded quantity; corrections and blockers preserve audit history', () => fixture(({ store, request, worker, attach }) => {
  const task = attach({ plannedUnits: 2 });
  const session = store.put('sessions', { memberId: worker.id, taskId: task.id, kind: 'work', status: 'running' });
  store.patch('tasks', task.id, { status: 'running', sessionId: session.id });
  const identity = { actor: worker.id, session };
  workerProgress(store, identity, 'progress', { message: 'API 2개 검증 로그 확인', completedUnits: 2, next: '검토 요청' });
  assert.equal(workProgress(request, store.list('tasks')).reportedPercent, 40);
  assert.equal(workProgress(request, store.list('tasks')).percent, 0);
  workerProgress(store, identity, 'block', { message: '1개 재검증 필요', completedUnits: 1 });
  assert.equal(store.get('tasks', task.id).completedUnits, 1);
  assert.equal(store.get('tasks', task.id).blocker, '1개 재검증 필요');
  workerProgress(store, identity, 'progress', { message: '차단 해소', completedUnits: 1 });
  assert.equal(store.get('tasks', task.id).blocker, null);
  for (const completedUnits of [-1, 3, 1.5]) assert.throws(() => workerProgress(store, identity, 'progress', { message: '잘못된 수량', completedUnits }));
  assert.throws(() => workerProgress(store, { ...identity, actor: 'other' }, 'progress', { message: '다른 담당자', completedUnits: 1 }), /현재 담당/);
  assert.equal(store.history('tasks', task.id).events.filter(event => ['progress', 'block'].includes(event.event)).length, 3);
}));

test('quantity changes invalidate approval; allocated goal criteria and totals cannot be rewritten', () => fixture(({ store, request, source, workflow, attach }) => {
  attach();
  store.patch('sessions', source.id, { status: 'completed' });
  const approval = workflow.approvals.submitPlan(request.id, source.id);
  assert.deepEqual(approval.snapshot.progressPlan, plan());
  const next = plan(); next.goals[0].target = 4;
  validateProgressPlanChange(store, request, next);
  store.patch('requests', request.id, { progressPlan: next });
  const history = store.db.prepare("SELECT body FROM work_history WHERE kind='requests' AND entity_id=? ORDER BY sequence DESC")
    .all(request.id).map(row => JSON.parse(row.body)).find(event => event.event === 'progress_plan');
  assert.equal(history.details.from.goals[0].target, 3);
  assert.equal(history.details.to.goals[0].target, 4);
  assert.notEqual(workflow.approvals.scopeSignature(request.id), approval.signature);
  assert.throws(() => workflow.approvals.respond(request.id, approval.id, { decision: 'approve' }), /변경/);
  const removed = plan(); removed.goals.shift();
  assert.throws(() => validateProgressPlanChange(store, request, removed), /삭제/);
  const criteria = plan(); criteria.goals[0].acceptance = '검증 생략';
  assert.throws(() => validateProgressPlanChange(store, request, criteria), /완료 기준/);
}));

test('incomplete or cancelled targets produce escalation instead of a final acceptance report', () => fixture(({ store, request, source, workflow, attach }) => {
  const task = attach();
  store.patch('tasks', task.id, { status: 'done', acceptedReportId: 'verified' });
  store.patch('requests', request.id, { approvalRequired: false });
  store.patch('sessions', source.id, { status: 'completed' });
  workflow.reconcile();
  assert.equal(store.list('workflowJobs')[0].kind, 'request_escalation');
  const document = store.put('documents', { title: '현재 결과', content: '1개 완료', version: 1 });
  const approval = workflow.approvals.submitReport(request.id, source.id, document.id);
  assert.equal(approval.snapshot.report.final, false);
}));

test('guide is a persisted on-demand document and never overwrites user edits', () => fixture(({ store }) => {
  initializeDefaultInstructions(store);
  const guide = store.list('documents').find(doc => doc.title === WORK_PROGRESS_GUIDE_TITLE);
  assert.equal(guide.instructionMode, 'on_demand');
  assert.match(guide.content, /completedUnits/);
  store.patch('documents', guide.id, { content: '사용자 작성 규칙', version: 2 });
  initializeDefaultInstructions(store);
  assert.equal(store.list('documents').filter(doc => doc.title === WORK_PROGRESS_GUIDE_TITLE).length, 1);
  assert.equal(store.get('documents', guide.id).content, '사용자 작성 규칙');
}));

test('target changes invalidate in-flight reports and schedule a fresh report for the revised goals', () => fixture(({ store, workflow, request, source, attach }) => {
  const task = attach();
  store.patch('tasks', task.id, { status: 'done', acceptedReportId: 'verified' });
  store.patch('requests', request.id, { approvalRequired: false });
  store.patch('sessions', source.id, { status: 'completed' });
  workflow.reconcile();
  const job = store.list('workflowJobs')[0];
  store.patch('workflowJobs', job.id, { status: 'running' });
  const next = plan(); next.goals[0].target = 4;
  store.patch('requests', request.id, { progressPlan: next });
  assert.equal(workflow.finishRequest(job.id, source, '기존 목표 보고'), null);
  assert.equal(store.get('workflowJobs', job.id).status, 'superseded');
  workflow.reconcile();
  const current = store.list('workflowJobs').find(item => item.status === 'queued');
  assert.equal(current.kind, 'request_escalation');
  assert.notEqual(current.signature, job.signature);
  assert.equal(store.list('documents').length, 0);
}));

test('retrying a blocked report clears the previous attempt quantity and blocker before queueing', () => fixture(({ store, workflow, request, source, attach }) => {
  const task = attach({ plannedUnits: 2 });
  store.patch('tasks', task.id, { status: 'blocked', completedUnits: 1, blocker: '연결 실패' });
  store.patch('sessions', source.id, { status: 'completed' });
  const document = store.put('documents', { title: '차단 보고', content: '연결 실패', version: 1 });
  const approval = workflow.approvals.submitReport(request.id, source.id, document.id);
  workflow.approvals.respond(request.id, approval.id, { decision: 'retry' });
  const current = store.get('tasks', task.id);
  assert.equal(current.status, 'queued');
  assert.equal(current.completedUnits, 0);
  assert.equal(current.blocker, null);
}));
