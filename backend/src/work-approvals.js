import { now } from './store.js';
import { fail, approvalResponseSchema } from './contracts.js';
import { digest } from './task-artifacts.js';
import { sessionBelongsToRequest } from '../../shared/work-requests.mjs';

const live = session => ['preparing', 'running', 'stopping'].includes(session?.status);
const ordered = values => values.sort((a, b) => a.id.localeCompare(b.id));

// Approval snapshots are immutable. Documents can keep evolving without changing
// what the user saw, and every response is tied to its exact originating session.
export class WorkApprovals {
  constructor(store) { this.store = store; }
  scope(requestId) {
    const request = this.store.require('requests', requestId);
    const tasks = ordered(this.store.list('tasks').filter(task => task.requestId === requestId).map(task => ({
      id: task.id, title: task.title, description: task.description, acceptance: task.acceptance,
      assigneeId: task.assigneeId, departmentId: task.departmentId, projectId: task.projectId,
      dependsOn: task.dependsOn || [], documentIds: task.documentIds || [], isolation: task.isolation,
    })));
    const refs = new Set(tasks.flatMap(task => task.documentIds));
    const documents = ordered(this.store.list('documents').filter(doc =>
      (doc.requestId === requestId && ['agreement', 'specification'].includes(doc.kind)) || refs.has(doc.id))
      .map(doc => ({ id: doc.id, title: doc.title, kind: doc.kind, version: doc.version, content: doc.content })));
    return { title: request.title, instruction: request.instruction, projectId: request.projectId, documents, tasks };
  }
  scopeSignature(requestId) { return digest(this.scope(requestId)); }
  reportSignature(requestId, documentId) {
    const doc = this.store.require('documents', documentId);
    return digest({ scope: this.scopeSignature(requestId), document: [doc.id, doc.version, doc.content],
      results: ordered(this.store.list('tasks').filter(task => task.requestId === requestId).map(task => ({
        id: task.id, status: task.status, latestReportId: task.latestReportId, acceptedReportId: task.acceptedReportId,
        integratedAt: task.integratedAt || null,
      }))) });
  }
  pendingFollowup(request) {
    const job = request.followupJobId && this.store.get('workflowJobs', request.followupJobId);
    return job && ['queued', 'running', 'blocked', 'cancelled'].includes(job.status);
  }
  canExecute(requestId) {
    if (!requestId) return true;
    const request = this.store.require('requests', requestId);
    if (!request.approvalRequired) return true; // Preserve legacy jobs; never invent historical approval.
    const approval = request.approvedPlanId && this.store.get('workApprovals', request.approvedPlanId);
    return !request.pendingApprovalId && !['accepted', 'revision_requested'].includes(request.status) && approval?.status === 'approved'
      && approval.signature === this.scopeSignature(requestId);
  }
  assertExecutable(requestId) {
    if (!this.canExecute(requestId)) fail('현재 협의안에 대한 사용자 승인이 필요합니다. 업무 흐름에서 승인 또는 의견을 남기세요.');
  }
  submitPlan(requestId, sourceSessionId, { force = false } = {}) {
    const request = this.store.require('requests', requestId);
    const signature = this.scopeSignature(requestId);
    const approved = request.approvedPlanId && this.store.get('workApprovals', request.approvedPlanId);
    if (!force && approved?.status === 'approved' && approved.signature === signature) return null;
    const source = this.store.require('sessions', sourceSessionId);
    return this.submit(requestId, source, 'plan', signature, this.scope(requestId), source.output || request.instruction);
  }
  submitReport(requestId, sourceSessionId, documentId) {
    const doc = this.store.require('documents', documentId);
    const source = this.store.require('sessions', sourceSessionId);
    const final = source.kind !== 'request_escalation' && this.store.list('tasks').filter(task => task.requestId === requestId)
      .every(task => ['done', 'cancelled'].includes(task.status));
    return this.submit(requestId, source, 'report',
      this.reportSignature(requestId, documentId), { ...this.scope(requestId), report: { id: doc.id, version: doc.version, title: doc.title, content: doc.content, final } }, doc.content);
  }
  submit(requestId, source, kind, signature, snapshot, content) {
    const member = this.store.require('members', source.memberId);
    if (!['ceo', 'leader'].includes(member.role) || !sessionBelongsToRequest(source, requestId)) fail('해당 업무를 담당한 관리자 세션이 필요합니다.', 403);
    return this.store.transaction(() => {
      const request = this.store.require('requests', requestId);
      const pending = request.pendingApprovalId && this.store.get('workApprovals', request.pendingApprovalId);
      if (pending?.status === 'pending' && pending.kind === kind && pending.signature === signature && pending.content === content) return pending;
      if (pending?.status === 'pending') this.store.patch('workApprovals', pending.id, { status: 'superseded' });
      const followup = request.followupJobId && this.store.get('workflowJobs', request.followupJobId);
      if (followup && followup.sessionId !== source.id && ['queued', 'running', 'blocked', 'cancelled'].includes(followup.status)) {
        this.store.patch('workflowJobs', followup.id, { status: 'superseded', error: '새 협의안·보고서가 제출되었습니다.' });
        this.store.patch('requests', requestId, { followupJobId: null });
      }
      const approval = this.store.put('workApprovals', { requestId, kind, signature, snapshot, content,
        sourceSessionId: source.id, memberId: source.memberId, status: 'pending',
        version: this.store.list('workApprovals').filter(item => item.requestId === requestId && item.kind === kind).length + 1 });
      this.store.patch('requests', requestId, { approvalRequired: true, pendingApprovalId: approval.id,
        status: kind === 'plan' ? 'awaiting_approval' : 'awaiting_acceptance' });
      this.record(approval, 'approval_requested', `${kind === 'plan' ? '협의안' : '결과 보고'} v${approval.version} 사용자 확인 요청`, source.memberId);
      return approval;
    });
  }
  respond(requestId, approvalId, raw, actor = 'user') {
    if (actor !== 'user') fail('사용자만 협의안과 보고서를 승인하거나 의견을 남길 수 있습니다.', 403);
    const input = approvalResponseSchema.parse(raw);
    const approval = this.store.require('workApprovals', approvalId);
    if (approval.requestId !== requestId) fail('이 업무의 승인 요청이 아닙니다.', 400);
    if (approval.response) {
      if (approval.response.decision === input.decision && approval.response.comment === input.comment) {
        return { approval, job: this.store.require('workflowJobs', approval.followupJobId) };
      }
      fail('이미 처리한 요청입니다. 최신 협의안 또는 보고서를 확인하세요.');
    }
    const request = this.store.require('requests', requestId);
    if (approval.status !== 'pending' || request.pendingApprovalId !== approvalId) fail('최신 승인 대기 항목이 아닙니다. 화면을 새로고침하세요.');
    const source = this.store.require('sessions', approval.sourceSessionId);
    if (live(source)) fail('담당 AI의 응답이 정상 종료된 뒤 의견을 전달할 수 있습니다.');
    if (source.status !== 'completed' && input.decision === 'approve') fail('정상 종료되지 않은 응답은 승인할 수 없습니다. 의견을 보내 협의안을 다시 요청하세요.');
    const signature = approval.kind === 'plan' ? this.scopeSignature(requestId) : this.reportSignature(requestId, approval.snapshot.report.id);
    if (signature !== approval.signature && input.decision === 'approve') fail('문서 또는 작업 내용이 변경되었습니다. 의견을 보내 최신 협의안·보고서를 요청하세요.');
    const member = this.store.get('members', approval.memberId);
    if (!member || !['leader', 'ceo'].includes(member.role)) fail('원래 담당 AI를 찾을 수 없습니다. 담당 조직을 확인하세요.');
    return this.store.transaction(() => {
      const job = this.store.put('workflowJobs', { id: digest(['user_followup', approvalId]), kind: 'user_followup',
        requestId, approvalId, sourceSessionId: source.id, memberId: member.id, status: 'queued' });
      const response = { ...input, actor: 'user', at: now() };
      const saved = this.store.patch('workApprovals', approvalId, { status: input.decision === 'approve' ? 'approved' : 'feedback', response, followupJobId: job.id });
      this.store.patch('requests', requestId, { pendingApprovalId: null, paused: false, followupJobId: job.id,
        status: input.decision === 'feedback' ? 'revision_requested' : approval.kind === 'plan' ? 'open'
          : approval.snapshot.report.final ? 'accepted' : 'blocked',
        ...(approval.kind === 'plan' ? { approvedPlanId: input.decision === 'approve' ? approvalId : null } : {}),
        ...(approval.kind === 'report' && approval.snapshot.report.final && input.decision === 'approve' ? { acceptedApprovalId: approvalId, acceptedAt: now() } : {}) });
      this.record(saved, 'user_response', `${input.decision === 'approve' ? '사용자 승인' : '사용자 의견'} · ${input.comment || '내용 확인 후 승인'}`, 'user');
      return { approval: saved, job };
    });
  }
  record(approval, event, message, actor) {
    const refs = { kind: 'requests', entityId: approval.requestId, requestId: approval.requestId,
      sessionId: approval.sourceSessionId, memberId: approval.memberId, actor, event, message,
      details: { approvalId: approval.id, kind: approval.kind, version: approval.version, response: approval.response || null } };
    this.store.appendHistory(refs);
    for (const task of this.store.list('tasks').filter(task => task.requestId === approval.requestId)) {
      this.store.appendHistory({ ...refs, kind: 'tasks', entityId: task.id, taskId: task.id });
    }
  }
  recover() {
    // Make existing saved proposals/reports reviewable, without inventing past
    // approvals or interrupting work already in the execution pipeline.
    const tasks = this.store.list('tasks'), sessions = this.store.list('sessions');
    for (const request of this.store.list('requests')) {
      if (this.store.list('workApprovals').some(item => item.requestId === request.id)) continue;
      const work = tasks.filter(task => task.requestId === request.id);
      if (work.some(task => ['queued', 'running', 'review'].includes(task.status))
        || sessions.some(session => live(session) && (sessionBelongsToRequest(session, request.id) || work.some(task => task.id === session.taskId)))) continue;
      const document = request.reportDocumentId && this.store.get('documents', request.reportDocumentId);
      const source = document?.sessionId ? this.store.get('sessions', document.sessionId)
        : request.sourceSessionId && this.store.get('sessions', request.sourceSessionId);
      if (!source || source.status !== 'completed' || !sessionBelongsToRequest(source, request.id)
        || !['leader', 'ceo'].includes(this.store.get('members', source.memberId)?.role)) continue;
      if (!document && (!request.registeredAt || (work.length && work.every(task => ['done', 'cancelled'].includes(task.status))))) continue;
      const approval = document ? this.submitReport(request.id, source.id, document.id) : this.submitPlan(request.id, source.id);
      if (approval) this.store.patch('workApprovals', approval.id, { restored: true });
    }
  }
}
