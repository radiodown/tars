export async function api(path, method = 'GET', body, { signal } = {}) {
  const response = await fetch(`/api${path}`, {
    method, signal, headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  if (!response.ok) throw Object.assign(new Error([payload.error, ...(payload.details || [])].filter(Boolean).join('\n')), { status: response.status });
  return payload;
}

export const labels = {
  waiting_approval: '실행 승인 대기', draft: '미배정', assigned: '배정됨', queued: '실행 대기', running: '작업 중', blocked: '차단됨',
  review: '검토 대기', done: '완료', cancelled: '취소됨', idle: '대기 중', preparing: '준비 중',
  waiting_input: '입력 대기', stopping: '중지 중', failed: '실패', completed: '응답 완료', interrupted: '중단됨', planned: '진행 예정', empty: '작업 없음',
  awaiting_approval: '협의 승인 대기', awaiting_acceptance: '결과 확인 대기', revision_requested: '의견 반영 중', accepted: '사용자 확인 완료',
};
export const kindLabels = { agreement: '협의 문서', specification: '설계 사양', report: '결과 보고', instruction: '공통 지침', skill: '스킬', note: '노트' };
export const workflowStages = {
  task_review: '팀장 검토', request_report: '담당 관리자 최종 보고',
  request_escalation: '담당 관리자 차단 보고', user_followup: '사용자 응답 후속 처리',
};
export const number = value => value == null ? '—' : new Intl.NumberFormat('ko-KR').format(value);
export const time = value => value ? new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—';
export const isLive = value => ['preparing', 'running', 'waiting_input', 'stopping'].includes(value);
export const canSteer = session => session?.status === 'running' && !session.interactionState && (session.supportsInput || (session.transport === 'app-server' && Boolean(session.providerTurnId)));
export const providerLabel = value => value.provider === 'codex' ? `Codex · ${value.codexAccount || 'codex'}` : 'Claude';
