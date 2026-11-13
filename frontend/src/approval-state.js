export function pendingApprovals(data, memberId) {
  return (data.workApprovals || []).filter(item => item.status === 'pending'
    && (!memberId || item.memberId === memberId)
    && data.requests.some(request => request.id === item.requestId && request.pendingApprovalId === item.id));
}

export function approvalChanges(previous, current) {
  if (!previous) return [];
  const changes = [];
  for (const [field, label] of [['title', '업무 제목'], ['instruction', '목표·범위'], ['projectId', '프로젝트']]) {
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
  return changes;
}
