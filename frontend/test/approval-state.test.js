import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingApprovals, approvalChanges } from '../src/approval-state.js';

test('inbox includes only the current pending version and filters the conversation owner', () => {
  const data = { requests: [{ id: 'work', pendingApprovalId: 'latest' }], workApprovals: [
    { id: 'old', requestId: 'work', memberId: 'leader', status: 'pending' },
    { id: 'latest', requestId: 'work', memberId: 'leader', status: 'pending' },
    { id: 'orphan', requestId: 'deleted', status: 'pending' },
  ] };
  assert.deepEqual(pendingApprovals(data).map(item => item.id), ['latest']);
  assert.equal(pendingApprovals(data, 'other').length, 0);
});

test('approval diff exposes added, removed and edited scope without modifying snapshots', () => {
  const before = { instruction: 'A', tasks: [{ id: '1', title: '작업', assigneeId: 'a' }], documents: [{ id: '2', title: '문서' }] };
  const after = { instruction: 'B', tasks: [{ id: '1', title: '작업', assigneeId: 'b' }, { id: '3', title: '추가' }], documents: [] };
  assert.deepEqual(approvalChanges(before, after), ['목표·범위 변경', 'TASK 변경: 작업', 'TASK 추가: 추가', '문서 삭제: 문서']);
  assert.equal(before.tasks[0].assigneeId, 'a');
  assert.deepEqual(approvalChanges(null, after), []);
});
