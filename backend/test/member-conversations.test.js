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

test('CEO, leader and worker each continue one provider thread without creating work', () => fixture(async ({ store, ceo, leader, worker, chat }) => {
  const threads = [];
  for (const member of [ceo, leader, worker]) {
    const first = await chat(member, '첫 질문');
    const second = await chat(member, '후속 질문');
    assert.equal(first.conversationId, second.conversationId);
    assert.equal(second.resumeThreadId, first.providerSessionId);
    assert.equal(second.providerSessionId, first.providerSessionId);
    assert.notEqual(second.id, first.id); // Retain both execution records in the same conversation.
    assert.equal(memberHistory(store, member.id).length, 2);
    threads.push(first.providerSessionId);
  }
  assert.equal(new Set(threads).size, 3);
  assert.equal(store.list('requests').length, 0);
}));

test('registered work, interleaved task results and a server object restart do not split the chat', () => fixture(async ({ store, orchestrator, leader, calls, chat }) => {
  const first = await chat(leader);
  store.patch('sessions', first.id, { requestId: id() });
  const task = store.put('sessions', { memberId: leader.id, kind: 'task_review', projectId: null,
    status: 'completed', prompt: '검토 요청', output: '중간 작업 결과', startedAt: now() });
  const restart = new Orchestrator(store, { launchRun: orchestrator.launchRun });
  const next = restart.memberChat(leader.id, { prompt: '방금 검토 결과를 설명해줘' });
  await restart.active.get(next.id).promise;
  await restart.shutdown();
  assert.equal(store.get('sessions', next.id).resumeThreadId, first.providerSessionId);
  assert.match(calls.at(-1).prompt, /중간 작업 결과/);
  const history = await readFile(join(directory, 'conversations', `${leader.id}.md`), 'utf8');
  assert(history.includes(task.id));
  assert(!history.includes(first.processToken));
}));

test('changed model and a failed latest turn start fresh context without selecting an older thread', () => fixture(async ({ store, worker, chat, calls }) => {
  const first = await chat(worker);
  store.patch('members', worker.id, { model: 'changed-model' });
  const changed = await chat(worker);
  assert.equal(changed.resumeThreadId, null);
  assert.notEqual(changed.providerSessionId, first.providerSessionId);
  store.patch('sessions', changed.id, { status: 'failed', progress: '실패 기록' });
  const recovered = await chat(worker);
  assert.equal(recovered.resumeThreadId, null);
  assert.match(calls.at(-1).prompt, /실패 기록/);
}));

test('Claude direct messages also reuse their own provider session', () => fixture(async ({ worker, chat }) => {
  const first = await chat(worker);
  const second = await chat(worker);
  assert.equal(second.resumeClaudeId, first.providerSessionId);
  assert.equal(second.providerSessionId, first.providerSessionId);
}, 'claude'));

test('history retains legacy executions across projects and context resets, excluding other AIs', () => fixture(async ({ store, orchestrator, leader, worker, chat, calls }) => {
  store.put('sessions', { memberId: leader.id, kind: 'plan', status: 'completed', projectId: id(),
    conversationId: 'old-project-chat', prompt: '이전 협의', output: '오래된 합의', startedAt: now() });
  store.put('sessions', { memberId: worker.id, kind: 'work', status: 'completed', output: '다른 AI만의 대화', startedAt: now() });
  const first = await chat(leader);
  orchestrator.resetMemberChat(leader.id);
  const next = await chat(leader);
  assert.notEqual(first.conversationId, next.conversationId);
  assert(!next.resumeThreadId);
  assert.equal(memberHistory(store, leader.id).length, 3);
  assert(!calls.at(-1).prompt.includes('오래된 합의'));
  assert(!calls.at(-1).prompt.includes(first.output));
  assert(!calls.at(-1).prompt.includes('다른 AI만의 대화'));
  const context = await readFile(join(directory, 'conversations', `${leader.id}.md`), 'utf8');
  assert(!context.includes(first.id));
  const followup = await chat(leader);
  assert.equal(followup.resumeThreadId, next.providerSessionId);
  const updatedContext = await readFile(join(directory, 'conversations', `${leader.id}.md`), 'utf8');
  assert(updatedContext.includes(next.id));
  assert(!updatedContext.includes(first.id));
}));

test('a busy AI rejects another send without creating an extra execution', () => fixture(async ({ store, orchestrator, worker }) => {
  orchestrator.run = async () => {};
  orchestrator.memberChat(worker.id, { prompt: '첫 질문' });
  assert.throws(() => orchestrator.memberChat(worker.id, { prompt: '중복 요청' }), /이미 작업 중/);
  assert.throws(() => orchestrator.resetMemberChat(worker.id), /진행 중인 작업/);
  assert.equal(memberHistory(store, worker.id).length, 1);
  orchestrator.active.clear();
}));
