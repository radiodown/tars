// Derive waiting reasons on read. Polling must not write history or emit changes.
export function taskWaitReason(store, approvals, task) {
  if (task.status !== 'queued') return null;
  const approval = approvals.executionBlockReason(task.requestId);
  if (approval) return approval;
  if (task.automationPaused) return '사용자가 작업의 자동 진행을 중지했습니다.';
  const missing = (task.dependsOn || []).map(id => store.get('tasks', id)).filter(item => item?.status !== 'done');
  if (missing.length) return `선행 작업 대기: ${missing.map(item => item?.title || '삭제된 작업').join(', ')}`;
  const member = task.assigneeId && store.get('members', task.assigneeId);
  if (!member) return '담당 AI가 없습니다.';
  const sessions = store.list('sessions').filter(item => ['preparing', 'running', 'stopping'].includes(item.status));
  if (member.status === 'running' || sessions.some(item => item.memberId === member.id || item.taskId === task.id)) return '담당 AI 또는 이 작업의 이전 실행이 종료되기를 기다리고 있습니다.';
  if (sessions.length >= store.get('settings', 'main').maxConcurrent) return '동시 실행 한도에 도달했습니다.';
  return '실행 대기열에서 시작을 기다리고 있습니다.';
}
