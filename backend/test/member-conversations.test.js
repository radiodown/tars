import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'tars-member-conversations-'));
process.env.TARS_DATA_DIR = directory;
const { Store, id, now } = await import('../src/store.js');
const { Orchestrator } = await import('../src/orchestrator.js');
const { CEO_ID } = await import('../src/ceo.js');
const { guidanceFilesHash } = await import('../src/guidance.js');
const { memberHistory } = await import('../src/member-conversations.js');
const { createConversation, migrateConversations } = await import('../src/conversations.js');
after(() => rmSync(directory, { recursive: true, force: true }));

async function fixture(run, provider = 'codex') {
  const store = new Store();
  store.db.exec('DELETE FROM records; DELETE FROM work_history;');
  store.put('settings', { id: 'main', maxConcurrent: 3, maxSessionMinutes: 1 });
  const department = store.put('departments', { name: '개발팀', projectId: null });
  const create = (role, extra = {}) => store.put('members', { name: role, role,
    departmentId: department.id, provider, codexAccount: 'codex', model: '', reasoning: 'default',
    specialty: '', instructions: '', status: 'idle', ...extra });
  const ceo = create('ceo', { id: CEO_ID, name: 'TARS', departmentId: null });
  const leader = create('leader'), worker = create('member');
  const calls = [];
  const orchestrator = new Orchestrator(store, { launchRun: async options => {
    const { session, onIdentity, onSpawn } = options;
    calls.push(options);
    const sources = session.guidance?.expectedSources || [];
    const skills = session.guidance?.skills || [];
    onSpawn(null);
    onIdentity({ instructionSources: sources, availableSkills: skills,
      loadedGuidanceHash: await guidanceFilesHash([...sources, ...skills.map(skill => skill.path)]) });
    return { cancel() {}, promise: Promise.resolve({ output: `응답 ${calls.length}`,
      providerSessionId: session.resumeThreadId || session.resumeClaudeId || id(), providerTurnStatus: 'completed' }) };
  } });
  const chat = async (member, prompt = '이어서 설명해줘', extra = {}) => {
    const session = orchestrator.memberChat(member.id, { prompt, ...extra });
    await orchestrator.active.get(session.id).promise;
    const result = store.get('sessions', session.id);
    assert.equal(result.status, 'completed', result.progress);
    return result;
  };
  try { await run({ store, orchestrator, ceo, leader, worker, department, calls, chat }); }
  finally { await orchestrator.shutdown(); store.db.close(); }
}

test('each AI continues an explicitly selected session across multiple turns', () => fixture(async ({ store, ceo, leader, worker, chat }) => {
  const threads = [];
  for (const member of [ceo, leader, worker]) {
    const first = await chat(member, '첫 질문');
    const second = await chat(member, '후속 질문', { conversationId: first.conversationId });
    assert.equal(first.conversationId, second.conversationId);
    assert.equal(second.resumeThreadId, first.providerSessionId);
    assert.equal(second.providerSessionId, first.providerSessionId);
    assert.notEqual(second.id, first.id);
    assert.equal(memberHistory(store, member.id, null, first.conversationId).length, 2);
    assert.equal(store.get('conversations', first.conversationId).providerSessionId, first.providerSessionId);
    threads.push(first.providerSessionId);
  }
  assert.equal(new Set(threads).size, 3);
  assert.equal(store.list('requests').length, 0);
}));

test('two sessions of one AI retain independent native context when resumed alternately', () => fixture(async ({ store, worker, chat, calls }) => {
  const a = await chat(worker, 'SESSION_A_PRIVATE_CONTEXT');
  const b = await chat(worker, 'SESSION_B_PRIVATE_CONTEXT');
  assert.notEqual(a.conversationId, b.conversationId);
  assert.notEqual(a.providerSessionId, b.providerSessionId);
  assert(!calls.at(-1).prompt.includes('SESSION_A_PRIVATE_CONTEXT'));
  const a2 = await chat(worker, 'A 계속', { conversationId: a.conversationId });
  assert.equal(a2.providerSessionId, a.providerSessionId);
  const aHistory = await readFile(join(directory, 'conversations', `${a.conversationId}.md`), 'utf8');
  assert(aHistory.includes('SESSION_A_PRIVATE_CONTEXT'));
  assert(!aHistory.includes('SESSION_B_PRIVATE_CONTEXT'));
  assert(!aHistory.includes(a.processToken));
  const b2 = await chat(worker, 'B 계속', { conversationId: b.conversationId });
  assert.equal(b2.providerSessionId, b.providerSessionId);
  assert.equal(store.list('conversations').length, 2);
}));

test('registration and server restart preserve the chosen session without importing unrelated work', () => fixture(async ({ store, orchestrator, leader, calls, chat }) => {
  const first = await chat(leader);
  store.patch('sessions', first.id, { requestId: id() });
  const unrelated = store.put('sessions', { memberId: leader.id, kind: 'task_review', projectId: null,
    status: 'completed', prompt: '검토 요청', output: 'UNRELATED_REVIEW_OUTPUT', startedAt: now() });
  const reopened = new Store();
  const restart = new Orchestrator(reopened, { launchRun: orchestrator.launchRun });
  try {
    const next = restart.memberChat(leader.id, { prompt: '계속', conversationId: first.conversationId });
    await restart.active.get(next.id).promise;
    assert.equal(reopened.get('sessions', next.id).resumeThreadId, first.providerSessionId);
    assert(!calls.at(-1).prompt.includes('UNRELATED_REVIEW_OUTPUT'));
    const history = await readFile(join(directory, 'conversations', `${first.conversationId}.md`), 'utf8');
    assert(!history.includes(unrelated.id));
    assert(!history.includes(first.processToken));
  } finally { await restart.shutdown(); reopened.db.close(); }
}));

for (const provider of ['codex', 'claude']) test(`${provider}: changed model, instructions and interrupted turns keep the selected native session`, () => fixture(async ({ store, worker, chat }) => {
  const first = await chat(worker);
  store.patch('members', worker.id, { model: 'changed-model', reasoning: 'high', instructions: 'UPDATED_INSTRUCTION' });
  const changed = await chat(worker, '설정 변경 후 계속', { conversationId: first.conversationId });
  assert.equal(changed.providerSessionId, first.providerSessionId);
  store.patch('sessions', changed.id, { status: 'interrupted', progress: '실패 기록' });
  const resumed = await chat(worker, '실제 상태 확인 후 계속', { conversationId: first.conversationId });
  assert.equal(resumed.providerSessionId, first.providerSessionId);
  assert.equal(resumed[provider === 'codex' ? 'resumeThreadId' : 'resumeClaudeId'], first.providerSessionId);
}, provider));

test('new session command preserves previous sessions and starts with empty history', () => fixture(async ({ store, orchestrator, leader, worker, chat, calls }) => {
  const first = await chat(leader, 'OLD_SESSION_SECRET');
  await chat(worker, 'OTHER_AI_SECRET');
  const created = orchestrator.resetMemberChat(leader.id);
  const next = await chat(leader, '새 질문', { conversationId: created.id });
  assert.notEqual(first.conversationId, next.conversationId);
  assert(!next.resumeThreadId);
  assert(!calls.at(-1).prompt.includes('OLD_SESSION_SECRET'));
  assert(!calls.at(-1).prompt.includes('OTHER_AI_SECRET'));
  const context = await readFile(join(directory, 'conversations', `${next.conversationId}.md`), 'utf8');
  assert(!context.includes(first.id));
  assert(store.get('conversations', first.conversationId));
  const resumed = await chat(leader, '이전 대화로 복귀', { conversationId: first.conversationId });
  assert.equal(resumed.providerSessionId, first.providerSessionId);
}));

test('queued messages remain bound to their original session even when another session is selected', () => fixture(async ({ store, orchestrator, worker, chat, calls }) => {
  const first = await chat(worker, '첫 세션');
  const second = await chat(worker, '둘째 세션');
  const originalRun = orchestrator.run;
  orchestrator.run = async () => {};
  const held = orchestrator.memberChat(worker.id, { prompt: '처리 중', conversationId: first.conversationId });
  const queued = orchestrator.memberChat(worker.id, { prompt: '둘째 세션 후속', conversationId: second.conversationId });
  assert.equal(queued.status, 'queued');
  assert.equal(queued.conversationId, second.conversationId);
  assert.throws(() => orchestrator.resetMemberChat(worker.id), /진행 중인 작업/);
  store.patch('sessions', held.id, { status: 'completed' });
  store.patch('members', worker.id, { status: 'idle' });
  orchestrator.active.clear(); orchestrator.run = originalRun;
  await orchestrator.pump();
  await Promise.all([...orchestrator.active.values()].map(run => run.promise));
  const delivered = store.get('chatQueue', queued.id);
  assert.equal(delivered.status, 'sent');
  assert.equal(store.get('sessions', delivered.sessionId).conversationId, second.conversationId);
  assert.equal(calls.at(-1).session.resumeThreadId, second.providerSessionId);
}));

test('wrong AI, account or project cannot resume a session or create an accidental execution', () => fixture(async ({ store, orchestrator, ceo, worker, chat }) => {
  const first = await chat(worker);
  const count = store.list('sessions').length;
  assert.throws(() => orchestrator.memberChat(ceo.id, { prompt: 'invalid', conversationId: first.conversationId }), /다른 AI/);
  store.patch('members', worker.id, { codexAccount: 'codex2' });
  assert.throws(() => orchestrator.memberChat(worker.id, { prompt: 'invalid', conversationId: first.conversationId }), /원래 제공사와 계정/);
  const executive = await chat(ceo);
  assert.throws(() => orchestrator.memberChat(ceo.id, { prompt: 'invalid', conversationId: executive.conversationId, projectId: id() }), /프로젝트/);
  assert.equal(store.list('sessions').length, count + 1);
}));

test('native resume errors are recorded without silently starting a fresh provider session', () => fixture(async ({ store, orchestrator, worker, chat }) => {
  const first = await chat(worker);
  let attempts = 0;
  orchestrator.launchRun = async ({ session }) => {
    attempts++;
    assert.equal(session.resumeThreadId, first.providerSessionId);
    throw new Error('native thread missing');
  };
  const next = orchestrator.memberChat(worker.id, { prompt: '재개', conversationId: first.conversationId });
  await orchestrator.active.get(next.id).promise;
  assert.equal(attempts, 1);
  assert.equal(store.get('sessions', next.id).status, 'failed');
  assert.match(store.get('sessions', next.id).progress, /native thread missing/);
  assert.equal(store.get('conversations', first.conversationId).providerSessionId, first.providerSessionId);
  assert.equal(store.list('conversations').length, 1);
}));

test('migration groups native identity, separates former AI-wide contexts and is idempotent', () => fixture(async ({ store, worker }) => {
  const seed = (nativeId, extra = {}) => store.put('sessions', { memberId: worker.id, provider: 'codex', codexAccount: 'codex',
    projectId: null, conversationId: worker.id, providerSessionId: nativeId, workspace: '/same/path', kind: 'member_chat',
    status: 'completed', output: '보존할 결과', startedAt: now(), ...extra });
  const a = seed('native-a'), a2 = seed('native-a'), b = seed('native-b');
  const otherAccount = seed('native-a', { codexAccount: 'codex2' });
  const request = store.put('requests', { sourceSessionId: a.id, conversationId: worker.id });
  const queue = store.put('chatQueue', { memberId: worker.id, conversationId: worker.id, status: 'queued' });
  migrateConversations(store);
  const ca = store.get('sessions', a.id).conversationId;
  assert.equal(store.get('sessions', a2.id).conversationId, ca);
  assert.notEqual(store.get('sessions', b.id).conversationId, ca);
  assert.notEqual(store.get('sessions', otherAccount.id).conversationId, ca);
  assert.equal(store.get('sessions', a.id).output, a.output);
  assert.equal(store.get('requests', request.id).conversationId, ca);
  assert(store.get('conversations', store.get('chatQueue', queue.id).conversationId));
  const before = store.snapshot(); migrateConversations(store);
  assert.deepEqual(store.snapshot(), before);
}));
