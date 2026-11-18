import { z } from 'zod';

const filters = {
  departmentId: z.string().uuid().optional(), projectId: z.string().uuid().optional(), memberId: z.string().uuid().optional(),
};
export const teamActivitySchema = z.object({ ...filters,
  limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).max(100000).default(0),
}).strict();
export const teamActivityQuerySchema = z.object({ ...filters,
  limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(100000).default(0),
}).strict();
const live = session => ['preparing', 'running', 'waiting_input', 'stopping'].includes(session?.status);
const timestamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
const index = values => new Map(values.map(value => [value.id, value]));

// Whitelist public fields; never return raw sessions, tool arguments, or reasoning.
// Also used by the CLI/MCP compatibility path against a server awaiting restart.
export function teamActivitySnapshot(store, input = {}, clock = Date.now()) {
  const query = teamActivitySchema.parse(input);
  const members = store.list('members'), sessions = store.list('sessions'), tasks = store.list('tasks');
  const departments = index(store.list('departments')), projects = index(store.list('projects'));
  const requests = store.list('requests'), approvals = index(store.list('workApprovals'));
  const sessionById = index(sessions), taskById = index(tasks), requestById = index(requests);
  const tokens = sessions.map(session => session.processToken).filter(value => typeof value === 'string' && value.length);
  const clean = value => {
    let result = typeof value === 'string' ? value : '';
    for (const token of tokens) result = result.split(token).join('[redacted]');
    return result;
  };
  const byMember = new Map();
  for (const session of sessions) {
    if (!byMember.has(session.memberId)) byMember.set(session.memberId, []);
    byMember.get(session.memberId).push(session);
  }
  for (const list of byMember.values()) list.sort((a, b) =>
    (timestamp(b.startedAt || b.createdAt) || 0) - (timestamp(a.startedAt || a.createdAt) || 0));
  const activeFor = member => {
    const current = sessionById.get(member.currentSessionId);
    return current?.memberId === member.id && live(current) ? current : (byMember.get(member.id) || []).find(live);
  };
  const selected = members.filter(member => {
    if (query.memberId && member.id !== query.memberId) return false;
    if (query.departmentId && member.departmentId !== query.departmentId) return false;
    if (!query.projectId) return true;
    return activeFor(member)?.projectId === query.projectId || departments.get(member.departmentId)?.projectId === query.projectId
      || tasks.some(task => task.assigneeId === member.id && task.projectId === query.projectId)
      || requests.some(request => request.createdBy === member.id && request.projectId === query.projectId);
  }).sort((a, b) => a.id.localeCompare(b.id));
  const entries = selected.slice(query.offset, query.offset + query.limit).map(member => {
    const truncatedFields = [];
    function excerpt(value, field, length = 400, tail = false) {
      const full = clean(value);
      if (full.length > length) truncatedFields.push(field);
      return (tail ? full.slice(-length) : full.slice(0, length)) || null;
    }
    const active = activeFor(member);
    const current = sessionById.get(member.currentSessionId);
    const inconsistent = !active && (member.status === 'running' || (member.currentSessionId && (!current || current.memberId !== member.id)));
    const age = active ? clock - timestamp(active.heartbeatAt) : NaN;
    const observation = inconsistent || (active && (!Number.isFinite(age) || age < 0)) ? 'unknown'
      : active && age > 45000 ? 'stale' : 'current';
    const state = inconsistent ? 'unknown' : active?.status || 'idle';
    const task = active?.taskId ? taskById.get(active.taskId) : null;
    const requestId = active?.requestId || task?.requestId || null;
    const work = requestById.get(requestId);
    const instruction = active?.kind === 'user_followup' && work?.instruction ? work.instruction
      : active?.request?.instruction || active?.prompt || task?.description;
    const projectId = active?.projectId || task?.projectId || null;
    const activity = active ? store.get('sessionActivities', active.id) : null;
    const message = activity?.items?.findLast(item => item.kind === 'message' && item.text);
    const tool = activity?.items?.findLast(item => ['command', 'tool', 'search', 'files'].includes(item.kind) && item.status === 'running');
    const assigned = tasks.filter(item => item.assigneeId === member.id && (!query.projectId || item.projectId === query.projectId));
    const pending = requests.filter(item => (!query.projectId || item.projectId === query.projectId)
      && (item.createdBy === member.id || item.id === requestId || assigned.some(value => value.requestId === item.id))
      && approvals.get(item.pendingApprovalId)?.status === 'pending');
    const latest = (byMember.get(member.id) || []).find(item => !live(item) && (!query.projectId || item.projectId === query.projectId));
    const latestTask = taskById.get(latest?.taskId);
    const steering = active?.steering?.at(-1);
    const relevantTasks = assigned.filter(item => !['done', 'cancelled'].includes(item.status));
    const publicText = message?.text || active?.output || active?.activityNote;
    return {
      id: member.id, name: excerpt(member.name, 'name', 200), role: member.role,
      department: member.departmentId ? { id: member.departmentId, name: excerpt(departments.get(member.departmentId)?.name, 'department.name', 200) } : null,
      state, observation, isWorking: observation === 'current' ? Boolean(active) : null,
      sessionId: active?.id || null, sessionKind: active?.kind || null,
      project: projectId ? { id: projectId, name: excerpt(projects.get(projectId)?.name, 'project.name', 200) } : null,
      requestId, workRegistered: Boolean(work), workStatus: work?.status || null,
      taskId: active?.taskId || null, taskStatus: task?.status || null,
      title: excerpt(task?.title || active?.request?.task?.title || work?.title, 'title', 200),
      instruction: excerpt(instruction, 'instruction', 600),
      invocation: active?.kind === 'user_followup' ? excerpt(active.prompt, 'invocation', 240) : null,
      latestSteering: steering ? { text: excerpt(steering.prompt, 'latestSteering.text'), at: steering.createdAt || null } : null,
      progress: excerpt(active?.progress, 'progress', 240),
      publicMessage: publicText ? { text: excerpt(publicText, 'publicMessage.text', 600, true),
        source: message ? 'sessionActivities.message' : active?.output ? 'session.output' : 'session.activityNote',
        at: message?.endedAt || message?.startedAt || active?.lastActivityAt || null, verbatim: true } : null,
      currentTool: excerpt(tool?.title || (/^(작업 중:|도구 호출:|명령 실행:)/.test(active?.progress || '') ? active.progress : ''), 'currentTool', 240),
      heartbeatAt: active?.heartbeatAt || null, lastActivityAt: active?.lastActivityAt || null,
      taskCounts: Object.fromEntries(['draft', 'assigned', 'queued', 'running', 'blocked', 'review', 'done', 'cancelled']
        .map(status => [status, assigned.filter(item => item.status === status).length])),
      pendingApprovals: pending.slice(0, 5).map(item => ({ requestId: item.id,
        title: excerpt(item.title, `approval.${item.id}.title`, 200), approvalId: item.pendingApprovalId,
        kind: approvals.get(item.pendingApprovalId).kind })),
      pendingApprovalCount: pending.length,
      tasks: relevantTasks.slice(0, 5).map(item => ({ id: item.id, title: excerpt(item.title, `task.${item.id}.title`, 200),
        status: item.status, requestId: item.requestId || null, error: excerpt(item.error, `task.${item.id}.error`, 240) })),
      latestExecution: latest ? { sessionId: latest.id, status: latest.status, endedAt: latest.endedAt || null,
        taskId: latest.taskId || null, taskStatus: latestTask?.status || null, recordPath: latest.recordPath || null } : null,
      recordPath: active?.recordPath || null,
      truncated: { fields: truncatedFields, tasks: relevantTasks.length > 5, approvals: pending.length > 5 },
    };
  });
  return { capturedAt: new Date(clock).toISOString(), source: 'team-activity', filters: query,
    freshnessThresholdMs: 45000,
    coverage: { organizationMembers: members.length, matchedMembers: selected.length, returnedMembers: entries.length },
    nextOffset: query.offset + entries.length < selected.length ? query.offset + entries.length : null,
    members: entries };
}

export function teamActivityFromState(state, query) {
  const store = { list: kind => state[kind] || [], get: (kind, id) => (state[kind] || []).find(item => item.id === id) };
  return { ...teamActivitySnapshot(store, query), source: 'state-fallback',
    compatibilityNote: '서버가 새 API를 아직 제공하지 않아 /api/state를 요약했습니다. 구조화된 활동 항목은 없을 수 있습니다.' };
}
