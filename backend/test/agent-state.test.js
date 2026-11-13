import test from 'node:test';
import assert from 'node:assert/strict';
import { agentState, agentStateQuerySchema } from '../src/agent-state.js';
import { taskWaitReason } from '../src/execution-status.js';

test('agent lists remain bounded, paginate and never include large bodies or session credentials', () => {
  const records = Array.from({ length: 120 }, (_, id) => ({ id: String(id), title: `item ${id}`, content: 'x'.repeat(100000),
    snapshot: { secret: 'snapshot' }, output: 'output', processToken: 'token', usage: 'usage' }));
  const store = { list: () => records, require: (_, id) => records[Number(id)] };
  const state = agentState(store, { collection: 'documents' });
  assert.equal(state.documents.length, 20);
  assert.equal(state.totals.documents, 120);
  assert(JSON.stringify(state).length < 2000);
  assert.equal(state.documents[0].content, undefined);
  assert.equal(agentState(store, { collection: 'documents', offset: 20, limit: 1 }).documents[0].id, '20');
  const detail = agentState(store, { collection: 'sessions', id: '0' }).item;
  assert.equal(detail.output, 'output');
  assert.equal(detail.processToken, undefined);
  assert.equal(detail.usage, undefined);
  assert.throws(() => agentStateQuerySchema.parse({ limit: '101' }));
  assert.throws(() => agentStateQuerySchema.parse({ id: '0' }));
  assert.throws(() => agentStateQuerySchema.parse({ collection: 'credentials' }));
});

test('waiting reasons explain approval, dependencies, busy assignee and capacity without writes', () => {
  let block = '사용자 승인 필요';
  const approvals = { executionBlockReason: () => block };
  const member = { id: 'worker', status: 'idle' };
  let sessions = [];
  const store = { get: kind => kind === 'members' ? member : kind === 'settings' ? { maxConcurrent: 1 } : { title: '선행', status: 'blocked' }, list: () => sessions };
  const task = { id: 'task', status: 'queued', assigneeId: 'worker', dependsOn: [] };
  assert.match(taskWaitReason(store, approvals, task), /사용자 승인/);
  block = null;
  assert.match(taskWaitReason(store, approvals, { ...task, dependsOn: ['dep'] }), /선행 작업/);
  member.status = 'running';
  assert.match(taskWaitReason(store, approvals, task), /담당 AI/);
  member.status = 'idle';
  sessions = [{ memberId: 'other', status: 'running' }];
  assert.match(taskWaitReason(store, approvals, task), /동시 실행 한도/);
  assert.equal(taskWaitReason(store, approvals, { ...task, status: 'done' }), null);
});
