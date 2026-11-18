export function pendingApprovals(data, memberId) {
  return (data.workApprovals || []).filter(item => item.status === 'pending'
    && (!memberId || item.memberId === memberId)
    && data.requests.some(request => request.id === item.requestId && request.pendingApprovalId === item.id))
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

export function approvalSummaries(data, items) {
  const requests = new Map((data.requests || []).map(request => [request.id, request]));
  const members = new Map((data.members || []).map(member => [member.id, member]));
  const sessions = new Map((data.sessions || []).map(session => [session.id, session]));
  return items.map(item => {
    const title = requests.get(item.requestId)?.title || item.snapshot?.title || '이전 업무';
    const memberName = members.get(item.memberId)?.name || '이전 담당자';
    const kindLabel = item.kind === 'plan' ? '협의안' : '결과 보고';
    const source = sessions.get(item.sourceSessionId);
    const reason = ['preparing', 'running', 'waiting_input', 'stopping'].includes(source?.status) ? 'AI 응답 마무리 중'
      : source?.status !== 'completed' ? '원래 실행 확인 필요' : item.kind === 'plan' ? '목표·범위와 작업 승인' : '보고 내용 확인';
    return { item, title, memberName, kindLabel, reason, searchText: `${title} ${memberName} ${kindLabel}`.toLocaleLowerCase() };
  });
}

export function approvalChanges(previous, current) {
  if (!previous || !current) return [];
  const changes = [];
  for (const [field, label] of [['title', '업무 제목'], ['instruction', '목표·범위'], ['projectId', '프로젝트'], ['acceptance', '완료 기준'], ['approvalMode', '승인 방식'], ['allowManagerImplementation', '관리자 직접 구현 허용']]) {
    if (previous[field] !== current[field]) changes.push(`${label} 변경`);
  }
  for (const [field, label] of [['tasks', 'TASK'], ['documents', '문서']]) {
    const before = new Map((previous[field] || []).map(item => [item.id, item]));
    for (const item of current[field] || []) {
      const old = before.get(item.id);
      if (!old) changes.push(`${label} 추가: ${item.title}`);
      else if (JSON.stringify(old) !== JSON.stringify(item)) changes.push(`${label} 변경: ${item.title}`);
      before.delete(item.id);
    }
    for (const item of before.values()) changes.push(`${label} 삭제: ${item.title}`);
  }
  if (previous.report?.content !== current.report?.content) changes.push('보고 내용 변경');
  if (JSON.stringify(previous.progressPlan) !== JSON.stringify(current.progressPlan)) changes.push('달성 목표·측정 단위·비중 변경');
  return changes;
}
