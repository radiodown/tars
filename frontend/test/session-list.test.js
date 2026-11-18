import test from 'node:test';
import assert from 'node:assert/strict';
import { filterSessionGroups, sessionGroups } from '../src/session-list.js';

const run = (id, values = {}) => ({ id, kind: 'work', memberId: 'ai', status: 'completed', startedAt: '2026-11-17T01:00:00Z', ...values });
const work = (id, values = {}) => ({ id, title: id, registeredAt: '2026-11-01', ...values });

test('groups multi-request, source and task-backed runs without losing executions or mutating data', () => {
  const data = { requests: [work('a', { sourceSessionId: 'source' }), work('b'), { id: 'legacy-task', title: '이전 업무' }],
    tasks: [{ id: 't', requestId: 'legacy-task' }],
    sessions: [run('shared', { requestId: 'b', requestIds: ['a', 'b'] }), run('source'), run('task', { taskId: 't' }), run('loose')] };
  const original = structuredClone(data);
  const groups = sessionGroups(data);
  assert.deepEqual(groups.find(group => group.id === 'request:a').sessions.map(session => session.id), ['source', 'shared']);
  assert.equal(groups.find(group => group.id === 'request:b').sessions.length, 1);
  assert.equal(groups.find(group => group.id === 'request:legacy-task').sessions[0].id, 'task');
  assert.equal(new Set(groups.flatMap(group => group.sessions.map(session => session.id))).size, 4);
  assert.deepEqual(data, original);
});

test('legacy chat requests collapse into conversations while new conversations and independent runs stay separate', () => {
  const groups = sessionGroups({ requests: [{ id: 'turn1' }, { id: 'turn2' }], sessions: [
    run('one', { kind: 'member_chat', requestId: 'turn1' }), run('two', { kind: 'member_chat', requestId: 'turn2' }),
    run('new', { kind: 'member_chat', conversationId: 'fresh' }), run('other', { kind: 'member_chat', memberId: 'other' }),
    run('independent'), run('followup', { continuationOf: 'independent' }),
  ] });
  assert.equal(groups.length, 4);
  assert.equal(groups.find(group => group.id === 'chat:ai:default').sessions.length, 2);
  assert.equal(groups.find(group => group.id === 'session:independent').sessions.length, 2);
});

test('attention and running work sort above newer ended runs; responses and approvals remain visible', () => {
  const groups = sessionGroups({ requests: [work('approval', { pendingApprovalId: 'plan' })],
    workApprovals: [{ id: 'plan', kind: 'plan', status: 'pending' }],
    inputRequests: [{ sessionId: 'question', status: 'pending' }], sessions: [
      run('old-plan', { requestId: 'approval', startedAt: '2026-11-01' }),
      run('question', { status: 'running' }), run('permission', { status: 'running', interactionState: 'waiting_approval' }),
      run('active', { status: 'running' }), run('latest', { startedAt: '2026-11-18' }),
    ] });
  assert.equal(groups.at(-1).latest.id, 'latest');
  assert.equal(filterSessionGroups(groups, { status: 'attention' }).length, 3);
  assert.equal(filterSessionGroups(groups, { status: 'active' }).length, 3);
  assert.equal(groups.find(group => group.id === 'request:approval').status, 'awaiting_approval');
});

test('successful retry by a new assignee clears a past failure without hiding failures in another task', () => {
  const data = { requests: [work('work')], tasks: [{ id: 'task', requestId: 'work' }, { id: 'other', requestId: 'work' }], sessions: [
    run('failed', { taskId: 'task', status: 'failed', startedAt: '2026-11-01' }),
    run('retry', { taskId: 'task', memberId: 'new-ai' }),
  ] };
  assert.equal(sessionGroups(data)[0].needsAttention, false);
  data.sessions.push(run('other-failure', { taskId: 'other', status: 'failed' }));
  assert.equal(sessionGroups(data)[0].needsAttention, true);
  data.requests[0].status = 'accepted';
  assert.equal(sessionGroups(data)[0].needsAttention, false);
  assert.equal(sessionGroups(data)[0].status, 'accepted');
});

test('blocked tasks and followup jobs remain actionable even when their last run completed', () => {
  const groups = sessionGroups({ requests: [work('blocked'), work('queued')],
    tasks: [{ id: 't', requestId: 'blocked', status: 'blocked' }],
    workflowJobs: [{ requestId: 'queued', status: 'queued' }],
    sessions: [run('a', { taskId: 't' }), run('b', { requestId: 'queued' })] });
  assert.equal(filterSessionGroups(groups, { status: 'attention' })[0].id, 'request:blocked');
  assert.equal(filterSessionGroups(groups, { status: 'active' })[0].id, 'request:queued');
});

test('combines search, participating member and latest-run period across work context', () => {
  const groups = sessionGroups({ requests: [work('work', { title: '로그인 개선', projectId: 'p' })],
    tasks: [{ id: 't', requestId: 'work', title: '회귀 검증' }], members: [{ id: 'ai', name: '루나' }], projects: [{ id: 'p', name: 'TARS' }],
    sessions: [run('recent', { taskId: 't' }), run('old', { startedAt: '2026-10-01' })] });
  const options = { search: 'tars 루나 검증', memberId: 'ai', days: '7', now: Date.parse('2026-11-18') };
  assert.equal(filterSessionGroups(groups, options)[0].id, 'request:work');
  assert.equal(filterSessionGroups(groups, { ...options, memberId: 'unknown' }).length, 0);
  assert.equal(filterSessionGroups(groups, { days: '7', now: options.now }).length, 1);
  assert.equal(filterSessionGroups(groups, { search: '없는 항목' }).length, 0);
  assert.deepEqual(sessionGroups({}), []);
});
