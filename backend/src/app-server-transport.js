import { spawn } from 'node:child_process';
import { GUIDANCE_CONFIG } from './guidance.js';

// Execution transport: bounded frames and per-request deadlines, no lifetime deadline.
// A lost mutation response is ambiguous; close the owned runtime instead of retrying it.
export function appServerTransport(binary, { cwd, processToken, onSpawn, onNotification, onFailure, onRequest }) {
  // Scope discovery overrides to TARS's execution process; account settings stay intact.
  const overrides = Object.entries(GUIDANCE_CONFIG).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]);
  const child = spawn(binary, [...overrides, 'app-server'], {
    cwd, detached: true, stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, TARS_SESSION_TOKEN: processToken },
  });
  const pending = new Map();
  let nextId = 0, buffer = '', failure = null, closing = false;
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  function close(error = new Error('Codex App Server 연결이 종료되었습니다.')) {
    if (closing) return closed;
    closing = true;
    failure = error;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
    try { onFailure(error); } finally {
      child.stdin.destroy();
      const kill = signal => { try { if (child.pid) process.kill(-child.pid, signal); } catch { /* Already gone. */ } };
      kill('SIGTERM');
      // The leader can exit before its tool processes. Always finish cleaning the group.
      setTimeout(() => { kill('SIGKILL'); resolveClosed(); }, 1000);
    }
    return closed;
  }
  function send(message) {
    if (failure) throw failure;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  child.on('error', error => close(new Error(`Codex App Server 시작 실패: ${error.message}`)));
  child.on('exit', (code, signal) => close(new Error(`Codex App Server 연결 종료 (${code ?? signal}). 자동 재실행하지 않습니다.`)));
  child.stdin.on('error', () => close(new Error('Codex App Server 입력 연결이 끊어졌습니다.')));
  child.stdout.on('error', () => close(new Error('Codex App Server 출력 연결이 끊어졌습니다.')));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    if (closing) return;
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > 8 * 1024 * 1024) { close(new Error('App Server 메시지 크기 제한을 초과했습니다.')); return; }
      try {
        const message = JSON.parse(line);
        if (!message || typeof message !== 'object') throw new Error('잘못된 RPC 메시지');
        if (message.method) {
          if (message.id != null) {
            // Tars never grants new permissions or services authentication requests here.
            const approval = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method);
            send(approval ? { id: message.id, result: { decision: 'decline' } }
              : { id: message.id, error: { code: -32601, message: 'Tars does not support this server request' } });
            onRequest(message.method, message.params || {});
          } else onNotification(message.method, message.params || {});
        } else {
          const request = pending.get(message.id);
          if (!request) continue;
          pending.delete(message.id);
          clearTimeout(request.timer);
          if (message.error) request.reject(new Error(`${request.method}: ${String(message.error.message || 'App Server 요청 실패').slice(0, 2000)}`));
          else request.resolve(message.result);
        }
      } catch (error) { close(new Error(`App Server 이벤트 처리 실패: ${error.message}`)); return; }
      if (closing) return;
    }
    if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) close(new Error('App Server 메시지 크기 제한을 초과했습니다.'));
  });
  try { if (child.pid) onSpawn(child.pid); }
  catch (error) { close(error); }
  return {
    get failed() { return Boolean(failure); },
    closed, close,
    notify(method) { send({ method }); },
    call(method, params, timeoutMs = 30_000, { closeOnTimeout = true } = {}) {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          const error = new Error(`${method} 응답 시간 초과${closeOnTimeout ? '. 상태가 불명확하여 같은 계정의 실행 연결을 종료했습니다.' : '.'}`);
          if (closeOnTimeout) close(error);
          else { pending.delete(id); reject(error); }
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer, method });
        try { send({ id, method, params }); } catch (error) { close(error); }
      });
    },
  };
}
