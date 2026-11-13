import test from 'node:test';
import assert from 'node:assert/strict';
import { requestFlows } from '../src/request-flow.js';

test('a conversation request collects design, delegated work, review and final report', () => {
  const data = {
    requests: [{ id: 'request-1', title: '기능 개발', instruction: '기능을 개발해줘', status: 'reported', createdAt: '2026-11-13T00:00:00Z', reportDocumentId: 'final' }],
    tasks: [{ id: 'task-1', requestId: 'request-1', documentIds: ['agreement', 'specification'], status: 'done' }],
    sessions: [{ id: 'plan-1', requestId: 'request-1', kind: 'plan', status: 'completed' }, { id: 'work-1', taskId: 'task-1', status: 'completed' }],
    documents: [{ id: 'agreement', kind: 'agreement', sessionId: 'plan-1' }, { id: 'specification', kind: 'specification', sessionId: 'plan-1' }, { id: 'final', kind: 'report', requestId: 'request-1' }],
    taskReports: [{ id: 'result', taskId: 'task-1' }], taskReviews: [{ id: 'review', taskId: 'task-1' }], workflowJobs: [],
  };
  const [flow] = requestFlows(data);
  assert.equal(flow.hasDesign, true);
  assert.equal(flow.complete, true);
  assert.deepEqual(flow.tasks.map(item => item.id), ['task-1']);
  assert.deepEqual(flow.sessions.map(item => item.id), ['plan-1', 'work-1']);
  assert.deepEqual(flow.documents.map(item => item.id), ['agreement', 'specification', 'final']);
  assert.deepEqual(flow.reports.map(item => item.id), ['result']);
  assert.deepEqual(flow.reviews.map(item => item.id), ['review']);
});

test('explicitly registered work stays visible before delegation', () => {
  const [flow] = requestFlows({ requests: [{ id: 'request-1', instruction: '설계 업무', registeredAt: '2026-11-13T00:00:00Z', status: 'open' }], tasks: [], sessions: [], documents: [] });
  assert.equal(flow.hasDesign, false);
  assert.equal(flow.complete, false);
  assert.deepEqual(flow.tasks, []);
});

test('old automatic chat requests are excluded without deleting the source', () => {
  const data = { requests: [{ id: 'request-1', instruction: '현황을 알려줘', status: 'open' }],
    tasks: [], sessions: [{ id: 'chat-1', requestId: 'request-1', status: 'completed' }], documents: [] };
  assert.deepEqual(requestFlows(data), []);
  assert.equal(data.requests.length, 1);
  assert.equal(data.sessions.length, 1);
});

test('work history includes linked follow-ups in time order and excludes unrelated chat and documents', () => {
  const [flow] = requestFlows({ requests: [{ id: 'work', registeredAt: '2026-11-13', sourceSessionId: 'origin' }],
    sessions: [
      { id: 'later', requestIds: ['work', 'other'], startedAt: '2026-11-13T02:00:00Z' },
      { id: 'unrelated', startedAt: '2026-11-13T01:00:00Z' },
      { id: 'origin', startedAt: '2026-11-13T00:00:00Z' },
    ], documents: [{ id: 'mine', requestId: 'work', sessionId: 'later' },
      { id: 'other', requestId: 'other', sessionId: 'later' }] });
  assert.deepEqual(flow.sessions.map(item => item.id), ['origin', 'later']);
  assert.deepEqual(flow.documents.map(item => item.id), ['mine']);
});

test('reported work awaits user acceptance and feedback jobs remain visible as active work', () => {
  const data = { requests: [{ id: 'work', registeredAt: '2026-11-13', approvalRequired: true, status: 'awaiting_acceptance' }] };
  const [pending] = requestFlows(data);
  assert.equal(pending.waiting, true);
  assert.equal(pending.complete, false);
  data.requests[0].status = 'revision_requested';
  data.workflowJobs = [{ requestId: 'work', kind: 'user_followup', status: 'queued' }];
  assert.equal(requestFlows(data)[0].active, true);
  data.requests[0].status = 'accepted';
  assert.equal(requestFlows(data)[0].complete, true);
});
