import { z } from 'zod';
import { id, now } from './store.js';
import { fail } from './contracts.js';
import Ajv from 'ajv';

const schemas = new Ajv({ strict: false, validateFormats: false, allErrors: false });

const responseSchema = z.object({
  decision: z.enum(['accept', 'acceptForSession', 'decline', 'cancel']).default('accept'),
  answers: z.record(z.string(), z.array(z.string().trim().min(1).max(16000)).min(1).max(32)).optional(),
  content: z.record(z.string(), z.unknown()).optional(),
}).strict();

// The provider process owns the continuation. SQLite owns the visible request/history.
// A browser reconnect can answer a live request; a server restart cannot replay it.
export class SessionInteractions {
  constructor(store) { this.store = store; this.pending = new Map(); }
  state(sessionId) {
    const session = this.store.require('sessions', sessionId);
    const pending = (session.interactions || []).filter(item => item.status === 'pending');
    return pending.some(item => item.kind === 'question' || item.kind === 'elicitation') ? 'waiting_input'
      : pending.length ? 'waiting_approval' : null;
  }
  patch(sessionId, items) {
    const pending = items.filter(item => item.status === 'pending');
    const interactionState = pending.some(item => ['question', 'elicitation'].includes(item.kind)) ? 'waiting_input' : pending.length ? 'waiting_approval' : null;
    this.store.patch('sessions', sessionId, { interactions: items, interactionState });
  }
  ask(sessionId, request, { signal, onWaiting = () => {} } = {}) {
    if (signal?.aborted) return Promise.reject(new Error('입력 요청이 취소되었습니다.'));
    const session = this.store.require('sessions', sessionId);
    if (!['preparing', 'running', 'waiting_input'].includes(session.status)) return Promise.reject(new Error('종료된 실행에는 입력할 수 없습니다.'));
    const item = { ...request, id: id(), status: 'pending', createdAt: now() };
    if ((session.interactions || []).filter(entry => entry.status === 'pending').length >= 32) return Promise.reject(new Error('동시 입력 요청이 32개를 초과했습니다.'));
    if (Buffer.byteLength(JSON.stringify(item)) > 256 * 1024) return Promise.reject(new Error('입력 요청이 256 KiB를 초과했습니다.'));
    return new Promise((resolve, reject) => {
      const abort = () => this.expire(sessionId, item.id, '입력 요청이 취소되었습니다.');
      const finish = () => { signal?.removeEventListener('abort', abort); onWaiting(false); };
      this.pending.set(item.id, { sessionId, resolve, reject, finish });
      try {
        onWaiting(true);
        this.patch(sessionId, [...(session.interactions || []), item]);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      } catch (error) { this.pending.delete(item.id); finish(); reject(error); }
    });
  }
  respond(sessionId, requestId, raw, actor = 'user') {
    if (actor !== 'user') fail('질문과 실행 승인은 사용자만 응답할 수 있습니다.', 403);
    const response = responseSchema.parse(raw);
    const session = this.store.require('sessions', sessionId);
    const item = session.interactions?.find(entry => entry.id === requestId);
    const pending = this.pending.get(requestId);
    if (!item || !pending || pending.sessionId !== sessionId || item.status !== 'pending' || !['running', 'waiting_input'].includes(session.status)) fail('이미 처리되었거나 종료된 입력 요청입니다.', 409);
    if (!(item.decisions || ['accept', 'decline', 'cancel']).includes(response.decision)) fail('이 요청에서 지원하지 않는 응답입니다.', 400);
    if (response.decision === 'accept' && item.kind === 'question') {
      for (const question of item.questions || []) {
        const answers = response.answers?.[question.id];
        if (!answers?.length || (!question.multiSelect && answers.length !== 1)) fail('모든 질문에 답해주세요.', 400);
      }
    }
    if (response.decision === 'accept' && item.schema) {
      let validate;
      try { validate = schemas.compile(item.schema); }
      catch { fail('지원하지 않는 입력 형식입니다. 요청을 취소해주세요.', 400); }
      const valid = validate(response.content || {});
      schemas.removeSchema(item.schema);
      if (!valid) fail(`입력 항목을 확인하세요: ${schemas.errorsText(validate.errors)}`, 400);
    }
    const saved = { ...response, ...(response.content ? { content: { redacted: '비공개 입력' } } : {}),
      ...(item.questions?.some(q => q.isSecret) ? { answers: { redacted: ['비공개 응답'] } } : {}) };
    this.patch(sessionId, session.interactions.map(entry => entry.id === requestId ? { ...entry, status: 'answered', response: saved, answeredAt: now() } : entry));
    this.pending.delete(requestId);
    pending.finish();
    pending.resolve(response);
    return { ok: true };
  }
  expire(sessionId, requestId, reason = '실행이 종료되어 요청을 닫았습니다.') {
    const pending = this.pending.get(requestId);
    const session = this.store.get('sessions', sessionId);
    if (session) this.patch(sessionId, (session.interactions || []).map(item => item.id === requestId && item.status === 'pending' ? { ...item, status: 'expired', reason } : item));
    if (pending?.sessionId === sessionId) { this.pending.delete(requestId); pending.finish(); pending.reject(new Error(reason)); }
  }
  close(sessionId, reason) {
    for (const item of this.store.get('sessions', sessionId)?.interactions || []) if (item.status === 'pending') this.expire(sessionId, item.id, reason);
  }
}

// Pause only while a blocking user decision is outstanding, including overlapping requests.
export function executionDeadline(milliseconds, onTimeout, isWaiting) {
  let remaining = milliseconds, started = Date.now(), timer, waits = 0, closed = false;
  const arm = () => { started = Date.now(); timer = setTimeout(onTimeout, Math.max(1, remaining)); };
  arm();
  const result = {
    waiting(value) {
      if (closed) return;
      if (value && waits++ === 0) { clearTimeout(timer); remaining -= Date.now() - started; }
      if (!value && waits > 0 && --waits === 0) arm();
    },
    close() { closed = true; clearTimeout(timer); clearInterval(poll); },
  };
  let externalWaiting = false;
  const poll = isWaiting ? setInterval(() => {
    const value = Boolean(isWaiting());
    if (value !== externalWaiting) { externalWaiting = value; result.waiting(value); }
  }, 200) : null;
  return result;
}
