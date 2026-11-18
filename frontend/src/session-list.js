import { isWorkRequest } from '../../shared/work-requests.mjs';
import { isLive } from './api.js';

export const sessionTitle = (session, data) => session.kind === 'ceo_chat' ? 'TARS와 대화'
  : session.kind === 'member_chat' ? 'AI와 대화'
  : session.kind === 'oversight' ? '프로젝트 총괄 보고' : session.kind === 'plan' ? '협의 및 작업 설계'
    : session.kind === 'review' ? '결과 보고' : session.kind === 'task_review' ? '작업 결과 검토'
      : session.kind === 'request_report' ? '요청 최종 보고' : session.kind === 'request_escalation' ? '차단 사항 보고'
        : session.kind === 'user_followup' ? '승인·의견 후속 처리' : session.request?.task?.title || data.tasks?.find(task => task.id === session.taskId)?.title || '작업 수행';

export const sessionDate = session => session.startedAt || session.createdAt || '';
const newest = (a, b) => sessionDate(b).localeCompare(sessionDate(a)) || b.id.localeCompare(a.id);
const index = records => new Map((records || []).map(record => [record.id, record]));
function by(records, key) {
  const map = new Map();
  for (const record of records || []) {
    if (!map.has(record[key])) map.set(record[key], []);
    map.get(record[key]).push(record);
  }
  return map;
}

// A run may contribute to several registered requests. Keep it visible in each
// relevant work item, but do not turn legacy per-message requests into groups.
export function sessionGroups(data) {
  const tasks = index(data.tasks), members = index(data.members), projects = index(data.projects);
  const tasksByRequest = by(data.tasks, 'requestId'), jobsByRequest = by(data.workflowJobs, 'requestId');
  const requests = index((data.requests || []).filter(request => isWorkRequest(request, data.tasks) || request.pendingApprovalId));
  const sources = by([...requests.values()], 'sourceSessionId');
  const approvals = index(data.workApprovals);
  const questions = new Set((data.inputRequests || []).filter(item => item.status === 'pending').map(item => item.sessionId));
  const sessions = index(data.sessions);
  const groups = new Map();
  for (const session of sessions.values()) {
    const task = tasks.get(session.taskId);
    const workIds = [...new Set([session.requestId, ...(session.requestIds || []), task?.requestId,
      ...(sources.get(session.id) || []).map(request => request.id)])].filter(id => requests.has(id));
    let targets = workIds.map(id => ({ id: `request:${id}`, request: requests.get(id), title: requests.get(id).title || '등록된 업무', kind: '업무' }));
    if (!targets.length) {
      if (session.taskId) targets = [{ id: `task:${session.taskId}`, task, title: task?.title || sessionTitle(session, data), kind: '작업' }];
      else if (['ceo_chat', 'member_chat'].includes(session.kind)) targets = [{
        id: `chat:${session.memberId}:${session.conversationId || 'default'}`,
        title: `${members.get(session.memberId)?.name || '이전 AI'}와 대화`, kind: '대화',
      }];
      else {
        let root = session;
        const seen = new Set([root.id]);
        while (sessions.has(root.continuationOf) && !seen.has(root.continuationOf)) {
          root = sessions.get(root.continuationOf); seen.add(root.id);
        }
        targets = [{ id: `session:${root.id}`, title: sessionTitle(root, data), kind: '실행' }];
      }
    }
    for (const target of targets) {
      if (!groups.has(target.id)) groups.set(target.id, { ...target, sessions: [] });
      groups.get(target.id).sessions.push(session);
    }
  }
  return [...groups.values()].map(group => {
    group.sessions.sort(newest);
    const { request } = group;
    const work = request ? tasksByRequest.get(request.id) || [] : group.task ? [group.task] : [];
    const jobs = request ? jobsByRequest.get(request.id) || [] : [];
    const approval = approvals.get(request?.pendingApprovalId);
    const waiting = group.sessions.some(session => isLive(session.status) && (questions.has(session.id)
      || ['waiting_input', 'waiting_approval'].includes(session.interactionState || session.status)
      || session.interactions?.some(item => item.status === 'pending')));
    const latestRuns = new Map();
    for (const session of group.sessions) {
      const key = `${session.taskId || session.memberId || ''}:${session.kind || ''}`;
      if (!latestRuns.has(key)) latestRuns.set(key, session);
    }
    const blocked = request?.status !== 'accepted' && (request?.executionBlockReason || request?.status === 'blocked'
      || work.some(task => !['done', 'cancelled'].includes(task.status) && (task.status === 'blocked' || task.waitReason))
      || jobs.some(job => job.status === 'blocked')
      || [...latestRuns.values()].some(session => ['failed', 'interrupted', 'blocked'].includes(session.status)));
    const needsAttention = Boolean(waiting || approval?.status === 'pending' || blocked);
    const active = group.sessions.some(session => isLive(session.status))
      || work.some(task => ['queued', 'running'].includes(task.status)) || jobs.some(job => ['queued', 'running'].includes(job.status));
    const status = waiting ? 'waiting_input' : approval?.status === 'pending' ? (approval.kind === 'plan' ? 'awaiting_approval' : 'awaiting_acceptance')
      : blocked ? 'blocked' : active ? 'running' : request?.status === 'accepted' ? 'accepted' : 'idle';
    const statusLabel = status === 'waiting_input' ? '응답 필요' : status === 'blocked' ? '확인 필요' : status === 'running' ? '진행 중' : status === 'idle' ? '실행 종료' : null;
    const memberIds = [...new Set(group.sessions.map(session => session.memberId))];
    const projectIds = [...new Set([request?.projectId, group.task?.projectId, ...group.sessions.map(session => session.projectId)].filter(Boolean))];
    return { ...group, latest: group.sessions[0], needsAttention, active, status, statusLabel, memberIds, projectIds,
      searchText: [group.title, ...work.map(task => task.title), ...memberIds.map(id => members.get(id)?.name),
        ...projectIds.map(id => projects.get(id)?.name), ...group.sessions.map(session => sessionTitle(session, data))].filter(Boolean).join(' ').toLocaleLowerCase() };
  }).sort((a, b) => Number(b.needsAttention) - Number(a.needsAttention) || Number(b.active) - Number(a.active) || newest(a.latest, b.latest));
}

export function filterSessionGroups(groups, { status = 'all', search = '', memberId = '', days = '', now = Date.now() } = {}) {
  const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const since = days ? now - Number(days) * 86400000 : null;
  return groups.filter(group => (status !== 'attention' || group.needsAttention) && (status !== 'active' || group.active)
    && (!memberId || group.memberIds.includes(memberId)) && terms.every(term => group.searchText.includes(term))
    && (since === null || Date.parse(sessionDate(group.latest)) >= since));
}
