import { ACCESS_VERSION } from './agent-access.js';
import { isMemberChat } from './member-conversations.js';
import { fail } from './contracts.js';

export function continuationSource(store, session, cwd) {
  const conversation = session.conversationId && store.get('conversations', session.conversationId);
  if (conversation) {
    if (!conversation.providerSessionId) return null;
    if (conversation.memberId !== session.memberId || conversation.provider !== session.provider
      || (conversation.codexAccount || null) !== (session.codexAccount || null)
      || conversation.projectId !== (session.projectId || null) || conversation.workspace !== cwd) {
      fail('기존 세션의 AI·계정·프로젝트·작업 경로와 일치하지 않습니다. 새 세션을 시작하세요.');
    }
    // A failed preparation may not have a native ID yet. Resume the same stored
    // thread, never a different conversation or a replay of the failed input.
    const previous = store.list('sessions').find(source => source.id !== session.id
      && source.conversationId === conversation.id && source.providerSessionId === conversation.providerSessionId);
    return previous || { ...conversation, id: conversation.lastRunId, startedAt: conversation.createdAt };
  }
  const compatible = source => source && source.memberId === session.memberId && source.provider === session.provider
    && (source.codexAccount || null) === (session.codexAccount || null) && source.projectId === session.projectId
    && source.workspace === cwd && (session.explicitContinuation || (source.model === session.model && source.reasoning === session.reasoning))
    && (source.accessVersion === ACCESS_VERSION || session.explicitContinuation) && (source.status === 'completed' || session.explicitContinuation);
  if (session.continuationOf) {
    const source = store.get('sessions', session.continuationOf);
    return compatible(source) ? source : null;
  }
  if (isMemberChat(session)) {
    // Request registration can change requestId during a turn; it does not split the AI's conversation.
    const latest = store.list('sessions').find(source => source.id !== session.id && source.memberId === session.memberId
      && isMemberChat(source) && (source.conversationId || null) === (session.conversationId || null));
    return compatible(latest) ? latest : null;
  }
  return store.list('sessions').find(source => source.id !== session.id && compatible(source)
    && source.kind === session.kind && source.taskId === session.taskId
    && (source.requestId || null) === (session.requestId || null)
    && (source.conversationId || null) === (session.conversationId || null)) || null;
}
