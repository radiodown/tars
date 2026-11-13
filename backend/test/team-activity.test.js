import test from 'node:test';
import assert from 'node:assert/strict';
import { teamActivitySnapshot, teamActivitySchema, teamActivityQuerySchema } from '../src/team-activity.js';

const ids = Array.from({ length: 12 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
const [departmentId, projectId, memberId, idleId, sessionId, requestId, taskId, approvalId] = ids;
const at = '2026-11-13T08:44:30.000Z', clock = Date.parse(at);
function fixture() {
  const data = {
    departments: [{ id: departmentId, name: 'Dev Ops', projectId }], projects: [{ id: projectId, name: 'AXTEST' }],
    members: [{ id: memberId, name: 'CASE', role: 'leader', departmentId, status: 'running', currentSessionId: sessionId },
      { id: idleId, name: 'ADA', role: 'member', departmentId, status: 'idle' }],
    sessions: [{ id: sessionId, memberId, status: 'running', kind: 'member_chat', projectId, startedAt: at,
      heartbeatAt: at, lastActivityAt: at, prompt: 'E그룹 커버리지 100%를 위해 분배해줘',
      output: 'E그룹 작성률과 분류 상태를 집계 중입니다.', progress: '작업 중: Bash', processToken: 'secret-value' }],
    tasks: [], requests: [], workApprovals: [], sessionActivities: [],
  };
  const store = { list: kind => data[kind] || [], get: (kind, id) => (data[kind] || []).find(item => item.id === id) };
  return { data, read: (query = {}) => teamActivitySnapshot(store, query, clock) };
}

test('one snapshot explains unregistered active chats and idle teammates without exposing raw sessions', () => {
  const { data, read } = fixture();
  data.sessions[0].steering = [{ prompt: 'E-01부터 확인', createdAt: at }];
  const result = read(), active = result.members.find(item => item.id === memberId);
  assert.equal(active.instruction, data.sessions[0].prompt);
  assert.match(active.publicMessage.text, /작성률/);
  assert.equal(active.currentTool, '작업 중: Bash');
  assert.equal(active.workRegistered, false);
  assert.equal(active.latestSteering.text, 'E-01부터 확인');
  assert.equal(active.isWorking, true);
  assert.equal(result.members.find(item => item.id === idleId).state, 'idle');
  assert.doesNotMatch(JSON.stringify(result), /secret-value|processToken/);
});

test('structured public commentary wins over accumulated output; reasoning and command arguments are excluded', () => {
  const { data, read } = fixture();
  data.sessionActivities.push({ id: sessionId, items: [
    { kind: 'message', text: '이전 진행', startedAt: at },
    { kind: 'reasoning', text: 'PRIVATE REASONING', status: 'running' },
    { kind: 'message', text: '최신 진행 secret-value', startedAt: at },
    { kind: 'tool', title: '도구 호출: search', status: 'running', output: 'RAW OUTPUT' },
  ] });
  const result = read();
  assert.equal(result.members[0].publicMessage.text, '최신 진행 [redacted]');
  assert.equal(result.members[0].currentTool, '도구 호출: search');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE REASONING|RAW OUTPUT|secret-value/);
});

test('stale, missing, invalid, and future heartbeat never claim current running/idle certainty', () => {
  const { data, read } = fixture();
  for (const heartbeat of [null, 'broken', '2026-11-13T08:45:30.000Z', '2026-11-13T08:43:44.000Z']) {
    data.sessions[0].heartbeatAt = heartbeat;
    const entry = read().members[0];
    assert.equal(entry.isWorking, null);
    assert.equal(entry.observation, heartbeat?.includes('08:43') ? 'stale' : 'unknown');
  }
  data.sessions = [];
  assert.equal(read().members[0].state, 'unknown');
  data.members[0].status = 'idle';
  assert.equal(read().members[0].state, 'unknown', 'dangling session pointer is not confirmed idle');
});

test('live session fallback and all-idle states are supported', () => {
  const { data, read } = fixture();
  data.members[0].currentSessionId = null;
  assert.equal(read().members[0].isWorking, true);
  data.sessions = [];
  data.members[0].status = 'idle';
  assert(read().members.every(item => item.state === 'idle' && item.isWorking === false));
});

test('execution completion remains separate from task review, blockers, and pending user approval', () => {
  const { data, read } = fixture();
  data.members[0].status = 'idle';
  data.sessions[0] = { ...data.sessions[0], status: 'completed', endedAt: at, taskId, requestId, recordPath: '/test/record.md' };
  data.tasks.push({ id: taskId, assigneeId: memberId, title: 'TC 검토', status: 'review', requestId, projectId });
  data.tasks.push({ id: ids[8], assigneeId: memberId, title: '추가 검증', status: 'blocked', error: 'DUT 접근 불가', projectId });
  data.requests.push({ id: requestId, createdBy: memberId, pendingApprovalId: approvalId, title: '결과 보고', projectId });
  data.workApprovals.push({ id: approvalId, status: 'pending', kind: 'report' });
  const entry = read().members[0];
  assert.equal(entry.state, 'idle');
  assert.equal(entry.latestExecution.status, 'completed');
  assert.equal(entry.latestExecution.taskStatus, 'review');
  assert.equal(entry.taskCounts.review, 1);
  assert.equal(entry.taskCounts.blocked, 1);
  assert.equal(entry.pendingApprovals[0].kind, 'report');
  assert.equal(entry.tasks.find(item => item.status === 'blocked').error, 'DUT 접근 불가');
});

test('filters, pagination, truncation, original task instruction, and registered work are explicit', () => {
  const { data, read } = fixture();
  data.sessions[0].taskId = taskId;
  data.sessions[0].request = { instruction: '실행 당시 지시' };
  data.tasks.push({ id: taskId, assigneeId: memberId, title: 'TC 작성', status: 'running', requestId, projectId });
  data.requests.push({ id: requestId, title: '작성률 100%', status: 'open' });
  data.sessions[0].output = 'X'.repeat(700);
  const first = read({ limit: 1, departmentId, projectId });
  assert.equal(first.coverage.matchedMembers, 2);
  assert.equal(first.nextOffset, 1);
  assert.equal(first.members[0].instruction, '실행 당시 지시');
  assert.equal(first.members[0].workRegistered, true);
  assert.deepEqual(first.members[0].truncated.fields, ['publicMessage.text']);
  assert.equal(read({ limit: 1, offset: 1 }).members[0].name, 'ADA');
  assert.equal(read({ memberId: idleId }).members.length, 1);
  assert.equal(read({ projectId: ids[9] }).members.length, 0);
  assert.equal(read({ departmentId: ids[9] }).members.length, 0);
  assert.equal(read({ offset: 100 }).nextOffset, null);
});

test('strict MCP and HTTP inputs validate identifiers and bounded pagination', () => {
  for (const query of [{ memberId: 'bad' }, { limit: 0 }, { limit: 101 }, { offset: -1 }, { unknown: true }, { limit: '5' }]) {
    assert.throws(() => teamActivitySchema.parse(query));
  }
  assert.equal(teamActivityQuerySchema.parse({ limit: '5', offset: '2' }).offset, 2);
});

test('approved continuation shows the work instruction rather than just the approval label', () => {
  const { data, read } = fixture();
  data.sessions[0].kind = 'user_followup';
  data.sessions[0].requestId = requestId;
  data.sessions[0].prompt = '협의안 v2 · 사용자 승인';
  data.requests.push({ id: requestId, title: '조회 도구', instruction: '팀 활동 조회 도구를 구현한다', status: 'open' });
  assert.equal(read().members[0].instruction, '팀 활동 조회 도구를 구현한다');
  assert.equal(read().members[0].invocation, '협의안 v2 · 사용자 승인');
});
