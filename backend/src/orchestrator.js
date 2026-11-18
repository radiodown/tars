import { SessionInteractions } from './session-interactions.js';
import { SessionInputs } from './session-inputs.js';
import { liveSession } from './session-lifecycle.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DATA, id, now } from './store.js';
import { fail, planSchema } from './contracts.js';
import { validateProgressAllocation } from './work-progress.js';
import { workProgress } from '../../shared/work-progress.mjs';
import { contextFor, memberDirectory, prepareWorkspace, syncShared } from './workspaces.js';
import { guidanceFilesHash, prepareGuidance, prepareScope } from './guidance.js';
import { killOwned, launch } from './providers.js';
import { CodexAppServers } from './codex-app-server.js';
import { CEO_ID, ceoContext } from './ceo.js';
import { WorkStatusFiles, managementContext, reportInstructions, requestSnapshot, writeExecutionRecord } from './work-records.js';
import { ACCESS_VERSION, sessionModel } from './agent-access.js';
import { assertWorkNotDeleted, TaskWorkflow, workflowKinds } from './task-workflow.js';
import { assertCurrentArtifacts, digest, taskRecordPath } from './task-artifacts.js';
import { continuationSource } from './session-continuation.js';
import { isMemberChat, memberConversationContext } from './member-conversations.js';
import { saveSessionActivity } from './session-activity.js';
import { conversationForRun, createConversation, migrateConversations, recordConversationRun, requireConversation } from './conversations.js';

export class Orchestrator {
  constructor(store, { launchRun = launch } = {}) {
    this.store = store;
    migrateConversations(store);
    this.active = new Map();
    this.inputs = new SessionInputs(store);
    this.closing = false;
    this.pumping = false;
    this.codexServers = new CodexAppServers(store, killOwned);
    this.statusFiles = new WorkStatusFiles(store);
    this.workflow = new TaskWorkflow(store);
    this.launchRun = launchRun;
    this.interactions = new SessionInteractions(store);
  }
  async recover() {
    await this.codexServers.recover();
    for (const session of this.store.list('sessions')) this.interactions.close(session.id, '서버 재시작으로 입력 요청이 만료되었습니다.');
    this.inputs.recover();
    const interrupted = [];
    for (const session of this.store.list('sessions').filter(s => ['preparing', 'running', 'waiting_input', 'stopping'].includes(s.status))) {
      if (session.transport !== 'app-server') await killOwned(session, 'SIGKILL');
      this.store.patch('sessions', session.id, { status: 'interrupted', endedAt: now(), progress: '서버 종료로 중단되었습니다. 다시 실행할 수 있습니다.' });
      interrupted.push(session.id);
    }
    this.store.transaction(() => {
      for (const member of this.store.list('members')) this.store.patch('members', member.id, { status: 'idle', currentSessionId: null });
      for (const task of this.store.list('tasks').filter(t => t.status === 'running')) {
        this.store.patch('tasks', task.id, { status: 'blocked', error: '서버 재시작으로 중단되었습니다. 작업 실행을 다시 요청하세요.' });
      }
    });
    for (const sessionId of interrupted) await this.saveRecord(sessionId);
    this.workflow.recover();
    this.timer = setInterval(() => this.pump().catch(error => this.store.event(error.message, { level: 'error' })), 1500);
    this.heartbeatTimer = setInterval(() => {
      if (this.closing || !this.active.size) return;
      for (const sessionId of this.active.keys()) {
        const session = this.store.get('sessions', sessionId);
        if (['preparing', 'running', 'waiting_input', 'stopping'].includes(session?.status)) this.store.patchProgress(sessionId, { heartbeatAt: now() });
      }
    }, 15000);
    this.statusFiles.start();
    await this.statusFiles.flush();
  }
  assertAvailable(member) {
    if (this.closing) fail('서버가 종료 중입니다.');
    if (member.handoffSessionId) fail('CLI 인계 중입니다. 인계를 종료한 뒤 TARS에서 실행하세요.');
    if (member.handoffSessionId || member.status === 'running' || [...this.active.values()].some(run => run.memberId === member.id)) fail('이 AI는 이미 작업 중입니다.');
    if (this.active.size >= this.store.get('settings', 'main').maxConcurrent) fail('동시 실행 한도에 도달했습니다. 진행 중인 작업이 끝난 뒤 다시 요청하세요.');
  }
  begin(member, kind, details) {
    this.assertAvailable(member);
    const conversation = conversationForRun(this.store, member, kind, details);
    const profile = sessionModel(member, details.modelProfile || kind);
    const request = details.requestId && this.store.get('requests', details.requestId);
    const approved = request?.approvedPlanId && this.store.get('workApprovals', request.approvedPlanId);
    const managerWrite = request?.allowManagerImplementation && !request.paused && !request.pendingApprovalId && request.status !== 'revision_requested'
      && approved?.status === 'approved' && approved.signature === this.workflow.approvals.scopeSignature(request.id) && !workflowKinds.includes(kind);
    const session = this.store.put('sessions', {
      memberId: member.id, departmentId: member.departmentId, provider: member.provider,
      codexAccount: member.provider === 'codex' ? member.codexAccount || 'codex' : null,
      model: profile.model || 'default', reasoning: profile.reasoning || 'default',
      accessProfile: kind === 'work' || managerWrite ? 'workspace-write' : 'read-only',
      extraWritableRoots: managerWrite && request.projectId ? [this.store.require('projects', request.projectId).path] : [],
      transport: member.provider === 'codex' ? 'app-server' : 'cli', accessVersion: ACCESS_VERSION, permissionMode: this.store.get('settings', 'main').agentPermissionMode || 'automatic', kind, status: 'preparing', startedAt: now(), endedAt: null,
      progress: '작업 문맥 준비 중', output: '', processToken: id(), heartbeatAt: now(), lastActivityAt: null,
      request: requestSnapshot(this.store, member, kind, details),
      ...(kind === 'work' && details.taskId ? { taskSpecificationHash: this.workflow.specificationHash(details.taskId) } : {}), ...details,
      conversationId: conversation.id,
    });
    recordConversationRun(this.store, session);
    const control = { memberId: member.id, cancelled: false, handle: null };
    this.active.set(session.id, control);
    this.store.patch('members', member.id, { status: 'running', currentSessionId: session.id });
    this.store.event(`${member.name} · ${isMemberChat(session) ? '대화' : kind === 'oversight' ? '프로젝트 총괄 보고' : kind === 'plan' ? '협의 및 작업 설계' : kind === 'review' ? '결과 보고' : '작업'} 시작`, { memberId: member.id, sessionId: session.id, taskId: details.taskId });
    return { session, control };
  }
  consult(input, identity = { actor: 'user', session: null }) {
    const member = this.store.require('members', input.leaderId);
    if (member.role !== 'leader') fail('팀장을 선택하세요.', 400);
    const projectId = input.projectId === undefined ? this.store.require('departments', member.departmentId).projectId || null : input.projectId;
    if (projectId) this.store.require('projects', projectId);
    this.assertAvailable(member);
    const requestId = input.requestId || identity.session?.requestId || null;
    if (requestId) this.workflow.requireWork(requestId, projectId, member.id);
    const { session, control } = this.begin(member, 'member_chat', { projectId, prompt: input.prompt, requestId, modelProfile: 'plan', conversationId: input.conversationId, initiatedBy: identity.actor });
    control.promise = this.run(session, member, control);
    return session;
  }
  report(input) {
    const member = this.store.require('members', input.leaderId);
    if (member.role !== 'leader') fail('팀장을 선택하세요.', 400);
    if (!input.requestId) return this.consult({ ...input, prompt: `현재 기록을 근거로 현황을 보고하세요. 새 업무를 등록하지 마세요.\n${input.prompt}` });
    const request = this.store.require('requests', input.requestId);
    this.workflow.requireWork(request.id, request.projectId, member.id);
    const snapshot = this.workflow.requestSnapshot(request.id);
    const progress = workProgress(request, this.store.list('tasks'));
    const kind = snapshot.length && snapshot.every(task => ['done', 'cancelled'].includes(task.status)) && (!progress.planned || progress.complete) ? 'request_report' : 'request_escalation';
    const signature = this.workflow.requestSignature(request.id);
    return this.workflow.job(kind, [request.id, signature], { requestId: request.id, snapshot, signature, memberId: this.workflow.reporter(request)?.id });
  }
  queue(taskId, actor = 'user') {
    const task = this.store.require('tasks', taskId);
    if (!['draft', 'assigned', 'blocked', 'review'].includes(task.status)) fail('현재 상태에서는 작업을 실행할 수 없습니다.');
    const member = this.store.require('members', task.assigneeId);
    if (member.role !== 'member' || member.departmentId !== task.departmentId) fail('같은 부서의 팀원을 담당자로 지정하세요.');
    this.workflow.queueTask(taskId, actor);
    this.store.event(`실행 대기: ${task.title}`, { taskId });
    return this.store.require('tasks', taskId);
  }
  cancelTask(taskId, actor = 'user') {
    const task = this.workflow.pauseTask(taskId, actor, true);
    for (const session of this.store.list('sessions').filter(item => this.active.has(item.id) && (item.taskId === taskId
      || (item.requestId === task.requestId && item.workflowJobId && this.store.get('workflowJobs', item.workflowJobId)?.status === 'cancelled')))) this.stop(session.id, actor);
    return task;
  }
  oversee(input) {
    return this.chat({ ...input, prompt: `기록을 근거로 프로젝트 현황을 보고하세요. 새 업무를 등록하지 마세요.\n${input.prompt}` });
  }
  chat(input) {
    return this.memberChat(CEO_ID, input);
  }
  memberChat(memberId, input) {
    const member = this.store.require('members', memberId);
    const existing = input.conversationId ? requireConversation(this.store, member, input.conversationId,
      member.role === 'ceo' ? input.projectId : undefined) : null;
    const projectId = existing ? existing.projectId : member.role === 'ceo' ? input.projectId || null
      : this.store.require('departments', member.departmentId).projectId || null;
    if (projectId) this.store.require('projects', projectId);
    if (this.closing || member.handoffSessionId) this.assertAvailable(member);
    if (member.status === 'running' || this.active.size >= this.store.get('settings', 'main').maxConcurrent) {
      if (this.store.list('chatQueue').filter(item => item.memberId === memberId && item.status === 'queued').length >= 20) fail('대기 메시지는 AI마다 최대 20개입니다.');
      const conversationId = (existing || createConversation(this.store, member, { ...input, projectId })).id;
      return this.store.put('chatQueue', { memberId, projectId, prompt: input.prompt, conversationId, status: 'queued' });
    }
    this.assertAvailable(member);
    const { session, control } = this.begin(member, member.role === 'ceo' ? 'ceo_chat' : 'member_chat', { projectId, prompt: input.prompt, conversationId: existing?.id });
    control.promise = this.run(session, member, control);
    return session;
  }
  resetChat(input) {
    return this.resetMemberChat(CEO_ID, input);
  }
  resetMemberChat(memberId, input = {}) {
    if (this.closing) fail('서버가 종료 중입니다.');
    const member = this.store.require('members', memberId);
    if (member.handoffSessionId || member.status === 'running' || [...this.active.values()].some(run => run.memberId === member.id)) {
      fail('진행 중인 작업을 중지하거나 끝난 뒤 /clear를 실행하세요.');
    }
    const projectId = member.role === 'ceo' ? input.projectId || null : this.store.require('departments', member.departmentId).projectId || null;
    const conversation = createConversation(this.store, member, { ...input, projectId });
    return { ...conversation, conversationId: conversation.id };
  }
  async pump() {
    if (this.closing || this.pumping) return;
    this.pumping = true;
    try {
      this.workflow.reconcile();
      for (const item of this.store.list('chatQueue').filter(item => item.status === 'queued').reverse()) {
        if (this.active.size >= this.store.get('settings', 'main').maxConcurrent) break;
        const member = this.store.get('members', item.memberId);
        if (!member) { this.store.patch('chatQueue', item.id, { status: 'failed', error: '담당 AI가 없습니다.' }); continue; }
        if (member.status === 'running' || member.handoffSessionId) continue;
        try { const session = this.memberChat(member.id, item); this.store.patch('chatQueue', item.id, { status: 'sent', sessionId: session.id }); }
        catch (error) { this.store.patch('chatQueue', item.id, { status: 'failed', error: error.message }); }
      }
      await this.pumpJobs();
      for (const task of this.store.list('tasks').filter(t => t.status === 'queued').reverse()) {
        if (this.active.size >= this.store.get('settings', 'main').maxConcurrent) break;
        if (task.requestId && this.store.get('requests', task.requestId)?.paused) continue;
        if (!this.workflow.approvals.canExecute(task.requestId)) continue;
        if (!task.dependsOn.every(key => this.store.get('tasks', key)?.status === 'done')) continue;
        const member = this.store.get('members', task.assigneeId);
        if (!member) {
          this.store.patch('tasks', task.id, { status: 'blocked', error: '담당 AI가 없습니다.' });
          continue;
        }
        if (member.handoffSessionId || member.status === 'running' || task.automationPaused || this.store.list('sessions').some(item => item.taskId === task.id && ['preparing', 'running', 'waiting_input', 'stopping'].includes(item.status))) continue;
        const { session, control } = this.begin(member, 'work', { taskId: task.id, projectId: task.projectId, requestId: task.requestId });
        this.store.patch('tasks', task.id, { status: 'running', sessionId: session.id, error: null, completedUnits: 0, blocker: null });
        control.promise = this.run(session, member, control);
      }
    } finally { this.pumping = false; }
  }
  async pumpJobs() {
    for (const job of this.store.list('workflowJobs').filter(item => item.status === 'queued').reverse()) {
      if (this.closing || this.active.size >= this.store.get('settings', 'main').maxConcurrent) break;
      if (this.store.require('workflowJobs', job.id).status !== 'queued') continue;
      const request = job.requestId ? this.store.get('requests', job.requestId) : null;
      if (request?.paused) continue;
      if (job.kind === 'user_followup') {
        this.pumpFollowup(job, request);
        continue;
      }
      if (request?.pendingApprovalId || (request && this.workflow.approvals.pendingFollowup(request))) continue;
      const task = job.taskId ? this.store.get('tasks', job.taskId) : null;
      if (task && (task.latestReportId !== job.reportId || task.status !== 'review' || task.automationPaused)) {
        this.store.patch('workflowJobs', job.id, { status: 'superseded', error: '검토 대상이 변경되었습니다.' }); continue;
      }
      if (!task && job.signature !== this.workflow.requestSignature(job.requestId)) {
        this.store.patch('workflowJobs', job.id, { status: 'superseded', error: '요청의 작업 상태가 변경되었습니다.' }); continue;
      }
      const member = task ? this.workflow.reviewer(task) : this.workflow.reporter(request);
      if (!member) {
        this.store.patch('workflowJobs', job.id, { status: 'blocked', error: '검토할 팀장 또는 TARS가 없습니다.' });
        if (task) this.store.patch('tasks', task.id, { status: 'blocked', error: '검토할 팀장 또는 TARS가 없습니다.' });
        continue;
      }
      if (member.handoffSessionId || member.status === 'running' || [...this.active.values()].some(run => run.memberId === member.id)) continue;
      if (task && this.store.list('sessions').some(item => item.taskId === task.id && ['preparing', 'running', 'waiting_input', 'stopping'].includes(item.status))) continue;
      try {
        if (task) await assertCurrentArtifacts(this.store, task, this.store.require('taskReports', job.reportId));
        if (this.store.require('workflowJobs', job.id).status !== 'queued' || this.closing || (request && this.store.require('requests', request.id).paused)) continue;
        const { session, control } = this.store.transaction(() => {
          const run = this.begin(member, job.kind, { taskId: job.taskId || null, requestId: job.requestId,
            projectId: task?.projectId || request?.projectId || null, reviewReportId: job.reportId || null,
            workflowJobId: job.id,
            prompt: task ? `${task.title}의 결과를 검토하세요.` : `${request.title} · ${job.kind === 'request_report' ? '최종 결과 보고' : '차단 사항 보고'}` });
          this.store.patch('workflowJobs', job.id, { status: 'running', sessionId: run.session.id, memberId: member.id, error: null });
          if (task) this.store.patch('tasks', task.id, { reviewerId: member.id });
          return run;
        });
        control.promise = this.run(session, member, control);
      } catch (error) {
        if (this.store.require('workflowJobs', job.id).status !== 'queued') continue;
        this.store.patch('workflowJobs', job.id, { status: 'blocked', error: error.message });
        if (task) this.store.patch('tasks', task.id, { status: 'blocked', error: error.message });
      }
    }
  }
  pumpFollowup(job, request) {
    const member = this.store.get('members', job.memberId);
    const source = this.store.get('sessions', job.sourceSessionId);
    if (!member || !source || source.memberId !== member.id || !['ceo', 'leader'].includes(member.role)) {
      this.store.patch('workflowJobs', job.id, { status: 'blocked', error: '원래 담당 AI 또는 세션이 없습니다.' }); return;
    }
    if (request.followupJobId !== job.id) {
      this.store.patch('workflowJobs', job.id, { status: 'superseded', error: '새 사용자 의견으로 대체되었습니다.' }); return;
    }
    if (member.handoffSessionId || member.status === 'running' || [...this.active.values()].some(run => run.memberId === member.id)) return;
    try {
      const approval = this.store.require('workApprovals', job.approvalId);
      const { session, control } = this.store.transaction(() => {
        const run = this.begin(member, 'user_followup', { requestId: request.id, projectId: request.projectId,
          workflowJobId: job.id, approvalId: approval.id, continuationOf: source.id,
          freshContinuation: Boolean(job.freshContinuation), previousAttemptId: job.previousAttemptId || null,
          conversationId: source.conversationId || null, initiatedBy: 'user',
          prompt: `${approval.kind === 'plan' ? '협의안' : '결과 보고'} v${approval.version} · ${approval.response.decision === 'approve' ? '사용자 승인' : '추가 의견'}\n${approval.response.comment}` });
        this.store.patch('workflowJobs', job.id, { status: 'running', sessionId: run.session.id, error: null });
        return run;
      });
      control.promise = this.run(session, member, control);
    } catch (error) { this.store.patch('workflowJobs', job.id, { status: 'blocked', error: error.message }); }
  }
  finishFollowup(session) {
    const store = this.store;
    const job = store.require('workflowJobs', session.workflowJobId);
    const approval = store.require('workApprovals', job.approvalId);
    const request = store.require('requests', session.requestId);
    if (job.status !== 'running' || request.paused || request.followupJobId !== job.id) return;
    store.transaction(() => {
      store.patch('workflowJobs', job.id, { status: 'done' });
      store.patch('requests', request.id, { followupJobId: null });
      if (approval.kind === 'report' && approval.response.decision === 'approve') return;
      const submitted = request.pendingApprovalId && store.get('workApprovals', request.pendingApprovalId);
      if (submitted?.sourceSessionId === session.id) return;
      const changed = this.workflow.approvals.scopeSignature(request.id) !== (approval.kind === 'plan' ? approval.signature
        : (request.approvedPlanId && store.get('workApprovals', request.approvedPlanId)?.signature) || digest(Object.fromEntries(Object.entries(approval.snapshot).filter(([key]) => key !== 'report'))));
      if (changed || (approval.kind === 'plan' && approval.response.decision === 'feedback')) {
        this.workflow.approvals.submitPlan(request.id, session.id, { force: true });
      } else if (approval.kind === 'report' || !store.list('tasks').some(task => task.requestId === request.id)) {
        const current = store.require('sessions', session.id);
        const document = store.put('documents', { title: `${request.title} · 의견 반영 보고`.slice(0, 200),
          content: current.output, kind: 'report', requestId: request.id, projectId: request.projectId,
          departmentId: null, sessionId: session.id, version: 1, revisions: [] });
        store.patch('requests', request.id, { reportDocumentId: document.id });
        store.patch('sessions', session.id, { documentIds: [document.id] });
        this.workflow.approvals.submitReport(request.id, session.id, document.id);
      } else {
        for (const item of store.list('tasks').filter(task => task.requestId === request.id)) {
          const task = store.require('tasks', item.id);
          if (['draft', 'assigned'].includes(task.status) && task.assigneeId && task.acceptance?.trim()) this.workflow.queueTask(task.id, session.memberId);
        }
      }
    });
  }
  async run(session, member, control) {
    const store = this.store;
    try {
      const task = session.taskId ? store.require('tasks', session.taskId) : null;
      const scope = session.provider === 'codex' ? await prepareScope(store, member, session.projectId) : memberDirectory(member);
      const conversation = store.require('conversations', session.conversationId);
      const cwd = session.resumeWorkspace || conversation.workspace || (task && session.kind === 'work' ? await prepareWorkspace(store, task, member) : scope);
      member = { ...member, model: session.model === 'default' ? '' : session.model, reasoning: session.reasoning };
      await mkdir(cwd, { recursive: true });
      if (session.provider === 'codex') session.guidance = await prepareGuidance(store, member, session.projectId, cwd);
      // Continue the selected conversation after each turn, including stopped turns.
      // A resume failure must never silently replace its native context.
      const previous = !session.freshContinuation ? continuationSource(store, session, cwd) : null;
      const unchanged = previous?.loadedGuidanceHash && previous.guidanceHash === session.guidance?.hash
        && previous.loadedGuidanceHash === await guidanceFilesHash([...(previous.instructionSources || []), ...(previous.availableSkills || []).map(skill => skill.path)]);
      session.resumeThreadId = session.provider === 'codex' && previous
        && (conversation.providerSessionId || unchanged || session.explicitContinuation) ? previous.providerSessionId : null;
      // CEO chat history is scoped by conversation; the member summary may belong to an older chat or another project.
      const context = await contextFor(store, member, session.projectId, task?.documentIds || [], { includeSummary: false });
      const contextHash = createHash('sha256').update(context).digest('hex');
      session.resumeClaudeId = session.provider === 'claude' && previous && (conversation.providerSessionId || previous.contextHash === contextHash || session.explicitContinuation)
        ? previous.providerSessionId || null : null;
      let prompt = session.resumeThreadId && previous.contextHash === contextHash
        ? '' : context ? `작업 참고 자료:\n${context}` : '';
      prompt += `\n\nTARS 실행 ID: ${session.id}\n연결된 업무 ID(requestId): ${session.requestId || '없음: 아직 업무로 등록하지 않은 대화'}\nTARS 실행 신원은 MCP 환경변수로 전달됩니다. executionToken 인수는 생략하세요.\n이 값은 실행 신원이며 결과 보고나 문서에 기록하지 마세요. 대화 한 턴은 업무가 아닙니다. 질문·현황 조회·일반 대화에는 업무를 만들지 마세요. 실제 수행할 목표와 범위가 정해지면 팀장 또는 CEO가 tars_register_work로 업무 제목과 instruction을 등록하고 반환된 ID에 문서와 하위 작업을 연결하세요. 기존 업무의 후속 협의라면 tars_register_work에 기존 requestId를 넣어 연결하고 중복 등록하지 마세요. 업무 등록은 실행 승인과 별개이며 사용자의 계획만·수정 금지 조건을 지키세요. 팀원 결과는 자동으로 팀장 검토와 TARS 보고로 이어집니다. 생성된 DB·업무 기록 파일을 직접 편집하지 마세요.`;
      store.patch('sessions', session.id, { workspace: cwd, resumeThreadId: session.resumeThreadId, resumeClaudeId: session.resumeClaudeId, contextHash,
        ...(session.guidance ? { guidanceHash: session.guidance.hash, expectedInstructionSources: session.guidance.expectedSources,
          expectedSkills: session.guidance.skills, guidanceStatus: 'prepared' } : {}) });
      if (session.kind === 'user_followup') {
        const approval = store.require('workApprovals', session.approvalId);
        const source = store.require('sessions', session.continuationOf);
        const directory = join(DATA, 'sessions', session.id);
        await mkdir(directory, { recursive: true });
        const path = join(directory, 'user-feedback.json');
        const attempt = session.previousAttemptId && store.get('sessions', session.previousAttemptId);
        await writeFile(path, JSON.stringify({ approval, original: { sessionId: source.id, prompt: source.prompt, output: source.output },
          previousAttempt: attempt ? { sessionId: attempt.id, output: attempt.output, status: attempt.status, error: attempt.progress } : null }, null, 2), { mode: 0o600 });
        store.patch('sessions', session.id, { continuationMode: session.resumeThreadId || session.resumeClaudeId ? 'resuming' : 'context', feedbackPath: path });
        prompt += `\n\n사용자가 업무 기록에서 남긴 응답을 처리합니다. 원래 담당자: ${member.name}\n원본 실행: ${source.id}\n협의안·보고서의 고정된 원문과 사용자 응답: ${path}\n이 파일을 먼저 읽으세요. previousAttempt가 있으면 이전 후속 실행이 일부 처리했을 수 있으므로 저장 상태와 결과를 대조하고 이미 수행한 변경을 반복하지 마세요. ${session.prompt}\n업무 ID는 ${session.requestId}입니다. 다른 업무나 새 요청을 만들지 마세요. 기존 문서·작업을 수정할 때 버전과 ID를 유지하고 관리 API로 갱신하세요.\n${approval.response.decision === 'feedback'
          ? '사용자 의견을 반영해 협의안 또는 결과 보고를 보완하세요. 승인 전에는 새 작업을 실행하거나 소스를 수정하지 마세요. 목표·범위·담당·완료 기준을 바꿨으면 변경된 협의안을 다시 제출합니다. 마지막 답변에는 반영 내용, 남은 질문과 변경한 문서·작업을 보고하세요.'
          : approval.kind === 'plan' ? '사용자가 이 버전의 협의안을 승인했습니다. 승인된 범위의 배정·실행을 이어가세요. 범위를 변경하면 다시 사용자 승인이 필요합니다. 아직 실행하지 않은 승인된 작업은 이 응답 종료 후 대기열에 등록됩니다.'
            : approval.snapshot.report.final ? '사용자가 결과 보고를 최종 확인했습니다. 승인 접수와 완료 내용을 짧게 알리세요. 이 실행은 확인 답변만 작성하며 문서·작업·소스를 변경하거나 새로운 작업을 시작하지 마세요.' : '사용자가 진행·차단 보고를 확인했습니다. 확인 접수와 남아 있는 사항을 짧게 알리세요. 업무가 완료되었다고 표현하지 마세요. 이 실행에서는 문서·작업·소스를 변경하거나 새 작업을 시작하지 마세요.'}`;
      } else if (session.kind === 'task_review') {
        const report = store.require('taskReports', session.reviewReportId);
        await assertCurrentArtifacts(store, task, report);
        if (task.goalId) prompt += `\n\n업무 측정 목표: ${JSON.stringify(store.require('requests', task.requestId).progressPlan?.goals.find(goal => goal.id === task.goalId))}\n이 TASK의 배정 수량 ${task.plannedUnits}단위 전체가 목표의 완료 기준을 충족하는지 확인하세요. 팀원의 completedUnits 주장은 검증 근거를 대신하지 않습니다.`;
        prompt += `\n\n결과 검토 대상: ${task.title}\n작업 ID: ${task.id}\n결과 ID: ${report.id} · v${report.version}\n지시: ${task.description}\n완료 기준: ${task.acceptance || '없음: 완료 판정 불가'}\n산출물 작업 폴더: ${task.workspace}\n변경 패치: ${report.artifacts.patchPath || '해당 없음'}\n전체 업무 기록: ${taskRecordPath(task.id)}\n보고 내용:\n${report.content.slice(0, 20000)}\n\n완료 기준 목록: ${JSON.stringify(report.criteria)}\n실제 산출물과 검증 근거를 확인하고 모든 완료 기준의 ID(C1 등)를 criterion으로 사용해 checks를 작성하세요. 보고서의 성공 주장만으로 승인하지 마세요. 부족하면 rework와 구체적인 reworkInstructions, 외부 결정이 필요하면 blocked를 반환하세요. 필수 검증을 하지 못했으면 not_verified입니다. 작업 파일과 업무 상태를 직접 수정하지 말고 판정 JSON을 반환하세요. accepted는 모든 완료 기준과 요청한 통합·배포·장비 검증까지 근거가 확인된 경우에만 사용하세요. knowledge에는 검토로 확인한 재사용 가능한 결론과 적용 범위만 적으세요.`;
      } else if (['request_report', 'request_escalation'].includes(session.kind)) {
        const request = store.require('requests', session.requestId);
        const job = store.require('workflowJobs', session.workflowJobId);
        const snapshot = job.snapshot.map(item => ({ ...item, recordPath: taskRecordPath(item.id),
          result: item.acceptedReportId ? store.get('taskReports', item.acceptedReportId)?.content : null,
          review: store.list('taskReviews').find(review => review.reportId === item.acceptedReportId) || null }));
        const directory = join(DATA, 'sessions', session.id);
        await mkdir(directory, { recursive: true });
        const path = join(directory, 'request-snapshot.json');
        await writeFile(path, JSON.stringify({ request, progress: workProgress(request, store.list('tasks')), tasks: snapshot }, null, 2), { mode: 0o600 });
        prompt += `\n\n사용자의 원래 요청: ${request.instruction}\n보고 대상 전체 ${snapshot.length}개 작업의 고정된 결과: ${path}\n이 파일과 필요한 작업 기록을 읽고 요청 범위 대비 결과, 검토된 근거, 미완료·취소·미검증, 필요한 사용자 결정을 보고하세요. 업무를 새로 실행하거나 상태를 바꾸지 말고 보고만 작성하세요. 결과가 없는 완료 상태는 이전 기록으로 표시하세요. ${session.kind === 'request_escalation' ? '차단 원인과 다음 선택지를 중심으로 작성하세요.' : '원래 요청에서 빠진 항목이 있으면 완료로 표현하지 마세요.'}`;
      } else if (task) {
        if (task.goalId) {
          const goal = store.require('requests', task.requestId).progressPlan?.goals.find(goal => goal.id === task.goalId);
          prompt += `\n\n배정 목표: ${JSON.stringify(goal)}\n이 TASK의 배정 수량: ${task.plannedUnits}${goal?.unit || '단위'}. 수행한 누적 수량을 tars_log_progress의 completedUnits로 보고하세요. message에 단위별 수행 근거, next에 다음 할 일을 짧게 기록합니다. 임의의 퍼센트와 미검증 수량을 만들지 마세요.`;
        }
        const dependencies = task.dependsOn.map(key => store.require('tasks', key)).map(t => `${t.title} (${t.acceptedReportId ? '검토된 결과' : '이전 결과 · 검토 기록 없음'}): ${(t.report || '').slice(0, 3000)}`);
        prompt += `\n\n작업: ${task.title}\n${task.description}\n완료 기준: ${task.acceptance}\n실제 작업 디렉토리: ${cwd}\n선행 작업 결과:\n${dependencies.join('\n')}\n기본 작업 위치는 위 작업 디렉토리입니다. 사용자 요청에 필요한 파일 수정·명령·네트워크·검증과 도구 사용을 직접 수행하세요. 원본 반영·커밋·푸시·배포는 사용자 요청 범위와 프로젝트 지침에 따라 처리하세요. 최종 답변은 결과, 변경 파일, 수행한 검증, 미검증 사항, 남은 문제와 후속 작업 제안을 Markdown으로 보고하세요.`;
        prompt += `\n\n${reportInstructions}\n이 실행의 지시·task·보고·상태 변경은 TARS가 실행 ${session.id}의 이력으로 보관합니다.`;
        prompt += `\n\n이전 보완 지시: ${task.reworkInstructions || '없음'}\n전체 작업 기록: ${taskRecordPath(task.id)}\n결과는 지정 JSON 스키마로 반환하세요. summary, workPerformed, artifacts(파일 경로·설명), verification(완료 기준·passed/failed/not_run·증거), remaining, followUp을 실제 수행 내용으로 채우세요. 없는 목록은 빈 배열입니다. 검증 로그 등 근거 파일도 artifacts에 포함하세요. 결과 제출은 완료 판정이 아니며 팀장이 검토합니다.`;
      } else if (isMemberChat(session)) {
        if (member.role === 'ceo' && !(session.resumeThreadId || session.resumeClaudeId)) prompt += `\n\n${await ceoContext(store, session.projectId, cwd)}`;
        prompt += `\n\n${await memberConversationContext(store, session, { previous, resumed: Boolean(session.resumeThreadId || session.resumeClaudeId) })}`;
      } else if (session.kind === 'oversight') {
        prompt += `\n\n${await ceoContext(store, session.projectId, cwd)}\n\n사용자 요청:\n${session.prompt}\n\n결과는 현황 요약, 프로젝트별 상태, 차단 사항과 담당 팀장, 우선순위, 필요한 사용자 결정을 포함한 Markdown으로 작성하세요.`;
      } else if (session.kind === 'plan') {
        prompt += `\n\n사용자 요청: ${session.prompt}\n자유롭게 협의하고 필요한 업무·문서·TASK는 관리 도구로 등록하세요. 승인 전에는 실행하지 마세요.`;
      } else {
        const tasks = store.list('tasks').filter(t => t.departmentId === member.departmentId && (!session.projectId || t.projectId === session.projectId));
        prompt += `\n\n보고 요청: ${session.prompt}\n전체 ${tasks.length}개 중 최근 24개 작업 현황:\n${JSON.stringify(tasks.slice(0, 24).map(t => ({ title: t.title, status: t.status, report: (t.report || '').slice(0, 1500), error: t.error, assigneeId: t.assigneeId, integratedAt: t.integratedAt })))}\n현재 기록을 근거로 결과 요약, 담당자별 완료/미완료, 산출물, 통합 상태, 검증 여부, 차단 사항을 Markdown으로 보고하세요. 보고 대상이 일부이면 그 범위를 명시하세요. 검증하지 않은 결과를 성공으로 단정하지 마세요.`;
      }
      if (['ceo', 'leader'].includes(member.role)) {
        await this.statusFiles.flush();
        if (previous && (session.resumeThreadId || session.resumeClaudeId)) {
          const since = previous.endedAt || previous.startedAt;
          const changes = Object.fromEntries(['requests', 'tasks', 'documents', 'workApprovals'].map(kind => [kind,
            store.list(kind).filter(item => item.updatedAt > since && (!session.projectId || item.projectId === session.projectId)
              && (member.role === 'ceo' || !item.departmentId || item.departmentId === member.departmentId))
              .slice(0, 24).map(item => ({ id: item.id, title: item.title, status: item.status, version: item.version }))]));
          prompt += `\n\n이전 턴 이후 변경 요약(종류별 최근 24개, 상세는 tars_get_state collection/id): ${JSON.stringify(changes)}`;
        } else prompt += managementContext(store, member, session.projectId);
      }
      if (session.explicitContinuation) prompt += `\n\n사용자가 명시적으로 이전 세션을 이어갑니다. 이전 실행 상태와 저장된 변경을 확인하고 중복 수행하지 마세요. 현재 추가 지시: ${session.prompt}`;
      if (control.cancelled) throw new Error('실행 준비 중 취소되었습니다.');
      let lastProgress = 0;
      const handle = await this.launchRun({ session, member, cwd, prompt,
        codexServers: this.codexServers,
        onInteraction: (request, options) => this.interactions.ask(session.id, request, options),
        onInput: questions => this.inputs.ask(session.id, questions, 'provider'),
        isWaiting: () => store.require('sessions', session.id).status === 'waiting_input',
        minutes: store.get('settings', 'main').maxSessionMinutes,
        onSpawn: pid => store.patch('sessions', session.id, { pid, status: 'running', workspace: cwd, lastActivityAt: now(), progress: 'AI 응답 대기 중' }),
        onIdentity: values => {
          const updated = { ...store.require('sessions', session.id), ...values };
          recordConversationRun(store, updated);
          store.patch('sessions', session.id, { ...values, lastActivityAt: now(),
            ...(control.cancelled ? { status: 'stopping', progress: '중지 요청을 처리 중입니다.' } : {}) });
        },
        onEvent: (progress, extra = {}) => {
          if (extra.activity || typeof extra.output === 'string' || Date.now() - lastProgress > 1000) {
            store.patchProgress(session.id, () => ({ progress: control.cancelled ? '중지 요청을 처리 중입니다.' : progress, lastActivityAt: now(),
              ...(extra.activity ? saveSessionActivity(store, session.id, extra.activity) : {}),
              ...(extra.activityNote ? { activityNote: extra.activityNote.slice(0, 1000) } : {}),
              ...(typeof extra.output === 'string' ? { output: extra.output.slice(-80000) } : {}) })); lastProgress = Date.now();
          }
        },
      });
      control.handle = handle;
      if (control.cancelled) handle.cancel();
      const result = await handle.promise;
      this.interactions.close(session.id);
      recordConversationRun(store, { ...store.require('sessions', session.id), providerSessionId: result.providerSessionId });
      store.transaction(() => store.patch('sessions', session.id, { output: result.output, providerSessionId: result.providerSessionId, logPath: result.logPath,
        ...(result.activity ? saveSessionActivity(store, session.id, result.activity) : {}),
        ...(result.activityNote ? { activityNote: result.activityNote.slice(0, 1000) } : {}),
        providerTurnId: result.providerTurnId, providerTurnStatus: result.providerTurnStatus,
        ...(session.continuationOf ? { continuationMode: result.providerSessionId && result.providerSessionId === (session.resumeThreadId || session.resumeClaudeId) ? 'resumed' : 'context' } : {}) }));
      if (result.failure || control.cancelled) throw new Error(result.failure || '실행이 취소되었습니다.');
      if (session.kind === 'work') {
        const report = await this.workflow.submit(session, result.structured || JSON.parse(result.output));
        store.patch('sessions', session.id, { output: report.content, reportId: report.id });
      }
      if (session.kind === 'task_review') {
        const review = await this.workflow.review(task.id, session.reviewReportId, result.structured || JSON.parse(result.output), member.id, session.id);
        store.patch('sessions', session.id, { output: `${review.decision}\n\n${review.rationale}\n\n${review.reworkInstructions}`, reviewId: review.id });
        await syncShared(store);
      }
      if (['request_report', 'request_escalation'].includes(session.kind)) {
        const document = this.workflow.finishRequest(session.workflowJobId, session, result.output);
        store.patch('sessions', session.id, { documentIds: document ? [document.id] : [], superseded: !document });
        if (document) await syncShared(store);
      }
      if (session.kind === 'plan' && result.structured) this.applyPlan(session, member, result.structured);
      if (['ceo_chat', 'member_chat', 'plan'].includes(session.kind)) {
        const current = store.require('sessions', session.id);
        for (const requestId of new Set([current.requestId, ...(current.requestIds || [])].filter(Boolean))) {
          this.workflow.approvals.submitPlan(requestId, session.id);
          this.queueApprovedDrafts(requestId, session.memberId);
        }
      }
      if (session.kind === 'user_followup') this.finishFollowup(session);
      if (['review', 'oversight'].includes(session.kind)) {
        const document = store.put('documents', {
          title: `${member.name} · ${session.kind === 'oversight' ? '프로젝트 총괄 보고' : '결과 보고'}`, kind: 'report', content: result.output, version: 1, revisions: [], requestId: session.requestId || null,
          projectId: session.projectId, departmentId: member.departmentId, sessionId: session.id,
        });
        store.patch('sessions', session.id, { documentIds: [document.id] });
        if (session.requestId) {
          store.patch('requests', session.requestId, { reportDocumentId: document.id });
          this.workflow.approvals.submitReport(session.requestId, session.id, document.id);
        }
      }
      if (['plan', 'review', 'oversight', 'ceo_chat', 'member_chat', 'user_followup'].includes(session.kind)) await syncShared(store);
      store.patch('sessions', session.id, { status: 'completed', endedAt: now(), progress: '작업 결과가 준비되었습니다.' });
      store.event(`${member.name} · 결과 도착`, { sessionId: session.id, taskId: task?.id, memberId: member.id });
    } catch (error) {
      store.patch('sessions', session.id, { status: control.cancelled ? 'cancelled' : 'failed', endedAt: now(), progress: error.message });
      const job = session.workflowJobId ? store.require('workflowJobs', session.workflowJobId) : null;
      if (session.taskId) {
        const task = store.require('tasks', session.taskId);
        const ownsOutcome = job ? job.status === 'running' : task.sessionId === session.id;
        if (ownsOutcome && !task.automationPaused && !['done', 'cancelled'].includes(task.status)) store.patch('tasks', task.id, { status: 'blocked', error: error.message });
      }
      if (session.workflowJobId) {
        if (job.status === 'running') store.patch('workflowJobs', job.id, { status: control.cancelled ? 'cancelled' : 'blocked', error: error.message });
      }
      store.event(`${member.name} · ${error.message}`, { sessionId: session.id, taskId: session.taskId, memberId: member.id, level: 'error' });
    } finally {
      this.inputs.cancel(session.id);
      recordConversationRun(store, store.require('sessions', session.id));
      await this.saveRecord(session.id);
      this.active.delete(session.id);
      this.interactions.close(session.id);
      store.patch('members', member.id, { status: 'idle', currentSessionId: null });
    }
  }
  async saveRecord(sessionId) {
    try { await writeExecutionRecord(this.store, sessionId); }
    catch (error) {
      this.store.patch('sessions', sessionId, { recordError: error.message });
      this.store.event(`업무 기록 파일 저장 실패: ${error.message}`, { sessionId, level: 'error' });
    }
  }
  applyPlan(session, member, raw) {
    const plan = planSchema.parse(raw);
    if (!plan.work) {
      if (plan.tasks.length || plan.agreement.trim() || plan.specification.trim()) fail('업무 문서와 하위 작업에는 등록할 업무(work)가 필요합니다.', 400);
      this.store.patch('sessions', session.id, { output: plan.summary });
      return;
    }
    const members = this.store.list('members').filter(m => m.departmentId === member.departmentId && m.role === 'member');
    for (const [index, task] of plan.tasks.entries()) {
      if (task.assigneeId && !members.some(m => m.id === task.assigneeId)) fail('팀장이 존재하지 않는 담당자를 반환했습니다.', 400);
      if (task.dependsOn.some(dep => dep >= index)) fail('팀장의 작업 의존 순서가 올바르지 않습니다.', 400);
    }
    this.store.transaction(() => {
      const current = this.store.require('sessions', session.id);
      const request = this.workflow.registerRequest({ ...plan.work, projectId: session.projectId,
        requestId: plan.work.requestId || current.requestId || null }, { actor: member.id, session: current });
      if (plan.tasks.length) this.store.patch('requests', request.id, { status: 'open', reportDocumentId: null });
      const metadata = { requestId: request.id, projectId: session.projectId, departmentId: member.departmentId, sessionId: session.id, version: 1, revisions: [] };
      const documents = [
        plan.agreement.trim() && this.store.put('documents', { ...metadata, title: `${request.title} · 협의 문서`, kind: 'agreement', content: plan.agreement }),
        plan.specification.trim() && this.store.put('documents', { ...metadata, title: `${request.title} · 설계 사양`, kind: 'specification', content: plan.specification }),
      ].filter(Boolean);
      const taskIds = plan.tasks.map(() => id());
      plan.tasks.forEach((task, index) => {
        validateProgressAllocation(this.store, request, task);
        this.store.put('tasks', {
        ...task, id: taskIds[index], projectId: session.projectId, departmentId: member.departmentId,
        status: task.assigneeId ? 'assigned' : 'draft', priority: 'normal',
        documentIds: documents.map(doc => doc.id), dependsOn: task.dependsOn.map(dep => taskIds[dep]),
        isolation: session.projectId ? 'worktree' : 'personal', createdBy: member.id, originSessionId: session.id,
        requestId: request.id, reworkCount: 0, automationPaused: false,
      }, { actor: member.id });
      });
      this.store.patch('sessions', session.id, { output: plan.summary,
        documentIds: [...new Set([...(current.documentIds || []), ...documents.map(doc => doc.id)])],
        taskIds: [...new Set([...(current.taskIds || []), ...taskIds])] });
      this.workflow.approvals.submitPlan(request.id, session.id);
    });
  }
  stop(sessionId, actor = 'user') {
    const control = this.active.get(sessionId);
    if (!control) fail('실행 중인 세션이 아닙니다.');
    control.cancelled = true;
    this.inputs.cancel(sessionId, '사용자가 실행을 중지했습니다.');
    const session = this.store.require('sessions', sessionId);
    if (actor !== 'system') {
      const task = session.taskId ? this.store.require('tasks', session.taskId) : null;
      const job = session.workflowJobId ? this.store.require('workflowJobs', session.workflowJobId) : null;
      if (task && !['done'].includes(task.status) && (!job || ['queued', 'running', 'cancelled'].includes(job.status))) this.workflow.pauseTask(task.id, actor, task.status === 'cancelled');
      else if (!task) for (const requestId of new Set([session.requestId, ...(session.requestIds || [])].filter(Boolean))) this.workflow.pauseRequest(requestId);
      if (job && ['queued', 'running', 'cancelled'].includes(job.status)) this.store.patch('workflowJobs', job.id, { status: 'cancelled', error: '사용자가 중지했습니다.' });
    }
    this.store.patch('sessions', sessionId, { status: 'stopping', progress: '중지 요청을 처리 중입니다.' }, { actor });
    control.handle?.cancel();
  }
  async steer(sessionId, prompt) {
    const control = this.active.get(sessionId);
    const session = this.store.require('sessions', sessionId);
    if (!control?.handle?.steer || control.cancelled || session.status !== 'running') fail('추가 지시는 실행 중인 세션에서만 가능합니다.');
    if (control.steering) fail('이전 추가 지시를 전송 중입니다.');
    if ((session.steering || []).length >= 20) fail('한 턴의 추가 지시는 최대 20회입니다. 다음 대화에서 이어가세요.');
    control.steering = true;
    try {
      await control.handle.steer(prompt);
      const current = this.store.require('sessions', sessionId);
      this.store.patch('sessions', sessionId, { steering: [...(current.steering || []), { id: id(), prompt, createdAt: now() }] });
    } finally { control.steering = false; }
    return { ok: true };
  }
  queueApprovedDrafts(requestId, actor) {
    if (!this.workflow.approvals.canExecute(requestId)) return;
    for (const task of this.store.list('tasks').filter(item => item.requestId === requestId)) {
      if (['draft', 'assigned'].includes(task.status) && task.assigneeId && task.acceptance?.trim()) this.workflow.queueTask(task.id, actor);
    }
  }
  continueSession(sessionId, prompt) {
    const source = this.store.require('sessions', sessionId);
    if (liveSession(source)) fail('실행이 끝난 세션만 이어갈 수 있습니다.');
    if (!source.providerSessionId || !source.workspace) fail('재개할 제공사 세션이나 작업 경로가 없습니다.');
    const task = source.taskId && this.store.get('tasks', source.taskId);
    assertWorkNotDeleted(this.store, task?.requestId || source.requestId);
    const resumeWork = source.kind === 'work' && task?.sessionId === source.id && ['blocked', 'cancelled'].includes(task.status);
    if (resumeWork && task.deletedAt) fail('삭제된 작업은 다시 실행할 수 없습니다.', 404);
    if (resumeWork) this.workflow.approvals.assertExecutable(task.requestId);
    const member = this.store.require('members', source.memberId);
    if (member.provider !== source.provider || (member.codexAccount || 'codex') !== (source.codexAccount || 'codex')) fail('원래 제공사와 계정으로 설정한 뒤 이어가세요.');
    const { session, control } = this.store.transaction(() => {
      const run = this.begin(member, resumeWork ? 'work' : member.role === 'ceo' ? 'ceo_chat' : 'member_chat', {
        ...(resumeWork ? { taskId: task.id } : {}), projectId: source.projectId, requestId: source.requestId,
        conversationId: source.conversationId, prompt, continuationOf: source.id, explicitContinuation: true,
        resumeWorkspace: source.workspace, previousTaskId: task?.id || null });
      if (resumeWork) this.store.patch('tasks', task.id, { status: 'running', automationPaused: false, sessionId: run.session.id, error: null, completedUnits: 0, blocker: null });
      return run;
    });
    control.promise = this.run(session, member, control);
    return session;
  }
  async shutdown() {
    this.closing = true;
    clearInterval(this.timer);
    clearInterval(this.heartbeatTimer);
    for (const [sessionId] of this.active) if (liveSession(this.store.get('sessions', sessionId))) this.stop(sessionId, 'system');
    await Promise.allSettled([...this.active.values()].map(control => control.promise));
    await this.codexServers.close();
    await this.statusFiles.close();
  }
}
