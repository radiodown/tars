import { z } from 'zod';
import { fail } from './contracts.js';
import { requireConversation } from './conversations.js';
import { summaryRecord } from './web-state.js';

const createSchema = z.object({ projectId: z.string().uuid().nullable().optional(), title: z.string().trim().min(1).max(120).optional() }).strict();

export function registerConversationRoutes(app, store, orchestrator, operation) {
  const userOnly = request => { if (request.identity?.actor !== 'user') fail('세션 선택과 생성은 사용자만 할 수 있습니다.', 403); };
  app.get('/api/conversations', async request => {
    const input = z.object({ memberId: z.string().optional() }).strict().parse(request.query);
    return store.list('conversations').filter(item => !input.memberId || item.memberId === input.memberId);
  });
  app.get('/api/conversations/:id', async request => store.require('conversations', request.params.id));
  app.get('/api/conversations/:id/runs', async request => {
    const conversation = store.require('conversations', request.params.id);
    return store.list('sessions').filter(run => run.conversationId === conversation.id).map(run => summaryRecord('sessions', run));
  });
  app.post('/api/members/:id/conversations', async request => {
    userOnly(request);
    return operation(request.params.id, () => orchestrator.resetMemberChat(request.params.id, createSchema.parse(request.body)));
  });
  app.post('/api/conversations/:id/resume', async request => {
    userOnly(request);
    const conversation = store.require('conversations', request.params.id);
    const member = store.require('members', conversation.memberId);
    if (member.handoffSessionId) fail('CLI 인계를 종료한 뒤 세션을 재개하세요.');
    // Selecting a session never invokes a model or creates a run.
    return requireConversation(store, member, conversation.id);
  });
}
