import { fail } from './contracts.js';

export function executionIdentity(store, token) {
  if (!token) return { actor: 'user', session: null };
  const session = store.list('sessions').find(item => item.processToken === token);
  if (!session || !['preparing', 'running', 'waiting_input'].includes(session.status)) fail('유효한 실행 신원이 필요합니다.', 403);
  return { actor: session.memberId, session };
}

export function assertTaskActor(store, task, identity, action) {
  if (identity.actor === 'user') return;
  const member = store.require('members', identity.actor);
  if (['task_review', 'request_report', 'request_escalation'].includes(identity.session.kind)) fail('검토·보고 실행은 결과 제출로 업무 상태를 변경합니다.', 403);
  if (member.role === 'member' || (member.role === 'leader' && member.departmentId !== task.departmentId)) {
    fail(`이 작업의 ${action}은 담당 팀장 또는 TARS가 처리합니다.`, 403);
  }
}
