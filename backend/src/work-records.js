import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { DATA, id, now } from './store.js';
import { memberDirectory } from './guidance.js';
import { digest, taskRecordPath } from './task-artifacts.js';
import { isWorkRequest, sessionBelongsToRequest } from '../../shared/work-requests.mjs';
import { progressSummary } from '../../shared/work-progress.mjs';

const live = session => session && ['preparing', 'running', 'stopping'].includes(session.status);
const clip = (value, length = 600) => String(value || '').slice(0, length);
export const recordPath = session => join(DATA, 'sessions', session.id, 'work-record.md');
export const managerStatusPath = member => join(memberDirectory(member), 'team-status.json');
export const reportInstructions = '최종 보고에는 요청받은 지시, 실제 수행한 작업, 결과·변경 파일·산출물, 수행한 검증과 미검증 사항, 차단·미완료 사항, 후속 작업을 구분해 남기세요. 수행하지 않은 일을 완료했다고 기록하지 마세요. 진행 중에는 현재 단계와 차단 사유를 공개 진행 메시지로 짧게 알리세요. 실행 종료와 사용자의 검토 완료는 별개입니다.';

// Preserve the assignment as it was when this attempt began, before tasks/profiles change.
export function requestSnapshot(store, member, kind, details) {
  const task = details.taskId ? store.require('tasks', details.taskId) : null;
  const sourceId = task?.originSessionId || (task?.documentIds || []).map(key => store.get('documents', key)?.sessionId).find(Boolean);
  const source = sourceId ? store.get('sessions', sourceId) : null;
  const manager = member.role === 'member'
    ? store.list('members').find(item => item.role === 'leader' && item.departmentId === member.departmentId)
    : store.list('members').find(item => item.role === 'ceo' && item.id !== member.id);
  const author = task?.createdBy && task.createdBy !== 'user' ? store.get('members', task.createdBy) : null;
  return { version: 1, capturedAt: now(),
    worker: { id: member.id, name: member.name, role: member.role, departmentId: member.departmentId },
    manager: manager ? { id: manager.id, name: manager.name } : null,
    requestedBy: task ? { id: task.createdBy || null, name: author?.name || (task.createdBy === 'user' ? '사용자' : '기록 없음') }
      : { id: details.initiatedBy || 'user', name: store.get('members', details.initiatedBy || 'user')?.name || '사용자' },
    kind, instruction: details.prompt || task?.description || '',
    task: task ? { id: task.id, title: task.title, description: task.description, acceptance: task.acceptance,
      ...(task.goalId ? { goalId: task.goalId, plannedUnits: task.plannedUnits } : {}),
      projectId: task.projectId, departmentId: task.departmentId, assigneeId: task.assigneeId, dependsOn: task.dependsOn, isolation: task.isolation } : null,
    source: source ? { sessionId: source.id, memberId: source.memberId, relation: task.originSessionId ? 'created_from' : 'reference_document', instruction: source.prompt || source.request?.instruction || '' } : null,
    documents: (task?.documentIds || []).map(key => store.get('documents', key)).filter(Boolean)
      .map(doc => ({ id: doc.id, title: doc.title, version: doc.version })),
  };
}

export function managementSnapshot(store, manager, projectId = null) {
  const members = store.list('members').filter(member => member.id !== manager.id
    && (manager.role === 'ceo' || (member.departmentId === manager.departmentId && member.role === 'member')));
  const ids = new Set(members.map(member => member.id));
  const allTasks = store.list('tasks');
  const sessions = store.list('sessions');
  const sessionById = new Map(sessions.map(session => [session.id, session]));
  const tasks = allTasks.filter(task => (manager.role === 'ceo' || task.departmentId === manager.departmentId) && (!projectId || task.projectId === projectId));
  const requests = store.list('requests').filter(request => isWorkRequest(request, allTasks)
    && (!projectId || request.projectId === projectId) && (manager.role === 'ceo' || request.departmentId === manager.departmentId
      || tasks.some(task => task.requestId === request.id)));
  const isWorkSession = session => session.taskId || requests.some(request => sessionBelongsToRequest(session, request.id));
  const scopedSessions = sessions.filter(session => ids.has(session.memberId) && isWorkSession(session) && (!projectId || session.projectId === projectId));
  const snapshot = { capturedAt: now(), managerId: manager.id, projectId,
    requests: requests.map(request => ({ id: request.id, title: request.title, instruction: clip(request.instruction),
      status: request.status, projectId: request.projectId, createdBy: request.createdBy, reportDocumentId: request.reportDocumentId || null,
      pendingApprovalId: request.pendingApprovalId || null, approvedPlanId: request.approvedPlanId || null,
      followupJobId: request.followupJobId || null,
      ...(request.progressPlan ? { summary: request.progressPlan.summary, goal: request.progressPlan.goal,
        achievement: progressSummary(request, allTasks) } : {}) })),
    // Availability is organization-wide even if the requested report covers one project.
    members: members.map(member => {
      const current = sessionById.get(member.currentSessionId);
      const active = live(current) ? current : null;
      const latest = sessions.find(session => session.memberId === member.id && isWorkSession(session) && !live(session));
      const assigned = allTasks.filter(task => task.assigneeId === member.id);
      const heartbeat = active?.heartbeatAt || active?.startedAt;
      return { id: member.id, name: member.name, role: member.role, departmentId: member.departmentId,
        isWorking: active ? true : member.status === 'running' ? null : false,
        state: active?.status || (member.status === 'running' ? 'unknown' : 'idle'),
        observation: active && Date.now() - Date.parse(heartbeat || '') > 45000 ? 'stale' : 'current',
        sessionId: active?.id || null, taskId: active?.taskId || null, projectId: active?.projectId || null,
        title: active?.request?.task?.title || (active ? active.kind : null),
        progress: clip(active?.progress, 300), activityNote: clip(active?.activityNote, 500),
        lastActivityAt: active?.lastActivityAt || null, heartbeatAt: active?.heartbeatAt || null,
        queuedTasks: assigned.filter(task => task.status === 'queued').length,
        blockedTasks: assigned.filter(task => task.status === 'blocked').length,
        reviewTasks: assigned.filter(task => task.status === 'review').length,
        latest: latest ? { sessionId: latest.id, status: latest.status, endedAt: latest.endedAt,
          result: clip(latest.output), error: latest.status === 'completed' ? null : clip(latest.progress),
          recordPath: latest.recordPath || null } : null };
    }),
    tasks: tasks.map(task => ({ id: task.id, title: task.title, status: task.status, projectId: task.projectId,
      assigneeId: task.assigneeId, originSessionId: task.originSessionId || null, sessionId: task.sessionId || null,
      error: clip(task.error, 300), updatedAt: task.updatedAt, integratedAt: task.integratedAt || null })),
    recentExecutions: scopedSessions.filter(session => !live(session)).slice(0, 12).map(session => ({
      sessionId: session.id, memberId: session.memberId, taskId: session.taskId || null, status: session.status,
      instruction: clip(session.request?.instruction || session.prompt, 300), result: clip(session.output),
      endedAt: session.endedAt, error: session.status === 'completed' ? null : clip(session.progress), recordPath: session.recordPath || null,
    })),
  };
  snapshot.coverage = { members: members.length, tasks: tasks.length, executions: scopedSessions.filter(session => !live(session)).length };
  return snapshot;
}

export function managementContext(store, manager, projectId) {
  const snapshot = managementSnapshot(store, manager, projectId);
  return `\n\n담당 조직: ${snapshot.members.length}명 · 작업 ${snapshot.tasks.length}건\n최신 담당 조직 상태 파일: ${managerStatusPath(manager)}\n현황이 필요하면 tars_get_team_activity로 조회하거나 이 파일을 읽고 capturedAt과 heartbeatAt을 확인하세요. heartbeatAt은 감독 서버 확인 시각, lastActivityAt은 AI의 마지막 이벤트 시각입니다. 실행 완료는 작업 검토 완료와 다릅니다. 상세 문서·결과는 tars_get_state의 collection/id로 필요한 항목만 조회하세요.`;
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${id()}.tmp`;
  try { await writeFile(temporary, content, { mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

export async function writeExecutionRecord(store, sessionId) {
  let session = store.require('sessions', sessionId);
  const task = session.taskId ? store.get('tasks', session.taskId) : null;
  if (!session.resultSnapshot) session = store.patch('sessions', sessionId, { resultSnapshot: {
    recordedAt: now(), status: session.status, taskStatus: task?.status || null,
    tasks: (session.taskIds || []).map(key => store.get('tasks', key)).filter(Boolean)
      .map(item => ({ id: item.id, title: item.title, assigneeId: item.assigneeId })),
    documents: (session.documentIds || []).map(key => store.get('documents', key)).filter(Boolean)
      .map(doc => ({ id: doc.id, title: doc.title, kind: doc.kind, version: doc.version })),
  } });
  const request = session.request;
  const result = session.resultSnapshot;
  const history = store.history('sessions', sessionId, { limit: 200 });
  const content = [
    `# ${request?.worker.name || session.memberId} 실행 기록`,
    `- 실행 ID: ${session.id}\n- 작업 ID: ${session.taskId || '없음'}\n- 시작: ${session.startedAt}\n- 종료: ${session.endedAt || '진행 중'}\n- 실행 상태: ${result.status}\n- 기록 시점 작업 상태: ${result.taskStatus || '해당 없음'}\n- 담당 관리자: ${request?.manager?.name || '없음'}\n- 모델: ${session.provider} / ${session.codexAccount || ''} / ${session.model}`,
    request ? '## 받은 지시\n\n' + request.instruction : '## 받은 지시\n\n이전 실행: 실행 당시 요청 스냅샷이 없습니다.\n\n' + (session.prompt || ''),
    request?.source ? `## ${request.source.relation === 'created_from' ? '작업을 생성한 협의 지시' : '참조 문서의 관련 협의'}\n\n원본 실행: ${request.source.sessionId}\n\n${request.source.instruction}` : '',
    session.continuationOf ? `## 사용자 응답으로 이어진 실행\n\n원래 실행: ${session.continuationOf}\n승인·의견 ID: ${session.approvalId}\n이어가기 방식: ${session.continuationMode || '준비 중'}\n\n${session.prompt || ''}` : '',
    request?.task ? `## 배정받은 task\n\n${request.task.title}\n\n${request.task.description}\n\n완료 기준:\n${request.task.acceptance}\n\n참조 문서 버전:\n${request.documents.map(doc => `- ${doc.title} · ${doc.id} · v${doc.version}`).join('\n') || '없음'}` : '',
    (session.steering || []).length ? `## 추가 지시\n\n${session.steering.map(input => `### ${input.createdAt}\n\n${input.prompt}`).join('\n\n')}` : '',
    `## 결과 보고\n\n${session.output || '결과 보고가 없습니다.'}`,
    result.tasks.length ? `## 생성한 task\n\n${result.tasks.map(item => `- ${item.title} · ${item.id} · 담당 ${item.assigneeId || '미배정'}`).join('\n')}` : '',
    result.documents.length ? `## 생성한 문서\n\n${result.documents.map(doc => `- ${doc.title} · ${doc.id} · v${doc.version}`).join('\n')}` : '',
    `## 종료 사유\n\n${session.progress || ''}\n\n작업 디렉토리: ${session.workspace || '미생성'}\n실행 완료는 검토·통합·검증 완료를 의미하지 않습니다.`,
    `## 상태·진행 이력\n\n최근 ${history.events.length} / 전체 ${history.total}건. 전체 이력은 TARS의 실행·작업 이력 API에서 조회합니다.\n\n${history.events.slice().reverse().map(event => `- ${event.at} · ${event.event} · ${event.fromStatus ? `${event.fromStatus} → ` : ''}${event.status || ''} · ${event.message.replace(/\n/g, ' ')}`).join('\n')}`,
  ].filter(Boolean).join('\n\n');
  const path = recordPath(session);
  await atomicWrite(path, content + '\n');
  store.patch('sessions', sessionId, { recordPath: path, recordError: null });
}

export function renderTaskRecord(store, taskId) {
  const task = store.require('tasks', taskId);
  const request = task.requestId ? store.get('requests', task.requestId) : null;
  const reports = store.list('taskReports').filter(item => item.taskId === taskId).sort((a, b) => a.version - b.version);
  const reviews = store.list('taskReviews').filter(item => item.taskId === taskId);
  const history = store.history('tasks', taskId, { limit: 200 });
  const approvals = store.list('workApprovals').filter(item => item.requestId === task.requestId).reverse();
  return [
    `# ${task.title}\n\n작업 ID: ${task.id}\n요청 ID: ${task.requestId || '이전 기록'}\n상태: ${task.status}\n채택된 결과: ${task.acceptedReportId || '없음'}\n담당: ${task.assigneeId || '미배정'}\n검토자: ${task.reviewerId || '미지정'}`,
    `## 원래 요청\n\n${request?.instruction || task.description || ''}`,
    `## 현재 작업 지시\n\n${task.description || ''}\n\n## 완료 기준\n\n${task.acceptance || '미등록'}`,
    task.reworkInstructions ? `## 보완 지시\n\n${task.reworkInstructions}` : '',
    approvals.length ? `## 사용자 협의·승인 기록\n\n${approvals.map(item => `### ${item.kind === 'plan' ? '협의안' : '결과 보고'} v${item.version} · ${item.status}\n\n원래 실행: ${item.sourceSessionId}\n담당 AI: ${item.memberId}\n제출 시각: ${item.createdAt}\n${item.response ? `사용자 응답: ${item.response.decision} · ${item.response.at}\n\n${item.response.comment || '내용 확인 후 승인'}\n후속 실행: ${store.get('workflowJobs', item.followupJobId)?.sessionId || '대기 중'}` : '사용자 응답 없음'}`).join('\n\n')}` : '',
    ...reports.map(report => {
      const review = reviews.find(item => item.reportId === report.id);
      return `## 결과 v${report.version}${report.id === task.acceptedReportId ? ' · 채택됨' : ''}\n\n보고 ID: ${report.id}\n실행 ID: ${report.sessionId || '이전 기록'}\n작성자: ${report.authorId}\n작성 시각: ${report.recordedAt || report.createdAt}\n\n${report.instruction?.task ? `### 제출 당시 지시\n\n${report.instruction.task.description}\n\n완료 기준: ${report.instruction.task.acceptance}\n\n` : ''}${(report.steering || []).map(item => `추가 지시 (${item.createdAt}): ${item.prompt}\n\n`).join('')}${report.content}\n\n### 검토\n\n${review ? `${review.decision} · ${review.authorId} · ${review.createdAt}\n\n${review.rationale}\n\n${review.checks.map(check => `- ${check.criterion}: ${check.status}\n  ${check.evidence}`).join('\n')}\n\n${review.reworkInstructions}` : '검토 기록 없음'}\n\n${report.artifacts?.patchPath ? `변경 패치: ${report.artifacts.patchPath}\n산출물 지문: ${report.artifacts.hash}` : ''}`;
    }),
    `## 실행 기록\n\n${store.list('sessions').filter(item => item.taskId === taskId).reverse().map(session => `- ${session.startedAt} · ${session.kind} · ${session.status} · ${session.recordPath || recordPath(session)}`).join('\n') || '없음'}`,
    `## 상태·지시 이력\n\n최근 ${history.events.length} / 전체 ${history.total}건. 전체 이력은 작업 이력 API에서 조회합니다.\n\n${history.events.slice().reverse().map(event => `- ${event.at} · ${event.actor} · ${event.message}${event.details?.prompt ? `\n  ${event.details.prompt}` : ''}`).join('\n')}`,
  ].filter(Boolean).join('\n\n') + '\n';
}

// No model calls: mirror the database for managers that are already running and can read files.
export class WorkStatusFiles {
  constructor(store) { this.store = store; this.queue = Promise.resolve(); this.schedule = this.schedule.bind(this); this.hashes = new Map(); }
  start() { this.store.on('change', this.schedule); this.schedule(); }
  schedule() {
    if (this.timer || this.closing) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 1500);
  }
  flush() {
    if (this.writing) { this.again = true; return this.queue; }
    this.writing = true;
    const write = async () => {
      for (const task of this.store.list('tasks')) {
        const content = renderTaskRecord(this.store, task.id);
        const hash = digest(content);
        if (this.hashes.get(task.id) === hash) continue;
        try {
          await atomicWrite(taskRecordPath(task.id), content);
          this.hashes.set(task.id, hash);
          if (task.recordError) this.store.patch('tasks', task.id, { recordError: null });
        } catch (error) {
          if (task.recordError !== error.message) this.store.patch('tasks', task.id, { recordError: error.message });
        }
      }
      for (const manager of this.store.list('members').filter(member => ['ceo', 'leader'].includes(member.role))) {
        await atomicWrite(managerStatusPath(manager), JSON.stringify(managementSnapshot(this.store, manager), null, 2));
      }
      for (const member of this.store.list('members')) {
        const approved = this.store.list('tasks').filter(task => task.acceptedReportId && task.assigneeId === member.id);
        const content = '# 검토된 작업 인계\n\n' + (approved.slice(0, 12).map(task =>
          `- ${task.title} · 프로젝트 ${task.projectId || '미지정'}\n  결과 ${task.acceptedReportId}\n  ${taskRecordPath(task.id)}`).join('\n') || '검토된 결과가 없습니다.') + '\n';
        const key = `member:${member.id}`;
        if (this.hashes.get(key) !== digest(content)) { await atomicWrite(join(memberDirectory(member), 'context-summary.md'), content); this.hashes.set(key, digest(content)); }
      }
    };
    this.queue = this.queue.then(write).catch(error => {
      // A failed mirror must not rewrite a task's execution outcome or loop forever.
      if (this.lastError !== error.message) { this.lastError = error.message; this.store.event(`관리자 상태 파일 저장 실패: ${error.message}`, { level: 'error' }); }
    }).finally(() => { this.writing = false; if (this.again && !this.closing) { this.again = false; this.schedule(); } });
    return this.queue;
  }
  async close() { this.closing = true; clearTimeout(this.timer); this.store.off('change', this.schedule); await this.queue; await this.flush(); }
}
