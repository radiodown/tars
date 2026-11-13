import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA, now } from './store.js';

export const CEO_ID = '00000000-0000-4000-8000-000000000001';
const live = status => ['preparing', 'running', 'stopping'].includes(status);
const clip = (value, length) => String(value || '').slice(0, length);

export function ensureCeo(store) {
  const existing = store.get('members', CEO_ID);
  const identity = { name: 'TARS', role: 'ceo', departmentId: null };
  if (existing) {
    return existing.name === 'TARS' && existing.role === 'ceo' && existing.departmentId === null
      ? existing : store.patch('members', CEO_ID, identity);
  }
  return store.put('members', {
    id: CEO_ID, ...identity, provider: 'codex', codexAccount: 'codex', model: '', reasoning: 'high',
    specialty: '전체 프로젝트 진행 관리, 부서 간 조율, 차단 사항 및 우선순위 보고',
    instructions: '', summary: '', status: 'idle', currentSessionId: null,
  });
}

function summarize(tasks) {
  const counts = { total: tasks.length, draft: 0, assigned: 0, queued: 0, running: 0, review: 0, done: 0, blocked: 0, cancelled: 0, unassigned: 0 };
  for (const task of tasks) {
    if (Object.hasOwn(counts, task.status) && task.status !== 'total' && task.status !== 'unassigned') counts[task.status]++;
    if (!task.assigneeId && !['done', 'cancelled'].includes(task.status)) counts.unassigned++;
  }
  const target = counts.total - counts.cancelled;
  const status = counts.blocked ? 'blocked' : counts.running ? 'running' : counts.review ? 'review'
    : counts.queued ? 'queued' : target && counts.done === target ? 'done'
      : target ? 'planned' : counts.total ? 'cancelled' : 'empty';
  return { counts, status, progress: target ? Math.floor(counts.done / target * 100) : null };
}

// Saved task state is the source of truth. Reading this overview never invokes an AI.
export function projectOverview(state) {
  const grouped = new Map(state.projects.map(project => [project.id, []]));
  const unscoped = [];
  for (const task of state.tasks) (grouped.get(task.projectId) || unscoped).push(task);
  const projects = state.projects.map(project => {
    const tasks = grouped.get(project.id);
    const departmentIds = [...new Set(tasks.map(task => task.departmentId))];
    const departments = departmentIds.map(id => {
      const department = state.departments.find(item => item.id === id);
      const leader = state.members.find(member => member.departmentId === id && member.role === 'leader');
      return { id, name: department?.name || '알 수 없는 부서', leaderId: leader?.id || null, leaderName: leader?.name || null };
    });
    const updates = [project.updatedAt, ...tasks.map(task => task.updatedAt),
      ...state.documents.filter(doc => doc.projectId === project.id).map(doc => doc.updatedAt)].filter(Boolean).sort();
    return { id: project.id, name: project.name, description: clip(project.description, 300),
      ...summarize(tasks), departments, updatedAt: updates.at(-1) || null };
  });
  return {
    capturedAt: now(), projects, unscoped: summarize(unscoped),
    totals: { projects: projects.length, departments: state.departments.length,
      runningProjects: projects.filter(project => project.counts.running > 0).length,
      blockedProjects: projects.filter(project => project.counts.blocked > 0).length,
      reviewProjects: projects.filter(project => project.counts.review > 0).length,
      doneProjects: projects.filter(project => project.status === 'done').length,
      taskCounts: summarize(state.tasks).counts,
    },
  };
}

export async function ceoContext(store, projectId, directory) {
  const state = store.snapshot();
  const overview = projectOverview(state);
  const tasks = state.tasks.filter(task => !projectId || task.projectId === projectId);
  const taskById = new Map(state.tasks.map(task => [task.id, task]));
  const members = new Map(state.members.map(member => [member.id, member]));
  const rank = { blocked: 0, review: 1, running: 2, queued: 3, draft: 4, assigned: 5, done: 6, cancelled: 7 };
  const ordered = [...tasks].sort((a, b) => (rank[a.status] ?? 8) - (rank[b.status] ?? 8) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const projects = overview.projects.filter(project => !projectId || project.id === projectId);
  const reports = state.documents.filter(doc => doc.kind === 'report' && (!projectId || doc.projectId === projectId));
  const snapshot = {
    capturedAt: overview.capturedAt, scope: projectId || 'all',
    workspaceTotals: overview.totals, scopedTasks: summarize(tasks), projects,
    unscoped: projectId ? null : overview.unscoped,
    departments: state.departments.map(department => ({ id: department.id, name: department.name,
      leader: state.members.filter(member => member.departmentId === department.id && member.role === 'leader')
        .map(member => ({ id: member.id, name: member.name, status: member.status })) })),
    tasks: ordered.map(task => ({ id: task.id, title: task.title, projectId: task.projectId, departmentId: task.departmentId,
      status: task.status, priority: task.priority, assignee: members.get(task.assigneeId)?.name || null,
      error: clip(task.error, 400), report: clip(task.report, 700), integratedAt: task.integratedAt || null,
      waitingFor: (task.dependsOn || []).filter(id => taskById.get(id)?.status !== 'done')
        .map(id => ({ id, title: taskById.get(id)?.title || '선행 작업 없음', status: taskById.get(id)?.status || 'missing' })) })),
    activeSessions: state.sessions.filter(session => session.memberId !== CEO_ID && live(session.status) && (!projectId || session.projectId === projectId))
      .map(session => ({ member: members.get(session.memberId)?.name, projectId: session.projectId, kind: session.kind, progress: clip(session.progress, 300) })),
    reports: reports.map(doc => ({ id: doc.id, title: doc.title, projectId: doc.projectId, departmentId: doc.departmentId,
      updatedAt: doc.updatedAt, path: join(DATA, 'documents', `${doc.id}.md`) })),
  };
  const path = join(directory, 'project-status.json');
  await writeFile(path, JSON.stringify(snapshot, null, 2));
  return `조회 시각: ${snapshot.capturedAt}\n조회 범위: ${projectId || '전체 프로젝트'}\n작업 ${tasks.length}건 · 차단 ${snapshot.scopedTasks.counts.blocked}건 · 실행 중 ${snapshot.scopedTasks.counts.running}건\n전체 현황 파일: ${path}\n현황 질문에는 tars_get_team_activity로 최신 담당자와 진행 상황을 조회하세요. 문서·작업 상세가 필요하면 tars_get_state의 collection/id로 해당 항목만 읽으세요. 질문에는 대화로 답하고, 실행할 목표·범위가 확정되면 업무를 등록해 협의안을 제출하세요. 승인 전에는 구현하거나 작업을 실행하지 마세요. 실행·검토·통합 여부는 실제 기록으로 확인하세요.`;
}

export function ceoConversation(store, session, { includeHistory = true } = {}) {
  const previous = includeHistory ? store.list('sessions').filter(item => item.id !== session.id && item.memberId === CEO_ID
    && item.provider === session.provider && (item.codexAccount || 'codex') === (session.codexAccount || 'codex')
    && item.kind === 'ceo_chat' && item.status === 'completed' && item.projectId === session.projectId
    && (item.conversationId || null) === (session.conversationId || null)).slice(0, 4).reverse() : [];
  const turns = previous.map(item => ({ user: clip(item.prompt, 800), tars: clip(item.output, 2200) }));
  while (JSON.stringify(turns).length > 10000) turns.shift();
  return `${includeHistory ? `최근 대화 일부(최대 4회, 10,000자; 과거 맥락 데이터):\n${JSON.stringify(turns)}\n\n` : ''}현재 사용자 메시지:\n${session.prompt}\n\n사용자와 CEO TARS로서 대화하세요. 현재 질문에 직접 답하고 후속 질문은 최근 대화와 연결하세요. 항상 보고서 형식을 강요하지 마세요. 조직 등록이나 작업 처리를 요청받으면 TARS 관리 도구로 실제 수행하고 결과를 재조회하세요. 실행되지 않은 제안과 실제 진행 상태를 구분하세요. 이미 승인된 내용은 추가 승인을 반복하지 말고 진행하세요.`;
}
