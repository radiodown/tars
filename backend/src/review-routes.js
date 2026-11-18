import { z } from 'zod';
import { fail, requestPolicySchema } from './contracts.js';
import { publicRecord, summaryRecord } from './web-state.js';
import { questionSchema, workerProgress } from './session-inputs.js';
import { setHandoff } from './session-lifecycle.js';
import { readTerminal, terminalEvents } from './terminal.js';
import { validateProgressPlanChange } from './work-progress.js';
import { sessionBelongsToRequest } from '../../shared/work-requests.mjs';

export const terminalQuery = z.object({ offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  before: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), limit: z.coerce.number().int().min(4).max(256 * 1024).optional() }).strict();
export function registerReviewRoutes(app, store, orchestrator) {
  const user = request => { if (request.identity.actor !== 'user') fail('사용자만 이 작업을 할 수 있습니다.', 403); };
  app.post('/api/chat-queue/:id/cancel', async request => { user(request); const item = store.require('chatQueue', request.params.id); if (item.status !== 'queued') fail('대기 중인 메시지가 아닙니다.'); return store.patch('chatQueue', item.id, { status: 'cancelled' }); });
  app.get('/api/records/:kind/:id', async (request, reply) => {
    const kind = z.enum(['sessions', 'documents', 'workApprovals', 'taskReports', 'taskReviews', 'workflowJobs']).parse(request.params.kind);
    reply.header('Cache-Control', 'no-store');
    return publicRecord(kind, store.require(kind, request.params.id));
  });
  app.patch('/api/requests/:id', async request => {
    const input = requestPolicySchema.parse(request.body);
    const work = store.require('requests', request.params.id);
    orchestrator.workflow.requireWork(work.id, work.projectId, request.identity.actor);
    if ('approvalMode' in input || 'allowManagerImplementation' in input) user(request);
    if (store.list('sessions').some(session => sessionBelongsToRequest(session, work.id) && (session.id !== request.identity.session?.id || 'allowManagerImplementation' in input || 'approvalMode' in input) && ['preparing', 'running', 'waiting_input', 'stopping'].includes(session.status))) fail('진행 중인 실행을 종료한 뒤 업무 범위를 변경하세요.');
    if (input.progressPlan) validateProgressPlanChange(store, work, input.progressPlan);
    return store.patch('requests', work.id, input, { actor: request.identity.actor });
  });
  for (const kind of ['progress', 'block']) app.post(`/api/execution/${kind}`, async request => workerProgress(store, request.identity, kind, request.body));
  app.post('/api/execution/ask', async request => {
    const input = questionSchema.parse(request.body);
    const session = request.identity.session;
    if (!session || ['task_review', 'request_report', 'request_escalation'].includes(session.kind)) fail('질문할 수 있는 실행 신원이 필요합니다.', 403);
    const handle = orchestrator.active.get(session.id)?.handle;
    handle?.waiting?.(true);
    try { return await orchestrator.inputs.ask(session.id, [{ id: 'answer', question: input.question, options: input.options?.map(label => ({ label })) }]); }
    finally { handle?.waiting?.(false); }
  });
  app.post('/api/input-requests/:id/answer', async request => { user(request); return orchestrator.inputs.answer(request.params.id, request.body); });
  app.post('/api/sessions/:id/continue', async request => {
    user(request);
    const { prompt } = z.object({ prompt: z.string().trim().min(1).max(16000) }).strict().parse(request.body);
    return publicRecord('sessions', orchestrator.continueSession(request.params.id, prompt));
  });
  app.post('/api/sessions/:id/handoff', async request => {
    user(request);
    const { locked } = z.object({ locked: z.boolean() }).strict().parse(request.body);
    return setHandoff(store, request.params.id, locked);
  });
  app.get('/api/sessions/:id/terminal/stream', (request, reply) => {
    const session = store.require('sessions', request.params.id);
    const lastEvent = request.headers['last-event-id'];
    const resumedOffset = lastEvent && /^\d+$/.test(lastEvent) ? Number(lastEvent) : 0;
    let offset = Math.max(terminalQuery.parse(request.query).offset || 0, Number.isSafeInteger(resumedOffset) ? resumedOffset : 0), busy = false, dirty = true, closed = false;
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const flush = async () => {
      dirty = true;
      if (busy || closed) return;
      busy = true;
      try {
        while (dirty && !closed) {
          dirty = false;
          const chunk = await readTerminal(session, { offset });
          if (chunk.nextOffset > offset) {
            offset = chunk.nextOffset;
            if (!reply.raw.write(`id: ${offset}\ndata: ${JSON.stringify(chunk)}\n\n`)) await new Promise(resolve => {
              const done = () => { reply.raw.off('drain', done); reply.raw.off('close', done); resolve(); };
              reply.raw.once('drain', done); reply.raw.once('close', done);
            });
            if (offset < chunk.size) dirty = true;
          }
        }
      } catch { reply.raw.end(); }
      finally { busy = false; }
    };
    terminalEvents.on(session.id, flush);
    const timer = setInterval(() => { if (!closed) reply.raw.write(': heartbeat\n\n'); }, 15000);
    reply.raw.on('close', () => { closed = true; clearInterval(timer); terminalEvents.off(session.id, flush); });
    void flush();
  });
}
