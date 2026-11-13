import Fastify from 'fastify';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Store, DATA, now } from './store.js';
import { deleteDepartment } from './departments.js';
import { departmentSchema, memberSchema, projectSchema, documentSchema, taskSchema, taskReviewSchema, settingsSchema, consultationSchema, ceoSettingsSchema, ceoReportSchema, ceoChatSchema, codexAccountSchema, fail } from './contracts.js';
import { isWorkRequest, sessionBelongsToRequest } from '../../shared/work-requests.mjs';
import { readTerminal } from './terminal.js';
import { readSessionActivity } from './session-activity.js';
import { teamActivitySnapshot, teamActivityQuerySchema } from './team-activity.js';
import { taskWaitReason } from './execution-status.js';
import { agentState, agentStateQuerySchema } from './agent-state.js';
import { knowledgeTree, readKnowledgeFile } from './knowledge.js';
import { syncShared, syncMember, projectPath, createPatch, integrate } from './workspaces.js';
import { providers } from './providers.js';
import { accountUsage, closeAccountUsage } from './account-usage.js';
import { modelCatalog, closeModelCatalog, validateModelSettings } from './model-catalog.js';
import { Orchestrator } from './orchestrator.js';
import { CEO_ID, ensureCeo, projectOverview } from './ceo.js';
import { managementSnapshot, recordPath, renderTaskRecord } from './work-records.js';
import { executionIdentity, assertTaskActor } from './agent-identity.js';
import { assertCurrentArtifacts } from './task-artifacts.js';
import { initializeDefaultInstructions, reviseDocument } from './guidance.js';
import { allowedHosts, backendPort, bindHost } from '../../network.config.mjs';

const app = Fastify({ logger: true, bodyLimit: 256 * 1024 });
const store = new Store();
const orchestrator = new Orchestrator(store);
const clients = new Set();
const operations = new Set();
let ready = false;

// Keep the browser Host through the Vite proxy so LAN requests remain same-origin.
app.addHook('onRequest', async request => {
  let target;
  try { target = new URL(`${request.protocol}://${request.headers.host || ''}`); }
  catch { fail('올바르지 않은 호스트입니다.', 400); }
  const hostname = target.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (target.username || target.password || !allowedHosts().includes(hostname)) fail('허용되지 않은 호스트입니다.', 403);
  const origin = request.headers.origin;
  if (origin && origin !== target.origin) fail('허용되지 않은 요청 출처입니다.', 403);
  if (!ready && request.url.startsWith('/api/')) fail('작업 공간을 준비 중입니다.', 503);
  request.identity = executionIdentity(store, request.headers['x-tars-execution-token']);
  if (request.method !== 'GET' && ['task_review', 'request_report', 'request_escalation'].includes(request.identity.session?.kind)) {
    fail('검토·보고 실행은 최종 결과 제출로 업무 상태를 갱신합니다.', 403);
  }
  if (request.method !== 'GET' && request.identity.session?.kind === 'user_followup') {
    const approval = store.require('workApprovals', request.identity.session.approvalId);
    if (approval.kind === 'report' && approval.response?.decision === 'approve') fail('최종 승인 후에는 확인 답변만 작성합니다.', 403);
  }
});
app.setErrorHandler((error, request, reply) => {
  if (error instanceof z.ZodError) return reply.code(400).send({ error: '입력 내용을 확인하세요.', details: error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`) });
  const status = error.statusCode || 500;
  if (status >= 500) request.log.error(error);
  reply.code(status).send({ error: error.message || '요청을 처리하지 못했습니다.' });
});

async function operation(key, fn) {
  if (operations.has(key)) fail('같은 항목의 작업이 진행 중입니다.');
  operations.add(key);
  try { return await fn(); } finally { operations.delete(key); }
}

function validateMember(input, existingId = null) {
  if (input.name.toUpperCase() === 'TARS') fail('TARS는 고정 CEO의 이름입니다. 다른 이름을 사용하세요.', 400);
  store.require('departments', input.departmentId);
  if (input.role === 'leader' && store.list('members').some(m => m.id !== existingId && m.departmentId === input.departmentId && m.role === 'leader')) fail('이 부서에는 이미 팀장이 있습니다.');
  const assigned = existingId ? store.list('tasks').filter(t => t.assigneeId === existingId && !['done', 'cancelled'].includes(t.status)) : [];
  if (assigned.some(t => input.departmentId !== t.departmentId || input.role !== 'member')) fail('담당 작업을 정리한 뒤 소속 또는 역할을 변경하세요.');
}

function validateDocument(input) {
  if (input.projectId) store.require('projects', input.projectId);
  if (input.departmentId) store.require('departments', input.departmentId);
}

function validateTask(input, existingId = null) {
  store.require('departments', input.departmentId);
  if (input.projectId) store.require('projects', input.projectId);
  if (input.assigneeId) {
    const member = store.require('members', input.assigneeId);
    if (member.departmentId !== input.departmentId || member.role !== 'member') fail('같은 부서의 팀원을 선택하세요.', 400);
  }
  for (const key of input.documentIds) store.require('documents', key);
  const visit = (key, seen = new Set()) => {
    if (key === existingId) fail('작업 의존 관계가 순환합니다.', 400);
    if (seen.has(key)) return;
    seen.add(key);
    const dep = store.require('tasks', key);
    if (dep.departmentId !== input.departmentId || dep.projectId !== input.projectId) fail('선행 작업은 같은 부서와 프로젝트에 속해야 합니다.', 400);
    dep.dependsOn.forEach(next => visit(next, seen));
  };
  input.dependsOn.forEach(key => visit(key));
  if (input.projectId && input.isolation === 'personal') fail('소스 프로젝트 작업은 worktree 또는 디렉토리 복사를 선택하세요.', 400);
}

app.get('/health', async (request, reply) => reply.code(ready ? 200 : 503).send({ service: 'Tars', status: ready ? 'ok' : 'starting', time: now() }));
app.get('/api/team-activity', async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
  return teamActivitySnapshot(store, teamActivityQuerySchema.parse(request.query));
});
app.get('/api/state', async () => {
  const state = store.snapshot();
  state.requests = state.requests.filter(request => isWorkRequest(request, state.tasks))
    .map(request => ({ ...request, executionAllowed: orchestrator.workflow.approvals.canExecute(request.id),
      executionBlockReason: orchestrator.workflow.approvals.executionBlockReason(request.id) }));
  state.tasks = state.tasks.map(task => ({ ...task, waitReason: taskWaitReason(store, orchestrator.workflow.approvals, task) }));
  return { ...state, providers: await providers(), ceoOverview: projectOverview(state) };
});
app.get('/api/agent-state', async request => agentState(store, agentStateQuerySchema.parse(request.query)));
app.get('/api/knowledge/tree', async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
  return knowledgeTree(store);
});
app.get('/api/knowledge/file/:id', async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
  return readKnowledgeFile(store, request.params.id);
});
app.get('/api/account-usage', async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
  return accountUsage();
});
app.get('/api/models/:provider', async (request, reply) => {
  const provider = z.enum(['codex', 'claude']).parse(request.params.provider);
  const account = codexAccountSchema.default('codex').parse(request.query.account);
  reply.header('Cache-Control', 'no-store');
  return modelCatalog(provider, account);
});
app.get('/api/events', (request, reply) => {
  reply.hijack();
  reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  reply.raw.write('data: connected\n\n');
  clients.add(reply.raw);
  const timer = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15000);
  reply.raw.on('close', () => { clearInterval(timer); clients.delete(reply.raw); });
});
let updateTimer;
store.on('change', () => {
  if (updateTimer) return;
  updateTimer = setTimeout(() => {
    updateTimer = null;
    for (const client of clients) if (!client.destroyed) client.write(`data: ${Date.now()}\n\n`);
  }, 120);
});

app.post('/api/departments', async request => {
  const input = departmentSchema.parse(request.body);
  if (input.projectId) store.require('projects', input.projectId);
  const value = store.put('departments', input);
  await syncShared(store);
  store.event(`부서 생성 · ${value.name}`);
  return value;
});
app.patch('/api/departments/:id', async request => {
  const input = departmentSchema.parse({ ...store.require('departments', request.params.id), ...request.body });
  if (input.projectId) store.require('projects', input.projectId);
  const value = store.patch('departments', request.params.id, input);
  await syncShared(store);
  return value;
});
app.delete('/api/departments/:id', async request => {
  if (request.identity.actor !== 'user') fail('부서 삭제는 사용자만 할 수 있습니다.', 403);
  const value = deleteDepartment(store, request.params.id);
  await syncShared(store);
  return value;
});
app.post('/api/members', async request => {
  const input = memberSchema.parse(request.body);
  await validateModelSettings(input);
  validateMember(input);
  const value = store.put('members', { ...input, status: 'idle', summary: '', currentSessionId: null });
  await syncMember(store, value);
  store.event(`AI 합류 · ${value.name}`, { memberId: value.id });
  return value;
});
app.patch('/api/members/:id', async request => {
  const existing = store.require('members', request.params.id);
  if (existing.id === CEO_ID || existing.role === 'ceo') fail('TARS의 이름과 CEO 역할은 고정입니다. TARS 설정에서 모델과 지침을 변경하세요.', 400);
  if (existing.status === 'running') fail('진행 중인 세션을 중지한 뒤 프로필을 변경하세요.');
  const input = memberSchema.parse({ ...existing, ...request.body });
  await validateModelSettings(input);
  if (store.require('members', existing.id).status === 'running') fail('진행 중인 세션을 중지한 뒤 프로필을 변경하세요.');
  validateMember(input, existing.id);
  const value = store.patch('members', existing.id, input);
  await syncMember(store, value);
  return value;
});
app.post('/api/projects', async request => {
  const input = projectSchema.parse(request.body);
  const path = await projectPath(input.path);
  if (store.list('projects').some(project => project.path === path)) fail('이미 등록된 프로젝트 경로입니다.');
  return store.put('projects', { ...input, path });
});
app.post('/api/documents', async request => {
  const input = documentSchema.parse(request.body);
  validateDocument(input);
  const requestId = request.body.requestId || (['agreement', 'specification', 'report', 'note'].includes(input.kind) ? request.identity.session?.requestId : null);
  if (requestId) orchestrator.workflow.requireWork(requestId, input.projectId, request.identity.actor);
  const value = store.put('documents', { ...input, version: 1, revisions: [],
    ...(requestId ? { requestId, sessionId: request.identity.session?.id || null } : {}) });
  await syncShared(store);
  store.event(`문서 작성 · ${value.title}`);
  return value;
});
app.patch('/api/documents/:id', async request => {
  const existing = store.require('documents', request.params.id);
  if (request.body?.version !== existing.version) fail('다른 변경이 저장되었습니다. 문서를 다시 열어 확인하세요.');
  const input = documentSchema.parse({ ...existing, instructionMode: existing.instructionMode || 'always', ...request.body });
  if (input.kind !== existing.kind) fail('문서 종류는 변경할 수 없습니다.', 400);
  validateDocument(input);
  const value = reviseDocument(store, existing, input);
  await syncShared(store);
  return value;
});

app.post('/api/requests', async request => orchestrator.workflow.registerRequest(request.body, request.identity));
app.post('/api/requests/:id/approvals/:approvalId/respond', async request =>
  orchestrator.workflow.approvals.respond(request.params.id, request.params.approvalId, request.body, request.identity.actor));
app.post('/api/requests/:id/proposal', async request => {
  const session = request.identity.session;
  if (!session) fail('담당 팀장 또는 CEO 실행에서 협의안을 제출하세요.', 403);
  const work = store.require('requests', request.params.id);
  orchestrator.workflow.requireWork(work.id, work.projectId, request.identity.actor);
  return orchestrator.workflow.approvals.submitPlan(work.id, session.id, { force: true });
});

app.post('/api/tasks', async request => {
  const input = taskSchema.parse(request.body);
  if (!input.projectId) input.isolation = 'personal';
  validateTask(input);
  assertTaskActor(store, input, request.identity, '등록');
  const requestId = input.requestId || request.identity.session?.requestId || null;
  const value = orchestrator.workflow.attachTask(input, request.identity.actor, requestId, request.identity.session?.id || null);
  store.event(`작업 생성 · ${value.title}`, { taskId: value.id });
  return value;
});
app.patch('/api/tasks/:id', async request => {
  const task = store.require('tasks', request.params.id);
  assertTaskActor(store, task, request.identity, '수정');
  if (['queued', 'running', 'done', 'cancelled'].includes(task.status) || operations.has(task.projectId)) fail('현재 상태에서는 작업 내용을 수정할 수 없습니다.');
  const input = taskSchema.parse({ ...task, ...request.body });
  if (!input.projectId) input.isolation = 'personal';
  if (task.workspace && ['projectId', 'isolation', 'assigneeId', 'departmentId'].some(key => input[key] !== task[key])) fail('작업 디렉토리가 생성된 작업은 프로젝트와 담당자를 바꿀 수 없습니다. 새 작업을 만들어주세요.');
  if ((task.projectId !== input.projectId || task.departmentId !== input.departmentId) && store.list('tasks').some(other => other.dependsOn.includes(task.id))) fail('다른 작업의 선행 작업입니다. 프로젝트나 소속 부서를 바꿀 수 없습니다.');
  validateTask(input, task.id);
  if (input.requestId !== task.requestId) fail('기존 작업의 원래 요청은 변경할 수 없습니다.');
  orchestrator.workflow.cancelJobs(task.id, '작업 지시가 변경되었습니다.', 'superseded');
  return store.patch('tasks', task.id, { ...input, ...(task.status === 'review' ? { status: 'blocked', error: '작업 지시가 변경되었습니다. 다시 실행하세요.' } : {}) }, { actor: request.identity.actor });
});
app.post('/api/tasks/:id/run', async request => {
  assertTaskActor(store, store.require('tasks', request.params.id), request.identity, '실행');
  return orchestrator.queue(request.params.id, request.identity.actor);
});
app.post('/api/tasks/:id/cancel', async request => {
  const task = store.require('tasks', request.params.id);
  assertTaskActor(store, task, request.identity, '취소');
  if (['done', 'cancelled'].includes(task.status)) fail('이미 종료된 작업입니다.');
  return orchestrator.cancelTask(task.id, request.identity.actor);
});
app.post('/api/tasks/:id/complete', async request => {
  const task = store.require('tasks', request.params.id);
  fail('결과 버전과 검토 근거를 /api/tasks/:id/reviews로 제출하세요.', 409);
});
app.post('/api/tasks/:id/reviews', async request => {
  const { reportId, ...review } = taskReviewSchema.extend({ reportId: z.string().uuid() }).parse(request.body);
  if (request.identity.actor !== 'user') fail('AI 검토는 예약된 검토 실행의 최종 응답으로 제출합니다.', 403);
  const value = await operation(request.params.id, () => orchestrator.workflow.review(request.params.id, reportId, review, request.identity.actor));
  await syncShared(store);
  return value;
});
app.get('/api/tasks/:id/record', async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
  reply.header('Content-Disposition', `attachment; filename="tars-task-${request.params.id}.md"`);
  return reply.type('text/markdown; charset=utf-8').send(renderTaskRecord(store, request.params.id));
});
app.post('/api/workflow-jobs/:id/retry', async request => {
  if (request.identity.actor !== 'user') fail('중단된 후속 처리는 사용자 요청으로 재개합니다.', 403);
  return orchestrator.workflow.retryJob(request.params.id);
});
app.post('/api/requests/:id/stop', async request => {
  if (request.identity.actor !== 'user') fail('요청 전체 중지는 사용자 요청으로 처리합니다.', 403);
  const value = orchestrator.workflow.pauseRequest(request.params.id);
  for (const session of store.list('sessions').filter(item => sessionBelongsToRequest(item, value.id) && orchestrator.active.has(item.id))) orchestrator.stop(session.id);
  return value;
});
app.post('/api/requests/:id/resume', async request => {
  if (request.identity.actor !== 'user') fail('요청 전체 재개는 사용자 요청으로 처리합니다.', 403);
  return orchestrator.workflow.resumeRequest(request.params.id);
});
app.get('/api/tasks/:id/patch', async (request, reply) => {
  const task = store.require('tasks', request.params.id);
  if (!['review', 'done'].includes(task.status)) fail('작업 종료 후 패치를 확인할 수 있습니다.');
  return operation(task.projectId, async () => {
    const { patch } = await createPatch(store, task);
    return reply.type('text/plain; charset=utf-8').send(patch);
  });
});
app.post('/api/tasks/:id/integrate', async request => {
  const task = store.require('tasks', request.params.id);
  assertTaskActor(store, task, request.identity, '통합');
  return operation(task.projectId, async () => {
    if (!task.acceptedReportId) fail('검토된 결과 버전이 없습니다. 새 결과를 제출하고 검토하세요.');
    await assertCurrentArtifacts(store, task, store.require('taskReports', task.acceptedReportId));
    const result = await integrate(store, task);
    store.event(`원본에 변경 적용 · ${task.title}`, { taskId: task.id });
    return store.patch('tasks', task.id, { ...result, integratedAt: now() }, { actor: request.identity.actor });
  });
});
app.post('/api/consult', async request => orchestrator.consult(consultationSchema.parse(request.body), request.identity));
app.post('/api/report', async request => orchestrator.report(consultationSchema.parse(request.body)));
app.patch('/api/ceo', async request => {
  const input = ceoSettingsSchema.parse(request.body);
  return operation(CEO_ID, async () => {
    const existing = store.require('members', CEO_ID);
    if (existing.status === 'running') fail('TARS의 보고가 끝난 뒤 설정을 변경하세요.');
    await validateModelSettings({ ...existing, ...input });
    if (store.require('members', CEO_ID).status === 'running') fail('TARS의 보고가 끝난 뒤 설정을 변경하세요.');
    const value = store.patch('members', CEO_ID, input);
    await syncMember(store, value);
    return value;
  });
});
app.post('/api/ceo/report', async request => operation(CEO_ID, async () => orchestrator.oversee(ceoReportSchema.parse(request.body))));
app.post('/api/ceo/chat', async request => operation(CEO_ID, async () => orchestrator.chat(ceoChatSchema.parse(request.body))));
app.post('/api/ceo/chat/clear', async request => operation(CEO_ID, async () => orchestrator.resetChat(ceoChatSchema.pick({ projectId: true }).parse(request.body))));
app.post('/api/members/:id/chat', async request => operation(request.params.id,
  async () => orchestrator.memberChat(request.params.id, ceoChatSchema.parse(request.body))));
app.post('/api/members/:id/chat/clear', async request => operation(request.params.id,
  async () => orchestrator.resetMemberChat(request.params.id)));
app.get('/api/sessions/:id/terminal', async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
  return readTerminal(store.require('sessions', request.params.id));
});
app.post('/api/sessions/:id/stop', async request => {
  const session = store.require('sessions', request.params.id);
  if (request.identity.actor !== 'user' && request.identity.actor !== session.memberId) {
    if (!session.taskId) fail('다른 AI의 대화를 중지할 수 없습니다.', 403);
    assertTaskActor(store, store.require('tasks', session.taskId), request.identity, '중지');
  }
  orchestrator.stop(request.params.id, request.identity.actor); return { ok: true };
});
app.post('/api/sessions/:id/steer', async request => {
  const { prompt } = ceoChatSchema.pick({ prompt: true }).parse(request.body);
  return orchestrator.steer(request.params.id, prompt);
});
const historyQuery = z.object({ before: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();
app.get('/api/sessions/:id/activity', async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
  return readSessionActivity(store, request.params.id);
});
for (const kind of ['sessions', 'tasks', 'members']) app.get(`/api/${kind}/:id/history`, async (request, reply) => {
  store.require(kind, request.params.id);
  reply.header('Cache-Control', 'no-store');
  return store.history(kind, request.params.id, historyQuery.parse(request.query));
});
app.get('/api/sessions/:id/record', async (request, reply) => {
  const session = store.require('sessions', request.params.id);
  if (!session.recordPath) fail(session.recordError || '실행 종료 후 업무 기록을 내려받을 수 있습니다.', 409);
  reply.header('Cache-Control', 'no-store');
  reply.header('Content-Disposition', `attachment; filename="tars-work-${session.id}.md"`);
  return reply.type('text/markdown; charset=utf-8').send(await readFile(recordPath(session), 'utf8'));
});
app.get('/api/members/:id/management', async (request, reply) => {
  const manager = store.require('members', request.params.id);
  if (!['ceo', 'leader'].includes(manager.role)) fail('팀장 또는 CEO의 관리 상태만 조회할 수 있습니다.', 400);
  const { projectId } = z.object({ projectId: z.string().uuid().optional() }).strict().parse(request.query);
  if (projectId) store.require('projects', projectId);
  reply.header('Cache-Control', 'no-store');
  return managementSnapshot(store, manager, projectId);
});
app.get('/api/sessions/:id/logs', async request => {
  const session = store.require('sessions', request.params.id);
  if (session.transport === 'app-server') return readTerminal(session);
  try { return { content: (await readFile(join(DATA, 'sessions', session.id, 'activity.log'), 'utf8')).slice(-16000) }; }
  catch (error) { if (error.code === 'ENOENT') return { content: '아직 실행 로그가 없습니다.' }; throw error; }
});
app.patch('/api/settings', async request => store.patch('settings', 'main', settingsSchema.parse(request.body)));

async function initialize() {
  initializeDefaultInstructions(store);
  await syncShared(store);
  await syncMember(store, ensureCeo(store));
  await orchestrator.recover();
  ready = true;
}
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  ready = false;
  closeAccountUsage();
  closeModelCatalog();
  await orchestrator.shutdown();
  clearTimeout(updateTimer);
  for (const client of clients) client.end();
  await app.close();
  store.db.close();
}
process.on('SIGTERM', () => shutdown().then(() => process.exit(0)));
process.on('SIGINT', () => shutdown().then(() => process.exit(0)));
try {
  await app.listen({ host: bindHost, port: backendPort });
  await initialize();
} catch (error) {
  await orchestrator.shutdown();
  app.log.error(error);
  process.exit(1);
}
