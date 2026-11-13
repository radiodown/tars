import { ACCESS_VERSION } from './agent-access.js';
import { isMemberChat } from './member-conversations.js';

export function continuationSource(store, session, cwd) {
  const compatible = source => source && source.memberId === session.memberId && source.provider === session.provider
    && (source.codexAccount || null) === (session.codexAccount || null) && source.projectId === session.projectId
    && source.workspace === cwd && source.model === session.model && source.reasoning === session.reasoning
    && source.accessVersion === ACCESS_VERSION && source.status === 'completed';
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
