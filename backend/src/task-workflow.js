import { id, now } from './store.js';
import { fail, workRequestSchema, workResultSchema, taskReviewSchema } from './contracts.js';
import { isWorkRequest, sessionBelongsToRequest } from '../../shared/work-requests.mjs';
import { WorkApprovals } from './work-approvals.js';
import { assertCurrentArtifacts, captureArtifacts, completionCriteria, digest, renderResult, specificationHash, taskRecordPath } from './task-artifacts.js';

const live = session => ['preparing', 'running', 'stopping'].includes(session?.status);
const terminal = task => ['done', 'cancelled'].includes(task.status);
export const workflowKinds = ['task_review', 'request_report', 'request_escalation'];

export class TaskWorkflow {
  constructor(store) { this.store = store; this.approvals = new WorkApprovals(store); }
  specificationHash(taskId) { return specificationHash(this.store, this.store.require('tasks', taskId)); }
  request(instruction, projectId = null, actor = 'user', extra = {}) {
    return this.store.put('requests', { instruction, title: instruction.slice(0, 160), projectId,
      createdBy: actor, status: 'open', paused: false, ...extra }, { actor });
  }
  registerRequest(raw, identity) {
    const input = workRequestSchema.parse(raw);
    const member = this.store.get('members', identity.actor);
    const session = identity.session && this.store.require('sessions', identity.session.id);
    if (!member || !['leader', 'ceo'].includes(member.role) || !session
      || session.memberId !== member.id || !['preparing', 'running'].includes(session.status)
      || workflowKinds.includes(session.kind)) fail('업무는 대화 중인 팀장 또는 CEO AI가 등록합니다.', 403);
    if (input.projectId) this.store.require('projects', input.projectId);
    if (session.projectId && session.projectId !== input.projectId) fail('현재 대화와 같은 프로젝트의 업무를 등록하세요.', 400);
    return this.store.transaction(() => {
      let request;
      if (input.requestId) {
        request = this.requireWork(input.requestId, input.projectId, member.id);
      } else {
        request = this.request(input.instruction, input.projectId, member.id, {
          title: input.title, registeredAt: now(), departmentId: member.departmentId, approvalRequired: true,
          sourceSessionId: session.id, conversationId: session.conversationId || null,
        });
      }
      this.linkSession(request.id, session.id);
      return request;
    });
  }
  requireWork(requestId, projectId, actor = 'user') {
    if (!requestId) fail('먼저 팀장 또는 CEO가 업무를 등록하고 requestId로 작업을 연결하세요.', 400);
    const request = this.store.require('requests', requestId);
    const tasks = this.store.list('tasks');
    if (!isWorkRequest(request, tasks)) fail('대화 기록은 업무가 아닙니다. 업무를 먼저 등록하세요.', 400);
    if (request.projectId !== projectId) fail('같은 업무의 작업은 같은 프로젝트에 속해야 합니다.', 400);
    const member = actor === 'user' ? null : this.store.require('members', actor);
    if (member && (member.role === 'member' || (member.role === 'leader'
      && request.departmentId && request.departmentId !== member.departmentId))) fail('담당 팀장 또는 CEO만 이 업무를 관리할 수 있습니다.', 403);
    return request;
  }
  linkSession(requestId, sessionId) {
    if (!sessionId) return;
    const session = this.store.require('sessions', sessionId);
    this.store.patch('sessions', session.id, { requestId,
      requestIds: [...new Set([...(session.requestIds || []), session.requestId, requestId].filter(Boolean))] });
  }
  pauseRequest(requestId) {
    return this.store.transaction(() => {
      for (const job of this.store.list('workflowJobs').filter(item => item.requestId === requestId && ['queued', 'running'].includes(item.status))) {
        this.store.patch('workflowJobs', job.id, { status: 'cancelled', error: '요청의 자동 진행이 중지되었습니다.' });
      }
      return this.store.patch('requests', requestId, { paused: true }, { actor: 'user' });
    });
  }
  resumeRequest(requestId) {
    return this.store.transaction(() => {
      for (const job of this.store.list('workflowJobs').filter(item => item.requestId === requestId && item.status === 'cancelled' && !item.sessionId)) {
        const task = job.taskId ? this.store.get('tasks', job.taskId) : null;
        if (task && (task.status !== 'review' || task.latestReportId !== job.reportId || task.automationPaused)) continue;
        this.store.patch('workflowJobs', job.id, { status: 'queued', error: null });
      }
      return this.store.patch('requests', requestId, { paused: false }, { actor: 'user' });
    });
  }
  attachTask(input, actor = 'user', requestId = null, originSessionId = null) {
    return this.store.transaction(() => {
      const request = this.requireWork(requestId, input.projectId, actor);
      this.linkSession(request.id, originSessionId);
      this.store.patch('requests', request.id, { status: 'open', reportDocumentId: null });
      return this.store.put('tasks', { ...input, requestId: request.id, originSessionId,
        status: input.assigneeId ? 'assigned' : 'draft', createdBy: actor, reworkCount: 0,
        latestReportId: null, acceptedReportId: null, automationPaused: false }, { actor });
    });
  }
  reviewer(task) {
    return this.store.list('members').find(member => member.role === 'leader' && member.departmentId === task.departmentId && member.id !== task.assigneeId)
      || this.store.list('members').find(member => member.role === 'ceo' && member.id !== task.assigneeId);
  }
  job(kind, key, values) {
    const jobId = digest([kind, key]);
    return this.store.get('workflowJobs', jobId) || this.store.put('workflowJobs', { id: jobId, kind, status: 'queued', ...values });
  }
  cancelJobs(taskId, reason, status = 'cancelled') {
    for (const job of this.store.list('workflowJobs').filter(job => job.taskId === taskId && ['queued', 'running'].includes(job.status))) {
      this.store.patch('workflowJobs', job.id, { status, error: reason });
    }
  }
  queueTask(taskId, actor = 'user', { automatic = false } = {}) {
    const task = this.store.require('tasks', taskId);
    this.approvals.assertExecutable(task.requestId);
    if (!['draft', 'assigned', 'blocked', 'review'].includes(task.status)) fail('현재 상태에서는 작업을 실행할 수 없습니다.');
    if (!task.acceptance?.trim()) fail('작업 실행 전에 완료 기준을 입력하세요.', 400);
    if (this.store.list('sessions').some(session => session.taskId === task.id && live(session))) fail('이 작업의 실행 또는 검토가 아직 종료되지 않았습니다.');
    return this.store.transaction(() => {
      this.cancelJobs(task.id, '새 실행으로 대체되었습니다.', 'superseded');
      if (task.requestId) this.store.patch('requests', task.requestId, { status: 'open', paused: false, reportDocumentId: null });
      return this.store.patch('tasks', task.id, { status: 'queued', error: null, acceptedReportId: null,
        automationPaused: false, ...(automatic ? {} : { reworkCount: 0 }) }, { actor });
    });
  }
  async submit(session, raw) {
    const previous = this.store.list('taskReports').find(report => report.sessionId === session.id);
    if (previous) return previous;
    const result = workResultSchema.parse(raw);
    const task = this.store.require('tasks', session.taskId);
    if (task.status !== 'running' || task.sessionId !== session.id) fail('현재 실행의 결과만 제출할 수 있습니다.');
    const reportId = id();
    const specHash = specificationHash(this.store, task);
    if (session.taskSpecificationHash && session.taskSpecificationHash !== specHash) fail('실행 중 참조 문서 또는 선행 작업 결과가 변경되었습니다.');
    const artifacts = await captureArtifacts(this.store, task, result.artifacts, reportId);
    const duplicate = this.store.list('taskReports').find(report => report.sessionId === session.id);
    if (duplicate) return duplicate;
    const current = this.store.require('tasks', task.id);
    if (current.status !== 'running' || current.sessionId !== session.id || current.automationPaused) fail('중지되거나 대체된 실행의 결과입니다.');
    if (specHash !== specificationHash(this.store, current)) fail('결과를 저장하는 동안 작업 조건이 변경되었습니다.');
    return this.store.transaction(() => {
      const report = this.store.put('taskReports', { id: reportId, taskId: task.id, sessionId: session.id,
        authorId: session.memberId, version: this.store.list('taskReports').filter(item => item.taskId === task.id).length + 1,
        instruction: session.request, steering: this.store.get('sessions', session.id)?.steering || [],
        specificationHash: specHash, criteria: completionCriteria(task), result, content: renderResult(result), artifacts });
      const reviewer = this.reviewer(task);
      this.store.patch('tasks', task.id, { latestReportId: report.id, report: report.content, status: 'review',
        reviewerId: reviewer?.id || null, error: reviewer ? null : '검토할 팀장 또는 TARS를 등록하세요.' }, { actor: session.memberId });
      this.store.appendHistory({ kind: 'tasks', entityId: task.id, taskId: task.id, sessionId: session.id, memberId: session.memberId,
        actor: session.memberId, event: 'submitted', message: `결과 v${report.version} 제출`, details: { reportId: report.id } });
      this.job('task_review', report.id, { taskId: task.id, requestId: task.requestId, reportId: report.id, memberId: reviewer?.id || null });
      return report;
    });
  }
  async review(taskId, reportId, raw, actor, sessionId = null) {
    const review = taskReviewSchema.parse(raw);
    const task = this.store.require('tasks', taskId);
    const report = this.store.require('taskReports', reportId);
    const existing = this.store.list('taskReviews').find(item => item.reportId === reportId);
    if (existing) {
      const savedVerdict = Object.fromEntries(Object.keys(review).map(key => [key, existing[key]]));
      if (existing.authorId === actor && existing.sessionId === sessionId && digest(savedVerdict) === digest(review)) return existing;
      fail('이미 검토된 결과입니다.');
    }
    if (actor === task.assigneeId || (actor !== 'user' && actor !== this.reviewer(task)?.id)) fail('담당 검토자만 결과를 판정할 수 있습니다.', 403);
    if (report.taskId !== task.id || task.latestReportId !== reportId || task.status !== 'review' || task.automationPaused) fail('현재 검토 대상 결과가 아닙니다.');
    if (report.legacy || !report.result) fail('이전 결과에는 검토 가능한 산출물 버전이 없습니다. 새 결과를 제출하세요.');
    if (review.decision === 'accepted' && (!task.acceptance?.trim() || !review.checks.length || review.checks.some(check => check.status !== 'passed') || report.result.remaining.length)) {
      fail('완료 기준과 검증 근거를 충족하고 미완료 사항이 없어야 완료할 수 있습니다.');
    }
    if (review.decision === 'accepted' && (report.criteria || completionCriteria(task)).some(criterion => !review.checks.some(check => check.criterion === criterion.id || check.criterion === criterion.text))) {
      fail('모든 완료 기준의 ID와 검증 근거를 확인해야 합니다.');
    }
    if (review.decision === 'rework' && !review.reworkInstructions.trim()) fail('보완 지시를 입력하세요.', 400);
    await assertCurrentArtifacts(this.store, task, report);
    const current = this.store.require('tasks', task.id);
    if (current.latestReportId !== reportId || current.status !== 'review' || current.automationPaused
      || report.specificationHash !== specificationHash(this.store, current)) fail('검토 중 작업이 변경되었습니다.');
    if (this.store.list('taskReviews').some(item => item.reportId === reportId)) fail('다른 검토가 먼저 저장되었습니다.');
    if (sessionId) {
      const session = this.store.require('sessions', sessionId);
      if (session.memberId !== actor || session.taskId !== taskId || session.reviewReportId !== reportId) fail('검토 실행의 담당자 또는 결과 버전이 일치하지 않습니다.', 403);
      if (!live(session) || session.status === 'stopping') fail('중지된 검토 결과입니다.');
      if (session.workflowJobId && this.store.require('workflowJobs', session.workflowJobId).status !== 'running') fail('취소된 검토입니다.');
    }
    return this.store.transaction(() => {
      const saved = this.store.put('taskReviews', { ...review, taskId, reportId, authorId: actor, sessionId,
        artifactHash: report.artifacts.hash, specificationHash: report.specificationHash });
      const count = current.reworkCount || 0;
      const maximum = this.store.get('settings', 'main').maxReworkAttempts ?? 2;
      const retry = review.decision === 'rework' && count < maximum;
      this.store.patch('tasks', taskId, { status: review.decision === 'accepted' ? 'done' : retry ? 'queued' : 'blocked',
        acceptedReportId: review.decision === 'accepted' ? reportId : null,
        completedAt: review.decision === 'accepted' ? now() : null,
        reviewId: saved.id, reworkInstructions: review.reworkInstructions,
        reworkCount: retry ? count + 1 : count,
        error: review.decision === 'accepted' || retry ? null
          : review.decision === 'rework' ? `자동 보완 ${maximum}회 한도에 도달했습니다. ${review.rationale}` : review.rationale }, { actor });
      this.cancelJobs(taskId, '검토가 저장되었습니다.', 'done');
      this.store.appendHistory({ kind: 'tasks', entityId: taskId, taskId, sessionId, memberId: actor, actor,
        event: 'reviewed', message: `결과 v${report.version} 검토: ${review.decision}`, details: { reportId, reviewId: saved.id } });
      if (review.decision === 'accepted' && review.knowledge.length) this.store.put('documents', {
        title: `${task.title} · 검토된 인계`, kind: 'note', projectId: task.projectId, departmentId: task.departmentId,
        sourceTaskId: taskId, sourceReportId: reportId, sourceReviewId: saved.id, version: 1, revisions: [],
        content: `출처 작업: ${taskId}\n결과: v${report.version}\n검토자: ${actor}\n적용 범위: ${task.projectId || '프로젝트 미지정'} / ${task.departmentId}\n\n${review.knowledge.map(item => `- ${item}`).join('\n')}\n\n업무 기록: ${taskRecordPath(taskId)}`,
      });
      return saved;
    });
  }
  pauseTask(taskId, actor = 'user', cancelled = false) {
    return this.store.transaction(() => {
      const task = this.store.require('tasks', taskId);
      this.cancelJobs(taskId, '사용자가 후속 실행을 중지했습니다.');
      if (task.requestId) {
        this.store.patch('requests', task.requestId, { paused: true });
        for (const job of this.store.list('workflowJobs').filter(job => job.requestId === task.requestId && !job.taskId && ['queued', 'running'].includes(job.status))) {
          this.store.patch('workflowJobs', job.id, { status: 'cancelled', error: '요청의 자동 보고가 중지되었습니다.' });
        }
      }
      return this.store.patch('tasks', taskId, { status: cancelled ? 'cancelled' : 'blocked', automationPaused: true,
        error: cancelled ? null : '사용자가 실행을 중지했습니다.' }, { actor });
    });
  }
  requestSnapshot(requestId) {
    return this.store.list('tasks').filter(task => task.requestId === requestId).map(task => ({
      id: task.id, title: task.title, status: task.status, acceptedReportId: task.acceptedReportId || null,
      latestReportId: task.latestReportId || null, error: task.error || null, specificationHash: specificationHash(this.store, task),
      integratedAt: task.integratedAt || null,
    })).sort((a, b) => a.id.localeCompare(b.id));
  }
  reconcile() {
    for (const request of this.store.list('requests')) {
      if (request.pendingApprovalId || request.status === 'accepted' || this.approvals.pendingFollowup(request)
        || !this.approvals.canExecute(request.id)) continue;
      if (!isWorkRequest(request, this.store.list('tasks')) || request.paused
        || this.store.list('sessions').some(session => sessionBelongsToRequest(session, request.id) && ['plan', 'ceo_chat', 'member_chat'].includes(session.kind) && live(session))) continue;
      const tasks = this.requestSnapshot(request.id);
      if (!tasks.length) continue;
      const completed = tasks.every(terminal);
      const blocked = tasks.some(task => task.status === 'blocked');
      if (!completed && !blocked) continue;
      const signature = digest(tasks);
      const kind = completed ? 'request_report' : 'request_escalation';
      this.job(kind, [request.id, signature], { requestId: request.id, signature, snapshot: tasks,
        memberId: this.store.list('members').find(member => member.role === 'ceo')?.id || null });
    }
  }
  finishRequest(jobId, session, content) {
    const job = this.store.require('workflowJobs', jobId);
    const request = this.store.require('requests', job.requestId);
    if (job.status !== 'running' || request.paused || job.signature !== digest(this.requestSnapshot(request.id))) {
      this.store.patch('workflowJobs', job.id, { status: 'superseded', error: '보고 중 작업 결과가 변경되었습니다.' });
      return null;
    }
    return this.store.transaction(() => {
      const document = this.store.put('documents', { title: `${request.title} · ${job.kind === 'request_report' ? '최종 결과' : '차단 보고'}`.slice(0, 200),
        kind: 'report', content, requestId: request.id, projectId: request.projectId, departmentId: null,
        sessionId: session.id, version: 1, revisions: [], taskSnapshot: job.snapshot });
      this.store.patch('requests', request.id, { status: job.kind === 'request_report' ? 'reported' : 'blocked', reportDocumentId: document.id });
      this.approvals.submitReport(request.id, session.id, document.id);
      this.store.patch('workflowJobs', job.id, { status: 'done', documentId: document.id });
      return document;
    });
  }
  recover() {
    // Existing state has no historical reviewer evidence. Import only what was saved.
    this.store.transaction(() => {
      for (const task of this.store.list('tasks')) {
        if (task.requestId) continue;
        const source = task.originSessionId && this.store.get('sessions', task.originSessionId);
        let request = source && this.store.list('requests').find(item => item.sourceSessionId === source.id);
        request ||= this.request(source?.prompt || task.description || task.title, task.projectId, task.createdBy || 'user',
          { legacy: true, paused: true, sourceSessionId: source?.id || null });
        this.store.patch('tasks', task.id, { requestId: request.id, legacyReview: true });
        const attempts = this.store.list('sessions').filter(session => session.taskId === task.id && session.kind === 'work' && session.output && !live(session)).reverse();
        if (!attempts.length && task.report) attempts.push({ id: null, output: task.report, memberId: task.assigneeId, endedAt: task.updatedAt });
        let latest;
        for (const [index, session] of attempts.entries()) latest = this.store.put('taskReports', {
          taskId: task.id, sessionId: session.id, authorId: session.memberId, version: index + 1, content: session.output,
          legacy: true, recordedAt: session.endedAt, instruction: session.request || null,
        });
        if (latest) this.store.patch('tasks', task.id, { latestReportId: latest.id });
      }
      for (const job of this.store.list('workflowJobs').filter(item => item.status === 'running')) {
        this.store.patch('workflowJobs', job.id, { status: 'blocked', error: '서버 재시작으로 중단되었습니다. 후속 처리를 다시 요청하세요.' });
        if (job.taskId && this.store.get('tasks', job.taskId)?.status === 'review') {
          this.store.patch('tasks', job.taskId, { status: 'blocked', error: '검토가 중단되었습니다. 검토를 다시 요청하세요.' });
        }
      }
      this.approvals.recover();
    });
  }
  retryJob(jobId) {
    const job = this.store.require('workflowJobs', jobId);
    if (!['blocked', 'cancelled'].includes(job.status)) fail('중단된 후속 처리만 다시 요청할 수 있습니다.');
    if (this.store.list('sessions').some(session => session.workflowJobId === jobId && live(session))) fail('이전 실행이 아직 종료되지 않았습니다.');
    if (job.taskId) {
      const task = this.store.require('tasks', job.taskId);
      if (task.status === 'cancelled' || task.latestReportId !== job.reportId) fail('현재 결과의 검토만 재개할 수 있습니다.');
      this.store.patch('tasks', task.id, { status: 'review', automationPaused: false, error: null }, { actor: 'user' });
    }
    if (job.requestId) this.store.patch('requests', job.requestId, { paused: false });
    return this.store.patch('workflowJobs', job.id, { status: 'queued', error: null, sessionId: null,
      ...(job.kind === 'user_followup' && job.sessionId ? { freshContinuation: true, previousAttemptId: job.sessionId } : {}) });
  }
}
