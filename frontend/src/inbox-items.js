import { approvalSummaries, pendingApprovals } from './approval-state.js';
import { workflowStages } from './api.js';

export const inboxStorageKey = 'tars:inbox-dismissals';

export function readInboxDismissals(value) {
  try {
    const parsed = JSON.parse(value === undefined ? localStorage.getItem(inboxStorageKey) : value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function inboxItems(data) {
  if (!data) return [];
  const index = records => new Map((records || []).map(record => [record.id, record]));
  const requests = index(data.requests);
  const sessions = index(data.sessions);
  const jobs = index(data.workflowJobs);
  const members = index(data.members);
  const projects = index(data.projects);
  const tasks = index(data.tasks);
  const items = [];
  function add(type, record, { category, label, title, reason, requestId, memberId, projectId, session, task }) {
    const request = requests.get(requestId || task?.requestId || session?.requestId);
    const memberName = members.get(memberId || task?.assigneeId || session?.memberId || request?.createdBy)?.name;
    const context = [projects.get(projectId || request?.projectId || task?.projectId || session?.projectId)?.name, memberName].filter(Boolean);
    const date = record.updatedAt || record.createdAt || '';
    items.push({ id: `${type}:${type === 'interaction' ? session.id + ':' : ''}${record.id}`,
      revision: JSON.stringify([date, reason]), date, type, category, label, title, reason, context, memberName, request, record, session, task });
  }

  for (const question of data.inputRequests || []) {
    if (question.status !== 'pending') continue;
    const session = sessions.get(question.sessionId);
    const requestId = question.requestId || session?.requestId;
    add('question', question, { category: 'action', label: '답변 필요', title: requests.get(requestId)?.title || 'AI의 질문',
      reason: question.questions?.[0]?.question, requestId, session, memberId: question.memberId });
  }
  for (const session of sessions.values()) {
    for (const interaction of session.interactions || []) {
      if (interaction.status !== 'pending') continue;
      const request = requests.get(session.requestId);
      add('interaction', interaction, { category: 'action', label: interaction.kind === 'question' ? '답변 필요' : '실행 응답 필요',
        title: request?.title || interaction.title,
        reason: interaction.questions?.[0]?.question || interaction.message || (request && interaction.title), session });
    }
  }
  for (const { item, title, reason, kindLabel } of approvalSummaries(data, pendingApprovals(data))) {
    add('approval', item, { category: 'action', label: kindLabel, title, reason,
      requestId: item.requestId, memberId: item.memberId });
  }

  const blockedTaskJobs = new Map();
  for (const job of jobs.values()) {
    if (job.status !== 'blocked') continue;
    const task = tasks.get(job.taskId);
    if (task && job.error) blockedTaskJobs.set(task.id, job.error);
    add('job', job, { category: 'blocked', label: `${workflowStages[job.kind] || '후속 실행'} · 차단`,
      title: task?.title || requests.get(job.requestId)?.title || '후속 실행',
      reason: job.error || '후속 실행 기록을 확인하세요.', requestId: job.requestId, memberId: job.memberId, task });
  }

  const requestsWithOwnNotice = new Set();
  for (const request of requests.values()) {
    const reason = request.executionBlockReason;
    if (!reason || request.paused || request.status === 'accepted') continue;
    const followup = jobs.get(request.followupJobId);
    requestsWithOwnNotice.add(request.id);
    if (request.pendingApprovalId || ['queued', 'running', 'blocked'].includes(followup?.status)) continue;
    add('request', request, { category: 'blocked', label: '업무 차단', title: request.title, reason, requestId: request.id });
  }

  for (const task of tasks.values()) {
    const reason = task.waitReason || task.error;
    if (task.status !== 'blocked' && !task.waitReason) continue;
    if (blockedTaskJobs.has(task.id) && blockedTaskJobs.get(task.id) === reason) continue;
    if (task.status !== 'blocked' && requestsWithOwnNotice.has(task.requestId)
      && task.waitReason === requests.get(task.requestId)?.executionBlockReason) continue;
    add('task', task, { category: task.status === 'blocked' ? 'blocked' : 'waiting', label: task.status === 'blocked' ? '작업 차단' : '작업 대기',
      title: task.title, reason: reason || '작업 기록을 확인하세요.', task });
  }

  const priority = { action: 0, blocked: 1, waiting: 2 };
  return items.sort((a, b) => priority[a.category] - priority[b.category] || b.date.localeCompare(a.date));
}

export const isInboxDismissed = (item, dismissals) => dismissals[item.id] === item.revision;
