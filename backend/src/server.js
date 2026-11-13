import Fastify from 'fastify';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Store, DATA, now } from './store.js';
import { departmentSchema, memberSchema, projectSchema, documentSchema, taskSchema, settingsSchema, consultationSchema, fail } from './contracts.js';
import { syncShared, syncMember, projectPath, createPatch, integrate } from './workspaces.js';
import { providers } from './providers.js';
import { Orchestrator } from './orchestrator.js';
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
  store.require('departments', input.departmentId);
  if (input.role === 'leader' && store.list('members').some(m => m.id !== existingId && m.departmentId === input.departmentId && m.role === 'leader')) fail('이 부서에는 이미 팀장이 있습니다.');
  const assigned = store.list('tasks').filter(t => t.assigneeId === existingId && !['done', 'cancelled'].includes(t.status));
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
app.get('/api/state', async () => ({ ...store.snapshot(), providers: await providers() }));
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
  const value = store.put('departments', input);
  store.event(`부서 생성 · ${value.name}`);
  return value;
});
app.patch('/api/departments/:id', async request => {
  const input = departmentSchema.parse({ ...store.require('departments', request.params.id), ...request.body });
  return store.patch('departments', request.params.id, input);
});
app.post('/api/members', async request => {
  const input = memberSchema.parse(request.body);
  validateMember(input);
  const value = store.put('members', { ...input, status: 'idle', summary: '', currentSessionId: null });
  await syncMember(store, value);
  store.event(`AI 합류 · ${value.name}`, { memberId: value.id });
  return value;
});
app.patch('/api/members/:id', async request => {
  const existing = store.require('members', request.params.id);
  if (existing.status === 'running') fail('진행 중인 세션을 중지한 뒤 프로필을 변경하세요.');
  const input = memberSchema.parse({ ...existing, ...request.body });
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
  const value = store.put('documents', { ...input, version: 1, revisions: [] });
  await syncShared(store);
  store.event(`문서 작성 · ${value.title}`);
  return value;
});
app.patch('/api/documents/:id', async request => {
  const existing = store.require('documents', request.params.id);
  if (request.body?.version !== existing.version) fail('다른 변경이 저장되었습니다. 문서를 다시 열어 확인하세요.');
  const input = documentSchema.parse({ ...existing, ...request.body });
  if (input.kind !== existing.kind) fail('문서 종류는 변경할 수 없습니다.', 400);
  validateDocument(input);
  const revisions = [...existing.revisions, { version: existing.version, content: existing.content, title: existing.title, savedAt: existing.updatedAt }];
  const value = store.patch('documents', existing.id, { ...input, version: existing.version + 1, revisions });
  await syncShared(store);
  return value;
});

app.post('/api/tasks', async request => {
  const input = taskSchema.parse(request.body);
  if (!input.projectId) input.isolation = 'personal';
  validateTask(input);
  const value = store.put('tasks', { ...input, status: input.assigneeId ? 'assigned' : 'draft', createdBy: 'user' });
  store.event(`작업 생성 · ${value.title}`, { taskId: value.id });
  return value;
});
app.patch('/api/tasks/:id', async request => {
  const task = store.require('tasks', request.params.id);
  if (['queued', 'running', 'done', 'cancelled'].includes(task.status) || operations.has(task.projectId)) fail('현재 상태에서는 작업 내용을 수정할 수 없습니다.');
  const input = taskSchema.parse({ ...task, ...request.body });
  if (!input.projectId) input.isolation = 'personal';
  if (task.workspace && ['projectId', 'isolation', 'assigneeId', 'departmentId'].some(key => input[key] !== task[key])) fail('작업 디렉토리가 생성된 작업은 프로젝트와 담당자를 바꿀 수 없습니다. 새 작업을 만들어주세요.');
  if ((task.projectId !== input.projectId || task.departmentId !== input.departmentId) && store.list('tasks').some(other => other.dependsOn.includes(task.id))) fail('다른 작업의 선행 작업입니다. 프로젝트나 소속 부서를 바꿀 수 없습니다.');
  validateTask(input, task.id);
  return store.patch('tasks', task.id, input);
});
app.post('/api/tasks/:id/run', async request => orchestrator.queue(request.params.id));
app.post('/api/tasks/:id/cancel', async request => {
  const task = store.require('tasks', request.params.id);
  if (['done', 'cancelled'].includes(task.status)) fail('이미 종료된 작업입니다.');
  if (task.status === 'running' && task.sessionId) orchestrator.stop(task.sessionId);
  return store.patch('tasks', task.id, { status: 'cancelled' });
});
app.post('/api/tasks/:id/complete', async request => {
  const task = store.require('tasks', request.params.id);
  if (task.status !== 'review') fail('검토 대기 중인 작업만 완료할 수 있습니다.');
  store.event(`검토 완료 · ${task.title}`, { taskId: task.id });
  return store.patch('tasks', task.id, { status: 'done', completedAt: now() });
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
  return operation(task.projectId, async () => {
    const result = await integrate(store, task);
    store.event(`원본에 변경 적용 · ${task.title}`, { taskId: task.id });
    return store.patch('tasks', task.id, { ...result, integratedAt: now() });
  });
});
app.post('/api/consult', async request => orchestrator.consult(consultationSchema.parse(request.body)));
app.post('/api/report', async request => orchestrator.report(consultationSchema.parse(request.body)));
app.post('/api/sessions/:id/stop', async request => { orchestrator.stop(request.params.id); return { ok: true }; });
app.get('/api/sessions/:id/logs', async request => {
  const session = store.require('sessions', request.params.id);
  try { return { content: (await readFile(join(DATA, 'sessions', session.id, 'activity.log'), 'utf8')).slice(-16000) }; }
  catch (error) { if (error.code === 'ENOENT') return { content: '아직 실행 로그가 없습니다.' }; throw error; }
});
app.patch('/api/settings', async request => store.patch('settings', 'main', settingsSchema.parse(request.body)));

async function initialize() {
  if (!store.list('documents').some(doc => doc.kind === 'instruction')) {
    store.put('documents', { title: '팀 공통 작업 원칙', kind: 'instruction', version: 1, revisions: [], projectId: null, departmentId: null,
      content: '사용자의 요청 범위와 프로젝트 지침을 우선합니다.\n\n- 필요한 자료만 읽고 작업 결과와 차단 사항을 짧게 보고합니다.\n- 확인하지 않은 결과는 미검증으로 표시합니다.\n- 명시적으로 요청하지 않은 테스트, 빌드, 컴파일, 실행 검증은 수행하지 않습니다.\n- 기존 작업을 보존하고 커밋, 푸시, 배포는 별도 지시가 있을 때만 수행합니다.\n- 팀장은 설계와 위임에 집중하고 팀원은 배정된 범위만 수행합니다.\n- 토큰 사용량을 추측하거나 만들어내지 않습니다.',
    });
  }
  await syncShared(store);
  await orchestrator.recover();
  ready = true;
}
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  ready = false;
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
