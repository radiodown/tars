import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingApprovals, approvalChanges, approvalSummaries } from '../src/approval-state.js';

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

test('pending summaries prioritize the oldest current approval and work without loaded snapshots', () => {
  const data = { requests: [{ id: 'a', title: '첫 업무', pendingApprovalId: 'new' }, { id: 'b', title: '오래 기다린 업무', pendingApprovalId: 'old' }],
    members: [{ id: 'ai', name: '루나' }], sessions: [{ id: 'completed', status: 'completed' }, { id: 'running', status: 'running' }],
    workApprovals: [
      { id: 'new', requestId: 'a', memberId: 'ai', sourceSessionId: 'running', status: 'pending', kind: 'plan', createdAt: '2026-11-17' },
      { id: 'old', requestId: 'b', memberId: 'ai', sourceSessionId: 'completed', status: 'pending', kind: 'report', createdAt: '2026-11-16' },
      { id: 'superseded', requestId: 'b', status: 'pending', createdAt: '2026-11-15' },
    ] };
  const rows = approvalSummaries(data, pendingApprovals(data));
  assert.deepEqual(rows.map(row => row.item.id), ['old', 'new']);
  assert.equal(rows[0].title, '오래 기다린 업무');
  assert.equal(rows[0].memberName, '루나');
  assert.equal(rows[0].reason, '보고 내용 확인');
  assert.equal(rows[1].reason, 'AI 응답 마무리 중');
  assert.equal(data.workApprovals[0].id, 'new');
  assert.equal(approvalSummaries({}, [{ id: 'orphan' }])[0].reason, '원래 실행 확인 필요');
});
