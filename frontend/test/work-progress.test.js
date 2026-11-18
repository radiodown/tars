import test from 'node:test';
import assert from 'node:assert/strict';
import { workProgress } from '../../shared/work-progress.mjs';
import { requestFlows } from '../src/request-flow.js';

const request = { id: 'work', registeredAt: '2026-11-17', progressPlan: { summary: '로그인 개선', goal: 'API 3개와 검증 8건', goals: [
  { id: 'api', title: 'API', target: 3, unit: '개', weight: 60 }, { id: 'test', title: '검증', target: 8, unit: '건', weight: 40 },
] } };
const task = (id, goalId, plannedUnits, status = 'done') => ({ id, requestId: 'work', goalId, plannedUnits, status, acceptedReportId: status === 'done' ? id : null });

test('computes weighted reviewed achievement separately from reported quantities', () => {
  const tasks = [task('api1', 'api', 1), task('api2', 'api', 2, 'running'), task('test4', 'test', 4)];
  tasks[1].completedUnits = 1;
  const progress = workProgress(request, tasks);
  assert.equal(progress.percent, 40);
  assert.equal(progress.reportedPercent, 60);
  assert.equal(progress.complete, false);
  assert.equal(progress.goals[1].unassigned, 4);
  assert.equal(progress.achievedGoals, 0);
  tasks[1].status = 'done'; tasks[1].acceptedReportId = 'accepted';
  tasks.push(task('test8', 'test', 4));
  assert.equal(workProgress(request, tasks).percent, 100);
  assert.equal(workProgress(request, tasks).complete, true);
});

test('cancelled, unreviewed, unrelated and superseded execution progress cannot inflate achievement', () => {
  const tasks = [task('cancelled', 'api', 3, 'cancelled'), { ...task('legacy', 'test', 8), acceptedReportId: null },
    { ...task('other', 'api', 3), requestId: 'unrelated' }, task('rework', 'api', 1, 'queued')];
  tasks[0].completedUnits = 3;
  tasks[0].blocker = '취소 전 차단 사항';
  assert.equal(workProgress(request, tasks).percent, 0);
  assert.equal(workProgress(request, tasks).reportedPercent, 0);
  assert.equal(workProgress(request, tasks).goals[0].unassigned, 2);
  assert.equal(workProgress({ id: 'legacy' }, []).percent, null);
  const [flow] = requestFlows({ requests: [request], tasks });
  assert.equal(flow.blocked, false);
  assert.equal(flow.counts.blocked, 0);
  assert.doesNotMatch(flow.nextStep, /취소 전/);
});

test('never rounds unfinished targets to 100 and shows missing allocation as the next step', () => {
  const almost = { ...request, progressPlan: { goals: [{ id: 'api', target: 10000, weight: 100 }] } };
  assert.equal(workProgress(almost, [task('almost', 'api', 9999)]).percent, 99);
  const [flow] = requestFlows({ requests: [request] });
  assert.equal(flow.progress.percent, 0);
  assert.match(flow.nextStep, /배정/);
  const [pending] = requestFlows({ requests: [{ ...request, status: 'awaiting_approval' }] });
  assert.equal(pending.nextStep, '협의안 확인 및 승인');
});
