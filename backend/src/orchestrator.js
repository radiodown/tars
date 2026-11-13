import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { id, now } from './store.js';
import { fail, planSchema } from './contracts.js';
import { contextFor, memberDirectory, prepareWorkspace, syncShared } from './workspaces.js';
import { guidanceFilesHash, prepareGuidance, prepareScope } from './guidance.js';
import { killOwned, launch } from './providers.js';
import { CodexAppServers } from './codex-app-server.js';
import { CEO_ID, ceoContext, ceoConversation } from './ceo.js';
import { WorkStatusFiles, managementContext, reportInstructions, requestSnapshot, writeExecutionRecord } from './work-records.js';

export class Orchestrator {
  constructor(store) {
    this.store = store;
    this.active = new Map();
    this.closing = false;
    this.pumping = false;
    this.codexServers = new CodexAppServers(store, killOwned);
    this.statusFiles = new WorkStatusFiles(store);
  }
  async recover() {
    await this.codexServers.recover();
    const interrupted = [];
    for (const session of this.store.list('sessions').filter(s => ['preparing', 'running', 'stopping'].includes(s.status))) {
      if (session.transport !== 'app-server') await killOwned(session, 'SIGKILL');
      this.store.patch('sessions', session.id, { status: 'interrupted', endedAt: now(), progress: '서버 종료로 중단되었습니다. 다시 실행할 수 있습니다.' });
      interrupted.push(session.id);
    }
    this.store.transaction(() => {
      for (const member of this.store.list('members')) this.store.patch('members', member.id, { status: 'idle', currentSessionId: null });
      for (const task of this.store.list('tasks').filter(t => ['queued', 'running'].includes(t.status))) {
        this.store.patch('tasks', task.id, { status: 'blocked', error: '서버 재시작으로 중단되었습니다. 작업 실행을 다시 요청하세요.' });
      }
    });
    for (const sessionId of interrupted) await this.saveRecord(sessionId);
    this.timer = setInterval(() => this.pump().catch(error => this.store.event(error.message, { level: 'error' })), 1500);
    this.heartbeatTimer = setInterval(() => {
      if (this.closing || !this.active.size) return;
      this.store.transaction(() => {
        for (const sessionId of this.active.keys()) {
          const session = this.store.get('sessions', sessionId);
          if (['preparing', 'running', 'stopping'].includes(session?.status)) this.store.patch('sessions', sessionId, { heartbeatAt: now() });
        }
      });
    }, 15000);
    this.statusFiles.start();
    await this.statusFiles.flush();
  }
  assertAvailable(member) {
    if (this.closing) fail('서버가 종료 중입니다.');
    if (member.status === 'running' || [...this.active.values()].some(run => run.memberId === member.id)) fail('이 AI는 이미 작업 중입니다.');
    if (this.active.size >= this.store.get('settings', 'main').maxConcurrent) fail('동시 실행 한도에 도달했습니다. 진행 중인 작업이 끝난 뒤 다시 요청하세요.');
  }
  begin(member, kind, details) {
    this.assertAvailable(member);
    const session = this.store.put('sessions', {
      memberId: member.id, departmentId: member.departmentId, provider: member.provider,
      codexAccount: member.provider === 'codex' ? member.codexAccount || 'codex' : null,
      model: member.model || 'default', reasoning: member.reasoning || 'default',
      transport: member.provider === 'codex' ? 'app-server' : 'cli', kind, status: 'preparing', startedAt: now(), endedAt: null,
      progress: '작업 문맥 준비 중', output: '', processToken: id(), heartbeatAt: now(), lastActivityAt: null,
      request: requestSnapshot(this.store, member, kind, details), ...details,
    });
    const control = { memberId: member.id, cancelled: false, handle: null };
    this.active.set(session.id, control);
    this.store.patch('members', member.id, { status: 'running', currentSessionId: session.id });
    this.store.event(`${member.name} · ${kind === 'ceo_chat' ? '대화' : kind === 'oversight' ? '프로젝트 총괄 보고' : kind === 'plan' ? '협의 및 작업 설계' : kind === 'review' ? '결과 보고' : '작업'} 시작`, { memberId: member.id, sessionId: session.id, taskId: details.taskId });
    return { session, control };
  }
  consult(input) {
    const member = this.store.require('members', input.leaderId);
    if (member.role !== 'leader') fail('팀장을 선택하세요.', 400);
    if (input.projectId) this.store.require('projects', input.projectId);
    const { session, control } = this.begin(member, 'plan', { projectId: input.projectId, prompt: input.prompt });
    control.promise = this.run(session, member, control);
    return session;
  }
  report(input) {
    const member = this.store.require('members', input.leaderId);
    if (member.role !== 'leader') fail('팀장을 선택하세요.', 400);
    if (input.projectId) this.store.require('projects', input.projectId);
    const { session, control } = this.begin(member, 'review', { projectId: input.projectId, prompt: input.prompt });
    control.promise = this.run(session, member, control);
    return session;
  }
  queue(taskId) {
    const task = this.store.require('tasks', taskId);
    if (!['draft', 'assigned', 'blocked', 'review'].includes(task.status)) fail('현재 상태에서는 작업을 실행할 수 없습니다.');
    const member = this.store.require('members', task.assigneeId);
    if (member.role !== 'member' || member.departmentId !== task.departmentId) fail('같은 부서의 팀원을 담당자로 지정하세요.');
    this.store.patch('tasks', taskId, { status: 'queued', error: null }, { actor: 'user' });
    this.store.event(`실행 대기: ${task.title}`, { taskId });
    return this.store.require('tasks', taskId);
  }
  oversee(input) {
    const member = this.store.require('members', CEO_ID);
    if (input.projectId) this.store.require('projects', input.projectId);
    const { session, control } = this.begin(member, 'oversight', { projectId: input.projectId, prompt: input.prompt });
    control.promise = this.run(session, member, control);
    return session;
  }
  chat(input) {
    const member = this.store.require('members', CEO_ID);
    if (input.projectId) this.store.require('projects', input.projectId);
    const conversationId = member.chatConversationIds?.[input.projectId || 'all'] || null;
    const { session, control } = this.begin(member, 'ceo_chat', { projectId: input.projectId, prompt: input.prompt, conversationId });
    control.promise = this.run(session, member, control);
    return session;
  }
  resetChat({ projectId }) {
    if (this.closing) fail('서버가 종료 중입니다.');
    const member = this.store.require('members', CEO_ID);
    if (projectId) this.store.require('projects', projectId);
    if (member.status === 'running' || [...this.active.values()].some(run => run.memberId === member.id)) {
      fail('TARS의 진행 중인 작업을 중지하거나 끝난 뒤 /clear를 실행하세요.');
    }
    const conversationId = id();
    return this.store.transaction(() => {
      this.store.patch('members', member.id, {
        chatConversationIds: { ...member.chatConversationIds, [projectId || 'all']: conversationId },
      }, { actor: 'user' });
      this.store.event('TARS · 새 대화 시작', { memberId: member.id, projectId, conversationId });
      return { conversationId };
    });
  }
  async pump() {
    if (this.closing || this.pumping) return;
    this.pumping = true;
    try {
      for (const task of this.store.list('tasks').filter(t => t.status === 'queued').reverse()) {
        if (this.active.size >= this.store.get('settings', 'main').maxConcurrent) break;
        if (!task.dependsOn.every(key => this.store.get('tasks', key)?.status === 'done')) continue;
        const member = this.store.get('members', task.assigneeId);
        if (!member) {
          this.store.patch('tasks', task.id, { status: 'blocked', error: '담당 AI가 없습니다.' });
          continue;
        }
        if (member.status === 'running') continue;
        const { session, control } = this.begin(member, 'work', { taskId: task.id, projectId: task.projectId });
        this.store.patch('tasks', task.id, { status: 'running', sessionId: session.id, error: null });
        control.promise = this.run(session, member, control);
      }
    } finally { this.pumping = false; }
  }
  async run(session, member, control) {
    const store = this.store;
    try {
      const task = session.taskId ? store.require('tasks', session.taskId) : null;
      const scope = session.provider === 'codex' ? await prepareScope(store, member, session.projectId) : memberDirectory(member);
      const cwd = task ? await prepareWorkspace(store, task, member) : scope;
      if (session.provider === 'codex') session.guidance = await prepareGuidance(store, member, session.projectId, cwd);
      // Reuse only the latest successfully completed conversation in this exact scope.
      // Never cross accounts/workspaces or silently replay a failed/interrupted mutation.
      const previous = session.provider === 'codex' ? store.list('sessions').find(item => item.id !== session.id
        && item.transport === 'app-server' && item.memberId === member.id && item.codexAccount === session.codexAccount
        && item.kind === session.kind && item.projectId === session.projectId && item.taskId === session.taskId
        && (item.conversationId || null) === (session.conversationId || null)
        && item.workspace === cwd && item.model === session.model && item.reasoning === session.reasoning) : null;
      const unchanged = previous?.loadedGuidanceHash && previous.guidanceHash === session.guidance?.hash
        && previous.loadedGuidanceHash === await guidanceFilesHash([...(previous.instructionSources || []), ...(previous.availableSkills || []).map(skill => skill.path)]);
      session.resumeThreadId = previous?.status === 'completed' && previous.providerTurnStatus === 'completed'
        && unchanged ? previous.providerSessionId : null;
      // CEO chat history is scoped by conversation; the member summary may belong to an older chat or another project.
      const includeSummary = session.kind !== 'ceo_chat';
      const context = await contextFor(store, member, session.projectId, task?.documentIds || [], { includeSummary: session.provider !== 'codex' && includeSummary });
      const contextHash = createHash('sha256').update(context).digest('hex');
      let prompt = session.resumeThreadId && previous.contextHash === contextHash
        ? '' : context ? `작업 참고 자료:\n${context}` : '';
      if (session.provider === 'codex' && !session.resumeThreadId && includeSummary && member.summary) prompt += `\n\n이전 작업 인계 요약:\n${member.summary.slice(-2000)}`;
      store.patch('sessions', session.id, { workspace: cwd, resumeThreadId: session.resumeThreadId, contextHash,
        ...(session.guidance ? { guidanceHash: session.guidance.hash, expectedInstructionSources: session.guidance.expectedSources,
          expectedSkills: session.guidance.skills, guidanceStatus: 'prepared' } : {}) });
      if (task) {
        const dependencies = task.dependsOn.map(key => store.require('tasks', key)).map(t => `${t.title}: ${(t.report || '').slice(0, 3000)}`);
        prompt += `\n\n작업: ${task.title}\n${task.description}\n완료 기준: ${task.acceptance}\n실제 작업 디렉토리: ${cwd}\n선행 작업 결과:\n${dependencies.join('\n')}\n원본 경로는 수정하지 말고 현재 작업 디렉토리에서만 수정하세요. 커밋과 푸시는 하지 마세요. 최종 답변은 결과, 변경 파일, 수행한 검증, 미검증 사항, 남은 문제와 후속 작업 제안을 Markdown으로 보고하세요.`;
        prompt += `\n\n${reportInstructions}\n이 실행의 지시·task·보고·상태 변경은 TARS가 실행 ${session.id}의 이력으로 보관합니다.`;
      } else if (session.kind === 'ceo_chat') {
        prompt += `\n\n${await ceoContext(store, session.projectId, cwd)}\n\n${ceoConversation(store, session, { includeHistory: !session.resumeThreadId })}`;
      } else if (session.kind === 'oversight') {
        prompt += `\n\n${await ceoContext(store, session.projectId, cwd)}\n\n사용자 요청:\n${session.prompt}\n\n결과는 현황 요약, 프로젝트별 상태, 차단 사항과 담당 팀장, 우선순위, 필요한 사용자 결정을 포함한 Markdown으로 작성하세요.`;
      } else if (session.kind === 'plan') {
        const team = store.list('members').filter(m => m.departmentId === member.departmentId && m.role === 'member');
        const docs = store.list('documents').filter(d => d.departmentId === member.departmentId && d.projectId === session.projectId && ['agreement', 'specification'].includes(d.kind)).slice(0, 2);
        prompt += `\n\n사용자 요청:\n${session.prompt}\n\n최근 협의 문서:\n${docs.map(d => d.content.slice(0, 6000)).join('\n\n')}\n\n팀원 명단:\n${JSON.stringify(team.map(m => ({ id: m.id, name: m.name, specialty: m.specialty, model: m.model, provider: m.provider, codexAccount: m.provider === 'codex' ? m.codexAccount || 'codex' : null })))}\n\n협의 및 설계만 수행하세요. 사용자와 합의되지 않은 사항은 미결로 명시하세요. agreement는 목적, 범위, 합의, 제약, 미결, 완료 기준을 포함하는 Markdown입니다. specification은 구성, 흐름, 인터페이스, 오류 처리, 의존성, 검증 계획을 포함하는 Markdown입니다. tasks의 assigneeId는 위 팀원 ID 또는 null입니다. dependsOn은 tasks 배열의 앞선 항목 인덱스(0부터)만 사용하세요. 최대 20개 작업을 제안하고 실행하지 마세요. JSON 스키마에 맞게 결과를 반환하세요.`;
      } else {
        const tasks = store.list('tasks').filter(t => t.departmentId === member.departmentId && (!session.projectId || t.projectId === session.projectId));
        prompt += `\n\n보고 요청: ${session.prompt}\n전체 ${tasks.length}개 중 최근 24개 작업 현황:\n${JSON.stringify(tasks.slice(0, 24).map(t => ({ title: t.title, status: t.status, report: (t.report || '').slice(0, 1500), error: t.error, assigneeId: t.assigneeId, integratedAt: t.integratedAt })))}\n현재 기록을 근거로 결과 요약, 담당자별 완료/미완료, 산출물, 통합 상태, 검증 여부, 차단 사항을 Markdown으로 보고하세요. 보고 대상이 일부이면 그 범위를 명시하세요. 검증하지 않은 결과를 성공으로 단정하지 마세요.`;
      }
      if (['ceo', 'leader'].includes(member.role)) {
        await this.statusFiles.flush();
        prompt += managementContext(store, member, session.projectId);
      }
      if (control.cancelled) throw new Error('실행 준비 중 취소되었습니다.');
      let lastProgress = 0;
      const handle = await launch({ session, member, cwd, prompt,
        codexServers: this.codexServers,
        minutes: store.get('settings', 'main').maxSessionMinutes,
        onSpawn: pid => store.patch('sessions', session.id, { pid, status: 'running', workspace: cwd, lastActivityAt: now(), progress: 'AI 응답 대기 중' }),
        onIdentity: values => store.patch('sessions', session.id, { ...values, lastActivityAt: now(),
          ...(control.cancelled ? { status: 'stopping', progress: '중지 요청을 처리 중입니다.' } : {}) }),
        onEvent: (progress, extra = {}) => {
          if (typeof extra.output === 'string' || Date.now() - lastProgress > 1000) {
            store.patch('sessions', session.id, { progress: control.cancelled ? '중지 요청을 처리 중입니다.' : progress, lastActivityAt: now(),
              ...(extra.activityNote ? { activityNote: extra.activityNote.slice(0, 1000) } : {}),
              ...(typeof extra.output === 'string' ? { output: extra.output.slice(-80000) } : {}) }); lastProgress = Date.now();
          }
        },
      });
      control.handle = handle;
      if (control.cancelled) handle.cancel();
      const result = await handle.promise;
      store.patch('sessions', session.id, { output: result.output, providerSessionId: result.providerSessionId, logPath: result.logPath,
        providerTurnId: result.providerTurnId, providerTurnStatus: result.providerTurnStatus });
      if (result.failure || control.cancelled) throw new Error(result.failure || '실행이 취소되었습니다.');
      if (session.kind === 'plan') this.applyPlan(session, member, result.structured || JSON.parse(result.output));
      if (['review', 'oversight'].includes(session.kind)) {
        const document = store.put('documents', {
          title: `${member.name} · ${session.kind === 'oversight' ? '프로젝트 총괄 보고' : '결과 보고'}`, kind: 'report', content: result.output, version: 1, revisions: [],
          projectId: session.projectId, departmentId: member.departmentId, sessionId: session.id,
        });
        store.patch('sessions', session.id, { documentIds: [document.id] });
      }
      if (['plan', 'review', 'oversight'].includes(session.kind)) await syncShared(store);
      if (task) store.patch('tasks', task.id, { status: 'review', report: result.output, error: null });
      const summary = (store.require('sessions', session.id).output || result.structured?.summary || result.output).slice(-4000);
      store.patch('members', member.id, { summary });
      await writeFile(join(memberDirectory(member), 'context-summary.md'), summary);
      store.patch('sessions', session.id, { status: 'completed', endedAt: now(), progress: '작업 결과가 준비되었습니다.' });
      store.event(`${member.name} · 결과 도착`, { sessionId: session.id, taskId: task?.id, memberId: member.id });
    } catch (error) {
      store.patch('sessions', session.id, { status: control.cancelled ? 'cancelled' : 'failed', endedAt: now(), progress: error.message });
      if (session.taskId) {
        const task = store.require('tasks', session.taskId);
        store.patch('tasks', task.id, { status: task.status === 'cancelled' ? 'cancelled' : 'blocked', error: error.message });
      }
      store.event(`${member.name} · ${error.message}`, { sessionId: session.id, taskId: session.taskId, memberId: member.id, level: 'error' });
    } finally {
      await this.saveRecord(session.id);
      this.active.delete(session.id);
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
    const members = this.store.list('members').filter(m => m.departmentId === member.departmentId && m.role === 'member');
    for (const [index, task] of plan.tasks.entries()) {
      if (task.assigneeId && !members.some(m => m.id === task.assigneeId)) fail('팀장이 존재하지 않는 담당자를 반환했습니다.', 400);
      if (task.dependsOn.some(dep => dep >= index)) fail('팀장의 작업 의존 순서가 올바르지 않습니다.', 400);
    }
    this.store.transaction(() => {
      const metadata = { projectId: session.projectId, departmentId: member.departmentId, sessionId: session.id, version: 1, revisions: [] };
      const agreement = this.store.put('documents', { ...metadata, title: `${member.name} · 협의 문서`, kind: 'agreement', content: plan.agreement });
      const spec = this.store.put('documents', { ...metadata, title: `${member.name} · 설계 사양`, kind: 'specification', content: plan.specification });
      const taskIds = plan.tasks.map(() => id());
      plan.tasks.forEach((task, index) => this.store.put('tasks', {
        ...task, id: taskIds[index], projectId: session.projectId, departmentId: member.departmentId,
        status: task.assigneeId ? 'assigned' : 'draft', priority: 'normal',
        documentIds: [agreement.id, spec.id], dependsOn: task.dependsOn.map(dep => taskIds[dep]),
        isolation: session.projectId ? 'worktree' : 'personal', createdBy: member.id, originSessionId: session.id,
      }, { actor: member.id }));
      this.store.patch('sessions', session.id, { output: plan.summary, documentIds: [agreement.id, spec.id], taskIds });
    });
  }
  stop(sessionId, actor = 'user') {
    const control = this.active.get(sessionId);
    if (!control) fail('실행 중인 세션이 아닙니다.');
    control.cancelled = true;
    this.store.patch('sessions', sessionId, { status: 'stopping', progress: '중지 요청을 처리 중입니다.' }, { actor });
    control.handle?.cancel();
  }
  async steer(sessionId, prompt) {
    const control = this.active.get(sessionId);
    const session = this.store.require('sessions', sessionId);
    if (!control?.handle?.steer || control.cancelled || session.status !== 'running') fail('추가 지시는 실행 중인 Codex App Server 세션에서만 가능합니다.');
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
  async shutdown() {
    this.closing = true;
    clearInterval(this.timer);
    clearInterval(this.heartbeatTimer);
    for (const [sessionId] of this.active) this.stop(sessionId, 'system');
    await Promise.allSettled([...this.active.values()].map(control => control.promise));
    await this.codexServers.close();
    await this.statusFiles.close();
  }
}
