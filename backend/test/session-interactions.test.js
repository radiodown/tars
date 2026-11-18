import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const directory = mkdtempSync(join(tmpdir(), 'tars-interactions-'));
process.env.TARS_DATA_DIR = directory;
const { Store } = await import('../src/store.js');
const { SessionInteractions, executionDeadline } = await import('../src/session-interactions.js');
const { codexInteraction, codexResponse, claudeResponse } = await import('../src/provider-interactions.js');
const { launchClaude } = await import('../src/claude-agent.js');
const { CodexAppServers } = await import('../src/codex-app-server.js');
const { TARS_TOOL_NAMES } = await import('../src/agent-access.js');
after(() => rmSync(directory, { recursive: true, force: true }));

function fixture() {
  const store = new Store();
  const session = store.put('sessions', { status: 'running', provider: 'codex' });
  return { store, session, broker: new SessionInteractions(store) };
}
const question = { kind: 'question', title: '선택', decisions: ['accept', 'cancel'], questions: [{ id: 'q', question: '선택하세요', isSecret: true }] };

test('live questions survive browser reads, validate answers and identity, and resolve exactly once without persisting secrets', async () => {
  const { store, session, broker } = fixture();
  try {
    const waits = [];
    const pending = broker.ask(session.id, question, { onWaiting: value => waits.push(value) });
    const state = store.snapshot().sessions.find(s => s.id === session.id);
    assert.equal(state.interactionState, 'waiting_input');
    const requestId = state.interactions[0].id;
    assert.throws(() => broker.respond(session.id, requestId, { answers: { q: ['answer'] } }, 'agent'), /사용자만/);
    assert.throws(() => broker.respond(session.id, requestId, { answers: {} }), /모든 질문/);
    broker.respond(session.id, requestId, { answers: { q: ['secret-value'] } });
    assert.equal((await pending).answers.q[0], 'secret-value');
    assert.deepEqual(waits, [true, false]);
    assert.equal(store.get('sessions', session.id).interactionState, null);
    assert(!JSON.stringify(store.snapshot()).includes('secret-value'));
    assert.throws(() => broker.respond(session.id, requestId, { answers: { q: ['again'] } }), /이미 처리/);
  } finally { store.db.close(); }
});

test('cancelled native requests and server recovery expire controls and reject late responses', async () => {
  const { store, session, broker } = fixture();
  try {
    const abort = new AbortController();
    const pending = broker.ask(session.id, question, { signal: abort.signal });
    const rejected = assert.rejects(pending, /취소/);
    abort.abort(); await rejected;
    assert.equal(store.get('sessions', session.id).interactions[0].status, 'expired');
    const second = broker.ask(session.id, question);
    const closed = assert.rejects(second, /종료/);
    broker.close(session.id); await closed;
    // Persisted requests left behind by a dead provider are invalidated on recovery.
    store.patch('sessions', session.id, { interactions: [{ id: 'orphan', kind: 'approval', status: 'pending' }] });
    new SessionInteractions(store).close(session.id, '서버 재시작');
    assert.equal(store.get('sessions', session.id).interactions[0].status, 'expired');
  } finally { store.db.close(); }
});

test('MCP form responses are schema checked while pending and their contents are not stored', async () => {
  const { store, session, broker } = fixture();
  try {
    const pending = broker.ask(session.id, { kind: 'elicitation', schema: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1 } }, additionalProperties: false } });
    const id = store.get('sessions', session.id).interactions[0].id;
    assert.throws(() => broker.respond(session.id, id, { content: {} }), /입력 항목/);
    assert.throws(() => broker.respond(session.id, id, { content: { name: 1 } }), /입력 항목/);
    broker.respond(session.id, id, { content: { name: 'private-name' } });
    assert.equal((await pending).content.name, 'private-name');
    assert(!JSON.stringify(store.snapshot()).includes('private-name'));
  } finally { store.db.close(); }
});

test('Codex questions resolve in their own thread and cancelling another waiter leaves the shared connection alive', async () => {
  const { store, session, broker } = fixture();
  const second = store.put('sessions', { status: 'running' });
  const servers = new CodexAppServers(store, async () => {});
  const listeners = new Map();
  let next = 0, connectionClosed = false;
  const replies = [];
  const emit = (threadId, method, extra) => listeners.get(threadId)?.event(method, { threadId, turnId: `turn-${threadId}`, ...extra });
  const entry = { listeners, rpc: { failed: false, closed: Promise.resolve(), close() { connectionClosed = true; }, async call(method, params) {
    if (method === 'skills/list') return { data: [{ cwd: directory, skills: [] }] };
    if (method === 'thread/start') return { thread: { id: `thread-${++next}` }, instructionSources: [] };
    if (method === 'mcpServerStatus/list') return { data: [{ name: 'tars', tools: Object.fromEntries(TARS_TOOL_NAMES.map(name => [name, { name }])) }] };
    if (method === 'turn/interrupt') { emit(params.threadId, 'turn/completed', { turn: { id: params.turnId, status: 'interrupted' } }); return {}; }
    if (method === 'turn/start') {
      const { threadId } = params, turnId = `turn-${threadId}`;
      queueMicrotask(async () => {
        emit(threadId, 'turn/started', { turn: { id: turnId } });
        try {
          const reply = await listeners.get(threadId).request('item/tool/requestUserInput', { threadId, turnId, itemId: 'q', isBlocking: true, questions: [{ id: 'q', question: '선택' }] }, threadId, new AbortController().signal);
          replies.push({ threadId, reply });
          emit(threadId, 'item/completed', { item: { id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'answered' } });
          emit(threadId, 'turn/completed', { turn: { id: turnId, status: 'completed' } });
        } catch { /* Cancellation expires this thread's pending question. */ }
      });
      return { turn: { id: turnId, status: 'inProgress' } };
    }
    throw new Error(method);
  } } };
  servers.connection = async () => entry;
  const start = value => servers.launch({ binary: 'fixture', session: { ...value, kind: 'ceo_chat', reasoning: 'default', guidance: { hash: '', expectedSources: [], skills: [] } },
    member: { name: 'test' }, cwd: directory, prompt: 'test', minutes: 1, onEvent() {},
    onIdentity: values => store.patch('sessions', value.id, values), onInteraction: (request, options) => broker.ask(value.id, request, options) });
  const firstRun = start(session), secondRun = start(second);
  try {
    const waitingUntil = Date.now() + 10_000;
    while (Date.now() < waitingUntil && [session, second].some(value => !store.get('sessions', value.id).interactions?.length)) await delay(10);
    for (const value of [session, second]) assert.equal(store.get('sessions', value.id).interactions?.[0]?.status, 'pending');
    secondRun.cancel();
    const request = store.get('sessions', session.id).interactions[0];
    broker.respond(session.id, request.id, { answers: { q: ['choice'] } });
    const [firstResult, secondResult] = await Promise.all([firstRun.promise, secondRun.promise]);
    assert.equal(firstResult.output, 'answered'); assert.equal(firstResult.failure, null);
    assert.equal(secondResult.stopped, true); assert.equal(connectionClosed, false);
    assert.deepEqual(replies, [{ threadId: store.get('sessions', session.id).providerSessionId, reply: { answers: { q: { answers: ['choice'] } } } }]);
    assert.equal(store.get('sessions', second.id).interactions[0].status, 'expired');
  } finally { firstRun.cancel(); secondRun.cancel(); store.db.close(); }
});

test('overlapping questions pause the deadline until every blocking request is answered', async () => {
  let expired = false;
  const timer = executionDeadline(70, () => { expired = true; });
  timer.waiting(true); timer.waiting(true);
  await delay(90); assert.equal(expired, false);
  timer.waiting(false); await delay(90); assert.equal(expired, false);
  timer.waiting(false); await delay(100); assert.equal(expired, true);
  timer.close();
});

test('provider responses preserve question IDs, human approval restrictions, declined permissions and multi-selection', () => {
  assert.deepEqual(codexResponse('item/tool/requestUserInput', {}, { answers: { q: ['A'] } }), { answers: { q: { answers: ['A'] } } });
  assert.deepEqual(codexResponse('item/permissions/requestApproval', { permissions: { network: { enabled: true } } }, { decision: 'decline' }), { permissions: {}, scope: 'turn' });
  assert(!codexInteraction('item/commandExecution/requestApproval', { kind: 'humanCommand' }).decisions.includes('acceptForSession'));
  const result = claudeResponse('AskUserQuestion', { questions: [{ question: '선택' }] }, { decision: 'accept', answers: { 0: ['A', 'B'] } });
  assert.deepEqual(result.updatedInput.answers, { 선택: 'A, B' });
  assert.equal(claudeResponse('Bash', {}, { decision: 'cancel' }).interrupt, true);
  const suggestion = { type: 'addRules', behavior: 'allow', destination: 'userSettings', rules: [{ toolName: 'Bash', ruleContent: 'echo *' }] };
  const persistent = claudeResponse('Bash', { command: 'echo ok' }, { decision: 'acceptForSession' }, [suggestion, { type: 'setMode', mode: 'bypassPermissions' }]);
  assert.deepEqual(persistent.updatedPermissions, [{ ...suggestion, destination: 'session' }]);
  assert.equal(suggestion.destination, 'userSettings');
});

test('Claude retains native configuration and resumes, blocks for tool approval, then processes queued follow-up before ending', async () => {
  const { store, session, broker } = fixture();
  let handle, reads = [], closed = false;
  const responses = [];
  try {
    handle = await launchClaude({ binary: '/existing/claude', session: { ...session, kind: 'work', permissionMode: 'review', resumeClaudeId: 'saved' },
      member: { name: 'test', model: 'model', reasoning: 'high' }, cwd: directory, prompt: 'first', minutes: 1,
      onSpawn() {}, onIdentity() {}, onEvent() {}, onInteraction: (request, options) => broker.ask(session.id, request, options),
      query({ prompt, options }) {
        assert.equal(options.pathToClaudeCodeExecutable, '/existing/claude');
        assert.deepEqual(options.settingSources, ['user', 'project', 'local']);
        assert.deepEqual(options.systemPrompt, { type: 'preset', preset: 'claude_code' });
        assert.equal(options.resume, 'saved'); assert.equal(options.permissionMode, 'default');
        assert(!options.allowedTools.includes('Bash'));
        return { close() { closed = true; }, async *[Symbol.asyncIterator]() {
          const iterator = prompt[Symbol.asyncIterator]();
          reads.push((await iterator.next()).value.message.content);
          responses.push(await options.canUseTool('Bash', { command: 'echo ok' }, { signal: new AbortController().signal }));
          yield { type: 'result', result: 'first result', session_id: 'saved' };
          reads.push((await iterator.next()).value.message.content);
          yield { type: 'result', result: 'final result', session_id: 'saved' };
        } };
      } });
    await handle.steer('second');
    for (let i = 0; i < 50 && !store.get('sessions', session.id).interactions?.length; i++) await delay(5);
    const request = store.get('sessions', session.id).interactions[0];
    broker.respond(session.id, request.id, { decision: 'accept' });
    const result = await handle.promise;
    assert.equal(result.failure, null); assert.equal(result.output, 'final result');
    assert.deepEqual(reads, ['first', 'second']); assert.equal(responses[0].behavior, 'allow'); assert(closed);
  } finally { handle?.cancel(); store.db.close(); }
});
