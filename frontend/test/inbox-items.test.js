import test from 'node:test';
import assert from 'node:assert/strict';
import { inboxItems, isInboxDismissed, readInboxDismissals } from '../src/inbox-items.js';

test('a blocked approval follow-up produces one notice with the work and error', () => {
  const data = {
    members: [{ id: 'manager', name: 'TARS' }],
    projects: [{ id: 'project', name: 'NGIPS' }],
    requests: [{ id: 'work', title: '업무', projectId: 'project', followupJobId: 'job', executionBlockReason: '승인 후속 처리 대기' }],
    tasks: [{ id: 'task', title: '작업', requestId: 'work', status: 'queued', waitReason: '승인 후속 처리 대기' }],
    workflowJobs: [{ id: 'job', kind: 'user_followup', requestId: 'work', memberId: 'manager', status: 'blocked', error: '프로젝트 불일치' }],
  };
  const rows = inboxItems(data);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, 'blocked');
  assert.equal(rows[0].title, '업무');
  assert.equal(rows[0].reason, '프로젝트 불일치');
  assert.deepEqual(rows[0].context, ['NGIPS', 'TARS']);
  data.workflowJobs[0].status = 'running';
  assert.deepEqual(inboxItems(data), []);
});

test('a dismissed failure becomes visible again after a new attempt', () => {
  const job = { id: 'job', status: 'blocked', error: '같은 오류', updatedAt: '2026-11-18T04:00:00.000Z' };
  const [item] = inboxItems({ workflowJobs: [job] });
  const dismissals = readInboxDismissals(JSON.stringify({ [item.id]: item.revision }));
  assert.equal(isInboxDismissed(item, dismissals), true);

  const [retried] = inboxItems({ workflowJobs: [{ ...job, updatedAt: '2026-11-18T04:01:00.000Z' }] });
  assert.equal(retried.id, item.id);
  assert.equal(isInboxDismissed(retried, dismissals), false);
  assert.deepEqual(readInboxDismissals('[]'), {});
  assert.deepEqual(readInboxDismissals('invalid'), {});
});
