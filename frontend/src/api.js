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
  draft: '미배정', assigned: '배정됨', queued: '실행 대기', running: '작업 중', blocked: '차단됨',
  review: '검토 대기', done: '완료', cancelled: '취소됨', idle: '대기 중', preparing: '준비 중',
  stopping: '중지 중', failed: '실패', completed: '응답 완료', interrupted: '중단됨', planned: '진행 예정', empty: '작업 없음',
};
export const kindLabels = { agreement: '협의 문서', specification: '설계 사양', report: '결과 보고', instruction: '공통 지침', skill: '스킬', note: '노트' };
export const number = value => value == null ? '—' : new Intl.NumberFormat('ko-KR').format(value);
export const time = value => value ? new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—';
export const isLive = value => ['preparing', 'running', 'stopping'].includes(value);
export const canSteer = session => session?.transport === 'app-server' && session.status === 'running' && Boolean(session.providerTurnId);
export const providerLabel = value => value.provider === 'codex' ? `Codex · ${value.codexAccount || 'codex'}` : 'Claude';
