import { z } from 'zod';
import { fail, progressUpdateSchema } from './contracts.js';
import { now } from './store.js';

export const questionSchema = z.object({ question: z.string().trim().min(1).max(6000), options: z.array(z.string().max(500)).max(12).optional() }).strict();
export const answerSchema = z.object({ answers: z.record(z.string(), z.array(z.string().max(16000)).min(1).max(20)) }).strict();
export class SessionInputs {
  constructor(store) { this.store = store; this.pending = new Map(); }
  ask(sessionId, questions, source = 'tool') {
    const session = this.store.require('sessions', sessionId);
    if (!['preparing', 'running', 'waiting_input'].includes(session.status)) fail('질문을 받을 수 있는 실행이 아닙니다.');
    const item = this.store.put('inputRequests', { sessionId, taskId: session.taskId || null, memberId: session.memberId,
      requestId: session.requestId || null, questions, source, status: 'pending' });
    this.store.patch('sessions', sessionId, { status: 'waiting_input', progress: '사용자 답변을 기다리고 있습니다.' });
    return new Promise((resolve, reject) => this.pending.set(item.id, { resolve, reject }));
  }
  answer(inputId, raw) {
    const input = this.store.require('inputRequests', inputId);
    const { answers } = answerSchema.parse(raw);
    const expected = input.questions.map(question => question.id);
    if (Object.keys(answers).some(key => !expected.includes(key)) || expected.some(key => !answers[key]?.some(value => value.trim()))) fail('모든 질문에 답변하세요.', 400);
    if (input.status === 'answered') {
      if (JSON.stringify(input.answers) === JSON.stringify(answers)) return input;
      fail('이미 답변한 질문입니다.');
    }
    const pending = this.pending.get(inputId);
    if (!pending || input.status !== 'pending') fail('질문이 종료되었습니다. 세션을 이어서 실행하세요.');
    const saved = this.store.patch('inputRequests', inputId, { status: 'answered', answers, answeredAt: now() });
    this.pending.delete(inputId);
    if (!this.store.list('inputRequests').some(item => item.sessionId === input.sessionId && item.status === 'pending')) {
      this.store.patch('sessions', input.sessionId, { status: 'running', progress: '사용자 답변을 받아 작업을 계속합니다.' });
    }
    pending.resolve({ answers: Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, { answers: value }])) });
    return saved;
  }
  cancel(sessionId, message = '실행이 종료되어 질문을 취소했습니다.') {
    for (const item of this.store.list('inputRequests').filter(item => item.sessionId === sessionId && item.status === 'pending')) {
      this.store.patch('inputRequests', item.id, { status: 'cancelled' });
      this.pending.get(item.id)?.reject(new Error(message));
      this.pending.delete(item.id);
    }
  }
  recover() { for (const item of this.store.list('inputRequests').filter(item => item.status === 'pending')) this.cancel(item.sessionId, '서버 재시작으로 질문이 종료되었습니다.'); }
}

export function workerProgress(store, identity, kind, raw) {
  const input = progressUpdateSchema.parse(raw);
  const session = identity.session && store.require('sessions', identity.session.id);
  if (!session || session.kind !== 'work' || !session.taskId || !['running', 'waiting_input'].includes(session.status)) fail('진행 중인 팀원 작업에서만 기록할 수 있습니다.', 403);
  const task = store.require('tasks', session.taskId);
  if (task.sessionId !== session.id || task.assigneeId !== identity.actor) fail('현재 담당 작업만 기록할 수 있습니다.', 403);
  if (input.completedUnits !== undefined && (!task.goalId || !task.plannedUnits || input.completedUnits > task.plannedUnits)) fail('수행 수량은 이 TASK에 배정된 plannedUnits 이하여야 합니다.', 400);
  return store.transaction(() => {
    store.appendHistory({ kind: 'tasks', entityId: task.id, taskId: task.id, sessionId: session.id, memberId: identity.actor, actor: identity.actor,
      event: kind, message: input.message, details: { next: input.next, ...(input.completedUnits !== undefined ? { completedUnits: input.completedUnits } : {}) } });
    return store.patch('tasks', task.id, { lastProgress: input.message, nextStep: input.next,
      ...(input.completedUnits !== undefined ? { completedUnits: input.completedUnits } : {}),
      blocker: kind === 'block' ? input.message : null }, { actor: identity.actor });
  });
}
