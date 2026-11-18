import { fail } from './contracts.js';
import { now } from './store.js';
import { providerCommand } from './providers.js';

const quote = text => `'${String(text).replaceAll("'", "'\\''")}'`;
export const liveSession = session => ['preparing', 'running', 'waiting_input', 'stopping'].includes(session?.status);
export function handoffCommand(session) {
  if (!session.workspace || !session.providerSessionId) fail('작업 경로와 제공사 세션 ID가 있는 실행만 인계할 수 있습니다.');
  return `cd -- ${quote(session.workspace)} && ${quote(providerCommand(session))} ${session.provider === 'claude' ? '--resume' : 'resume'} ${quote(session.providerSessionId)}`;
}
export function setHandoff(store, sessionId, locked) {
  const session = store.require('sessions', sessionId);
  if (store.list('sessions').some(item => item.memberId === session.memberId && liveSession(item))) fail('해당 AI의 실행을 끝낸 뒤 CLI로 인계하세요.');
  const command = handoffCommand(session);
  const member = store.require('members', session.memberId);
  if (member.handoffSessionId && member.handoffSessionId !== sessionId) fail('이 AI의 다른 세션이 CLI에 인계되어 있습니다.');
  return store.transaction(() => {
    store.patch('members', member.id, { handoffSessionId: locked ? sessionId : null });
    store.patch('sessions', session.id, { handoffAt: locked ? now() : null });
    return { locked, command };
  });
}
