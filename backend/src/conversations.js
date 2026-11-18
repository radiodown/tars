import { id, now } from './store.js';
import { fail } from './contracts.js';

const chatKinds = ['ceo_chat', 'member_chat', 'plan'];
const account = value => value.provider === 'codex' ? value.codexAccount || 'codex' : null;

export function createConversation(store, member, input = {}) {
  if (input.projectId) store.require('projects', input.projectId);
  return store.put('conversations', {
    memberId: member.id, departmentId: member.departmentId || null,
    provider: member.provider, codexAccount: account(member), projectId: input.projectId || null,
    title: (input.title || input.prompt || '새 세션').trim().slice(0, 120),
    kind: input.kind || 'chat', providerSessionId: null, workspace: null,
  });
}

export function requireConversation(store, member, conversationId, projectId) {
  const conversation = store.require('conversations', conversationId);
  if (conversation.memberId !== member.id) fail('다른 AI의 세션은 재개할 수 없습니다.', 403);
  if (conversation.provider !== member.provider || conversation.codexAccount !== account(member)) {
    fail('이 세션의 원래 제공사와 계정으로 설정한 뒤 재개하세요. 새 문맥으로 시작하려면 새 세션을 만드세요.');
  }
  if (projectId !== undefined && (projectId || null) !== conversation.projectId) fail('세션의 프로젝트는 바꿀 수 없습니다. 새 세션을 만드세요.');
  return conversation;
}

// The legacy `sessions` collection contains runs. Every new run belongs to a
// persistent conversation, including automatic work/review/report executions.
export function conversationForRun(store, member, kind, details) {
  if (!details.freshContinuation) {
    const source = details.continuationOf && store.get('sessions', details.continuationOf);
    const key = details.conversationId || source?.conversationId;
    if (key && store.get('conversations', key)) return requireConversation(store, member, key, details.projectId);
    if (!chatKinds.includes(kind) && !source) {
      const previous = store.list('sessions').find(run => run.memberId === member.id && run.kind === kind
        && (run.taskId || null) === (details.taskId || null) && (run.requestId || null) === (details.requestId || null)
        && (run.projectId || null) === (details.projectId || null)
        && run.provider === member.provider && account(run) === account(member)
        && store.get('conversations', run.conversationId));
      if (previous) return store.require('conversations', previous.conversationId);
    }
  }
  return createConversation(store, member, { ...details, kind: chatKinds.includes(kind) ? 'chat' : kind,
    title: details.prompt || (details.taskId && store.get('tasks', details.taskId)?.title) || `${member.name} · ${kind}` });
}

export function recordConversationRun(store, run) {
  const conversation = run.conversationId && store.get('conversations', run.conversationId);
  if (!conversation) return;
  if (conversation.providerSessionId && run.providerSessionId && conversation.providerSessionId !== run.providerSessionId) {
    fail('기존 세션과 다른 제공사 문맥이 반환되었습니다. 실행 기록을 확인하세요.');
  }
  store.patch('conversations', conversation.id, {
    lastRunId: run.id, lastActivityAt: run.endedAt || run.startedAt || now(),
    ...(run.providerSessionId ? { providerSessionId: run.providerSessionId } : {}),
    ...(run.workspace ? { workspace: run.workspace } : {}),
    ...(conversation.title === '새 세션' && run.prompt ? { title: run.prompt.trim().slice(0, 120) } : {}),
  });
}

// Idempotent migration: native provider identities are the strongest evidence
// of shared context. Never merge two known provider threads just because their
// former AI-wide conversationId was equal.
export function migrateConversations(store) {
  store.transaction(() => {
    const groups = new Map(store.list('conversations').filter(item => item.migrationKey).map(item => [item.migrationKey, item]));
    for (const run of store.list('sessions').reverse()) {
      if (run.conversationId && store.get('conversations', run.conversationId)) continue;
      const owner = store.get('members', run.memberId);
      const member = { ...owner, id: run.memberId, departmentId: run.departmentId || owner?.departmentId,
        provider: run.provider || owner?.provider, codexAccount: run.codexAccount || owner?.codexAccount };
      if (!member.id) continue;
      const identity = run.providerSessionId || run.resumeThreadId || run.resumeClaudeId;
      const key = JSON.stringify([member.id, member.provider, account(member), run.projectId || null, run.workspace || null,
        identity ? `provider:${identity}` : `legacy:${run.conversationId || run.id}`]);
      let conversation = groups.get(key);
      if (!conversation) {
        conversation = store.put('conversations', {
          id: id(), memberId: member.id, departmentId: member.departmentId || null,
          provider: member.provider, codexAccount: account(member), projectId: run.projectId || null,
          title: (run.prompt || run.request?.task?.title || `${owner?.name || '이전 AI'} · 이전 세션`).slice(0, 120),
          kind: chatKinds.includes(run.kind) ? 'chat' : run.kind,
          migrationKey: key,
          providerSessionId: identity || null, workspace: run.workspace || null, createdAt: run.startedAt || run.createdAt,
        });
        groups.set(key, conversation);
      }
      const updated = store.patch('sessions', run.id, { conversationId: conversation.id,
        ...(run.conversationId ? { legacyConversationId: run.conversationId } : {}) });
      recordConversationRun(store, updated);
    }
    for (const request of store.list('requests')) {
      const source = request.sourceSessionId && store.get('sessions', request.sourceSessionId);
      if (source?.conversationId && request.conversationId !== source.conversationId) store.patch('requests', request.id, { conversationId: source.conversationId });
    }
    for (const queued of store.list('chatQueue').filter(item => item.status === 'queued')) {
      if (queued.conversationId && store.get('conversations', queued.conversationId)) continue;
      const member = store.get('members', queued.memberId);
      const source = store.list('sessions').find(run => run.memberId === queued.memberId && run.legacyConversationId === queued.conversationId
        && (run.projectId || null) === (queued.projectId || null) && run.provider === member?.provider && account(run) === account(member || {}));
      if (member) store.patch('chatQueue', queued.id, { conversationId: source?.conversationId || createConversation(store, member, queued).id });
    }
  });
}
