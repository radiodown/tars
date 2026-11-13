import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionActivity, saveSessionActivity, readSessionActivity } from '../src/session-activity.js';

const directory = mkdtempSync(join(tmpdir(), 'tars-session-activity-'));
process.env.TARS_DATA_DIR = directory;
const { Store } = await import('../src/store.js');
const { CodexAppServers } = await import('../src/codex-app-server.js');
const { Orchestrator } = await import('../src/orchestrator.js');
after(() => rmSync(directory, { recursive: true, force: true }));
const started = (activity, item) => activity.event('item/started', { item });
const completed = (activity, item) => activity.event('item/completed', { item });

test('streamed command output is reconciled with the authoritative completion without duplication', () => {
  const activity = createSessionActivity();
  started(activity, { id: 'read', type: 'commandExecution', command: 'cat src/app.js', commandActions: [{ type: 'read', path: 'src/app.js' }] });
  assert.equal(activity.snapshot().current, '파일 확인: src/app.js');
  activity.event('item/commandExecution/outputDelta', { itemId: 'read', delta: 'first\n' });
  activity.event('item/commandExecution/outputDelta', { itemId: 'read', delta: 'second\n' });
  completed(activity, { id: 'read', type: 'commandExecution', command: 'cat src/app.js', aggregatedOutput: 'first\nsecond\n', exitCode: 0 });
  const { items, current } = activity.snapshot();
  assert.equal(items.length, 1); assert.equal(items[0].output, 'first\nsecond\n');
  assert.equal(items[0].status, 'completed'); assert.equal(current, '');
  completed(activity, { id: 'test', type: 'commandExecution', command: 'node --test', exitCode: 1 });
  assert.equal(activity.snapshot().items[1].status, 'failed');
});

test('only public reasoning summaries are persisted, with stable summary sections', () => {
  const activity = createSessionActivity();
  started(activity, { id: 'reason', type: 'reasoning', content: ['PRIVATE RAW REASONING'] });
  assert.equal(activity.event('item/reasoning/textDelta', { itemId: 'reason', delta: 'PRIVATE RAW REASONING' }), false);
  activity.event('item/reasoning/summaryTextDelta', { itemId: 'reason', summaryIndex: 0, delta: '오류 원인을 ' });
  activity.event('item/reasoning/summaryTextDelta', { itemId: 'reason', summaryIndex: 0, delta: '확인합니다.' });
  activity.event('item/reasoning/summaryPartAdded', { itemId: 'reason', summaryIndex: 1 });
  activity.event('item/reasoning/summaryTextDelta', { itemId: 'reason', summaryIndex: 1, delta: '테스트를 준비합니다.' });
  completed(activity, { id: 'reason', type: 'reasoning', summary: [], content: ['PRIVATE RAW REASONING'] });
  assert.equal(activity.snapshot().items[0].text, '오류 원인을 확인합니다.\n\n테스트를 준비합니다.');
  assert(!JSON.stringify(activity.snapshot()).includes('PRIVATE'));
  assert.equal(activity.event('rawResponseItem/completed', { item: { content: 'PRIVATE' } }), false);
});

test('file changes, turn diff, plan transitions and progress comments remain separate from the final answer', () => {
  const activity = createSessionActivity();
  started(activity, { id: 'files', type: 'fileChange', changes: [{ path: 'app.js', kind: { type: 'update' }, diff: '-old\n+new' }] });
  assert.equal(activity.snapshot().current, '파일 수정: app.js');
  completed(activity, { id: 'files', type: 'fileChange', changes: [{ path: 'app.js', kind: 'update', diff: '-old\n+new' }] });
  activity.event('turn/diff/updated', { diff: '--- a/app.js\n+++ b/app.js\n-old\n+new' });
  activity.event('turn/plan/updated', { plan: [{ step: '코드 확인', status: 'completed' }, { step: '테스트', status: 'pending' }] });
  completed(activity, { id: 'comment', type: 'agentMessage', phase: 'commentary', text: '오류 분기를 수정합니다.' });
  completed(activity, { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '수정했습니다.' });
  const snapshot = activity.snapshot();
  assert.equal(snapshot.items.length, 3); assert.equal(snapshot.items[0].changes[0].diff, '-old\n+new');
  assert.equal(snapshot.items[1].steps[1].status, 'pending'); assert(snapshot.diff.includes('+new'));
  assert(!snapshot.items.some(item => item.id === 'answer'));
});

test('interruption and missing completion never turn pending tools or plan steps into success', () => {
  for (const [outcome, expected] of [['interrupted', 'interrupted'], ['failed', 'failed'], ['completed', 'incomplete']]) {
    const activity = createSessionActivity();
    started(activity, { id: 'tool', type: 'mcpToolCall', server: 'test', tool: 'read' });
    activity.event('turn/plan/updated', { plan: [{ step: '확인', status: 'inProgress' }] });
    activity.finish(outcome);
    assert.equal(activity.snapshot().current, ''); assert.equal(activity.snapshot().items[0].status, expected);
    assert.equal(activity.snapshot().items[1].steps[0].status, expected);
  }
});

test('large output and long runs are bounded and explicitly marked as truncated', () => {
  const activity = createSessionActivity();
  for (let index = 0; index < 200; index++) {
    completed(activity, { id: `cmd-${index}`, type: 'commandExecution', command: 'echo test', aggregatedOutput: 'x'.repeat(50000), exitCode: 0 });
  }
  activity.event('turn/diff/updated', { diff: '+'.repeat(100000) });
  const snapshot = activity.snapshot();
  assert(snapshot.items.length <= 100); assert(snapshot.omitted > 0);
  assert.equal(snapshot.items.at(-1).id, 'cmd-199'); assert(snapshot.items.at(-1).truncated);
  assert(snapshot.diffTruncated); assert(JSON.stringify(snapshot).length < 245000);
});

test('tool calls do not retain private arguments, and tool errors are not reported as completed', () => {
  const activity = createSessionActivity();
  completed(activity, { id: 'tool', type: 'mcpToolCall', server: 'tars', tool: 'read', arguments: { executionToken: 'SECRET' }, error: { message: '실패' }, status: 'failed' });
  assert(!JSON.stringify(activity.snapshot()).includes('SECRET'));
  assert.equal(activity.snapshot().items[0].output, '실패');
  assert.equal(activity.snapshot().items[0].status, 'failed');
});

test('activity survives reopening SQLite without bloating workspace state, and recovery clears running rows', () => {
  let store = new Store();
  const session = store.put('sessions', { status: 'running' });
  const activity = createSessionActivity();
  started(activity, { id: 'cmd', type: 'commandExecution', command: 'node --test', aggregatedOutput: 'test output' });
  store.transaction(() => store.patch('sessions', session.id, saveSessionActivity(store, session.id, activity.snapshot())));
  assert.equal(store.snapshot().sessions.find(item => item.id === session.id).activityAvailable, true);
  assert(!JSON.stringify(store.snapshot()).includes('test output'));
  store.db.close(); store = new Store();
  try {
    assert.equal(readSessionActivity(store, session.id).items[0].command, 'node --test');
    store.patch('sessions', session.id, { status: 'interrupted' });
    assert.equal(readSessionActivity(store, session.id).items[0].status, 'interrupted');
    assert.equal(readSessionActivity(store, session.id).current, '');
    assert.throws(() => readSessionActivity(store, 'missing'), /찾을 수 없습니다/);
  } finally { store.db.close(); }
});

test('a fast Codex turn retains its last events before the progress throttle flushes and rejects other turns', async () => {
  const servers = new CodexAppServers(null, async () => {});
  const listeners = new Map();
  servers.connection = async () => ({ listeners, rpc: { call: async (method, params) => {
    if (method === 'skills/list') return { data: [{ cwd: directory, skills: [] }] };
    if (method === 'thread/start') return { thread: { id: 'thread' }, instructionSources: [] };
    if (method === 'turn/start') {
      assert.equal(params.summary, 'auto');
      const emit = (method, values) => listeners.get('thread').event(method, { threadId: 'thread', turnId: 'turn', ...values });
      emit('turn/started', { turn: { id: 'turn' } });
      emit('item/started', { turnId: 'other-turn', item: { id: 'wrong', type: 'commandExecution', command: 'WRONG TURN' } });
      emit('item/started', { item: { id: 'cmd', type: 'commandExecution', command: 'echo ok' } });
      emit('item/commandExecution/outputDelta', { itemId: 'cmd', delta: 'ok' });
      emit('item/completed', { item: { id: 'cmd', type: 'commandExecution', command: 'echo ok', aggregatedOutput: 'ok', exitCode: 0 } });
      emit('item/completed', { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '완료' } });
      emit('turn/completed', { turn: { id: 'turn', status: 'completed' } });
      return { turn: { id: 'turn', status: 'completed' } };
    }
    throw new Error(`Unexpected method ${method}`);
  } } });
  const handle = servers.launch({ binary: 'unused', session: { id: 'fast', kind: 'ceo_chat', reasoning: 'default', guidance: { hash: '', expectedSources: [], skills: [] } },
    member: { name: 'test' }, cwd: directory, prompt: 'test', minutes: 1, onIdentity() {}, onEvent() {} });
  const result = await handle.promise;
  assert.equal(result.failure, null); assert.equal(result.output, '완료');
  assert.equal(result.activity.items.length, 1); assert.equal(result.activity.items[0].output, 'ok');
  assert.equal(result.activity.items[0].status, 'completed'); assert(!JSON.stringify(result).includes('WRONG TURN'));
});

test('orchestration persists both live activity and the final snapshot even without a final progress callback', async () => {
  const store = new Store();
  store.db.exec('DELETE FROM records; DELETE FROM work_history;');
  store.put('settings', { id: 'main', maxConcurrent: 1, maxSessionMinutes: 1 });
  const department = store.put('departments', { name: 'test' });
  const member = store.put('members', { role: 'member', name: 'test', provider: 'claude', status: 'idle', departmentId: department.id, model: '', reasoning: 'default' });
  const activity = createSessionActivity();
  const orchestrator = new Orchestrator(store, { launchRun: async ({ session, onSpawn, onEvent }) => {
    onSpawn(null);
    started(activity, { id: 'test-command', type: 'commandExecution', command: 'echo test' });
    onEvent('명령 실행 중', { activity: activity.snapshot() });
    assert.equal(store.get('sessions', session.id).currentActivity, '명령 실행: echo test');
    assert.equal(readSessionActivity(store, session.id).items[0].status, 'running');
    completed(activity, { id: 'test-command', type: 'commandExecution', command: 'echo test', aggregatedOutput: 'test', exitCode: 0 });
    activity.finish('completed');
    return { cancel() {}, promise: Promise.resolve({ output: '완료', activity: activity.snapshot() }) };
  } });
  try {
    const session = orchestrator.memberChat(member.id, { prompt: '작업 표시 테스트' });
    await orchestrator.active.get(session.id).promise;
    const saved = store.get('sessions', session.id);
    assert.equal(saved.status, 'completed'); assert.equal(saved.currentActivity, '');
    assert.equal(saved.activityCount, 1);
    assert.equal(readSessionActivity(store, session.id).items[0].output, 'test');
    assert.equal(readSessionActivity(store, session.id).items[0].status, 'completed');
  } finally { await orchestrator.shutdown(); store.db.close(); }
});
