import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA, id } from './store.js';
import { outputSchemaFor } from './contracts.js';
import { createTerminalRecorder } from './terminal.js';
import { appServerTransport } from './app-server-transport.js';
import { inspectLoadedGuidance } from './guidance.js';
import { CODEX_THREAD_ACCESS, CODEX_TURN_ACCESS } from './agent-access.js';
import { createSessionActivity } from './session-activity.js';

export class CodexAppServers {
  constructor(store, killOwned) {
    this.store = store;
    this.killOwned = killOwned;
    this.accounts = new Map();
    this.closing = false;
  }
  async recover() {
    // Runtime ownership is internal, separate from sessions and excluded from /state.
    for (const runtime of this.store.list('appServerProcesses')) {
      await this.killOwned(runtime, 'SIGKILL');
      this.store.patch('appServerProcesses', runtime.id, { pid: null });
    }
  }
  async connection(account, binary) {
    if (this.closing) throw new Error('App Server가 종료 중입니다.');
    let entry = this.accounts.get(account);
    if (entry?.rpc.failed) {
      await entry.rpc.closed;
      if (this.accounts.get(account) === entry) this.accounts.delete(account);
      return this.connection(account, binary);
    }
    if (!entry) {
      const listeners = new Map();
      const processToken = id();
      const rpc = appServerTransport(binary, {
        cwd: DATA, processToken,
        onSpawn: pid => this.store.put('appServerProcesses', { id: account, pid, processToken }),
        onNotification: (method, params) => listeners.get(params.threadId)?.event(method, params),
        onRequest: (method, params, granted) => listeners.get(params.threadId)?.request(method, granted),
        onFailure: error => { for (const listener of listeners.values()) listener.failed(error); },
      });
      entry = { rpc, listeners };
      this.accounts.set(account, entry);
      entry.ready = (async () => {
        try {
          await rpc.call('initialize', { clientInfo: { name: 'tars', title: 'Tars', version: '1.0.0' } });
          rpc.notify('initialized');
        } catch (error) { await rpc.close(error); throw error; }
      })();
    }
    await entry.ready;
    if (this.closing) throw new Error('App Server가 종료 중입니다.');
    return entry;
  }
  launch({ binary, session, member, cwd, prompt, minutes, onEvent, onIdentity }) {
    const account = session.codexAccount || 'codex';
    let entry, threadId, turnId, stopped = false, settled = false, interrupting = false;
    let failure = null, output = '', finalOutput = null, providerTurnStatus = null, terminal;
    let timeout, interruptTimer, progressTimer, pendingProgress;
    let acceptingTurn = false, ownsListener = false, receivedBytes = 0;
    const messages = new Map();
    const activity = createSessionActivity();
    let resolveTurn;
    const finished = new Promise(resolve => { resolveTurn = resolve; });
    const directory = join(DATA, 'sessions', session.id);
    const logPath = join(directory, 'terminal.log');
    function notify(progress, extra = {}) {
      pendingProgress = { progress, extra: { ...pendingProgress?.extra, ...extra } };
      if (!progressTimer) progressTimer = setTimeout(() => {
        progressTimer = null;
        const update = pendingProgress;
        pendingProgress = null;
        try { onEvent(update.progress, update.extra); }
        catch (error) { cancel(error.message); }
      }, 400);
    }
    function rememberTurn(value) {
      if (!value || (turnId && value !== turnId)) return;
      if (!turnId) {
        turnId = value;
        onIdentity({ providerSessionId: threadId, providerTurnId: turnId, status: 'running', progress: 'AI 응답 대기 중' });
      }
      if (stopped) interrupt();
    }
    function interrupt() {
      if (!entry || !turnId || interrupting || settled || providerTurnStatus) return;
      interrupting = true;
      terminal?.write('STOP', failure || '현재 턴 중지를 요청했습니다.');
      // Normal cancellation never kills the shared account process.
      interruptTimer = setTimeout(() => {
        entry.rpc.close(new Error('턴 중지를 확인하지 못했습니다. 같은 계정의 실행 연결을 종료했습니다.'));
      }, 15_000);
      entry.rpc.call('turn/interrupt', { threadId, turnId }, 10_000, { closeOnTimeout: false }).catch(error => {
        if (!providerTurnStatus && !settled) entry.rpc.close(new Error(`턴 중지 실패로 같은 계정의 실행 연결을 종료했습니다: ${error.message}`));
      });
    }
    function cancel(reason = '사용자가 실행을 중지했습니다.') {
      if (settled || providerTurnStatus) return;
      stopped = true;
      failure ||= reason;
      interrupt();
    }
    function event(method, params) {
      if (!acceptingTurn || settled) return;
      const eventTurnId = params.turnId || params.turn?.id;
      if (!eventTurnId || (turnId && eventTurnId !== turnId)) return;
      rememberTurn(eventTurnId);
      terminal.appServerEvent(method, params);
      if (activity.event(method, params)) {
        const snapshot = activity.snapshot();
        notify(snapshot.current || '다음 작업을 준비하고 있습니다.', { activity: snapshot });
      }
      if (method === 'item/agentMessage/delta') {
        const delta = typeof params.delta === 'string' ? params.delta : '';
        receivedBytes += Buffer.byteLength(delta);
        if (receivedBytes > 8 * 1024 * 1024) { cancel('응답 크기 제한 8 MiB를 초과했습니다.'); return; }
        const text = ((messages.get(params.itemId) || '') + delta).slice(-80000);
        messages.set(params.itemId, text);
        output = text;
        notify('응답을 작성하고 있습니다.', { output });
      }
      if (method === 'item/completed' && params.item?.type === 'agentMessage') {
        output = String(params.item.text || '').slice(-80000);
        if (params.item.phase === 'final_answer') finalOutput = output;
        messages.delete(params.item.id);
        notify('응답을 작성했습니다.', { output, ...(params.item.phase === 'commentary' ? { activityNote: output.slice(0, 1000) } : {}) });
      }
      if (method === 'error') {
        const message = String(params.error?.message || 'Codex 실행 오류').slice(0, 2000);
        terminal.write(params.willRetry ? 'RETRY' : 'ERROR', message);
        notify(params.willRetry ? `연결 복구 중: ${message}` : message, { output });
      }
      if (method === 'turn/completed') {
        providerTurnStatus = params.turn.status;
        clearTimeout(interruptTimer);
        if (providerTurnStatus !== 'completed') failure ||= params.turn.error?.message || (providerTurnStatus === 'interrupted' ? 'Codex 턴이 중단되었습니다.' : 'Codex 턴이 실패했습니다.');
        resolveTurn();
      }
    }
    const promise = (async () => {
      try {
        await mkdir(directory, { recursive: true });
        terminal = createTerminalRecorder(directory);
        terminal.write('SESSION', `${member.name} · ${account} · App Server · ${session.model}\n작업 디렉토리: ${cwd}`);
        timeout = setTimeout(() => cancel(`실행 시간 제한 ${minutes}분을 초과했습니다.`), minutes * 60000);
        if (stopped) throw new Error(failure);
        entry = await this.connection(account, binary);
        if (stopped) throw new Error(failure);
        // Refresh discovery before creating/resuming the thread's skill context.
        const listed = await entry.rpc.call('skills/list', { cwds: [cwd], forceReload: true });
        if (stopped) throw new Error(failure);
        const configuration = { cwd, ...CODEX_THREAD_ACCESS, model: member.model || null };
        const previousId = session.resumeThreadId;
        const response = await entry.rpc.call(previousId ? 'thread/resume' : 'thread/start', {
          ...configuration, ...(previousId ? { threadId: previousId, excludeTurns: true } : {}),
        });
        threadId = response?.thread?.id;
        if (!threadId) throw new Error('App Server가 thread ID를 반환하지 않았습니다.');
        if (entry.listeners.has(threadId)) throw new Error('이 Codex 대화는 이미 실행 중입니다.');
        onIdentity({ providerSessionId: threadId, resumed: Boolean(previousId), guidanceStatus: 'checking',
          instructionSources: response.instructionSources || [], progress: '적용 지침과 스킬을 확인하는 중' });
        terminal.write('THREAD', `${previousId ? 'RESUME' : 'NEW'} ${threadId}`);
        if (stopped) throw new Error(failure);
        try {
          const loaded = await inspectLoadedGuidance(session.guidance, response, listed, cwd);
          await writeFile(join(directory, 'guidance.md'), `# ${member.name} · 세션 지침 로딩 결과\n\n작업 경로: ${cwd}\n\nThread: ${threadId}\n\n지침 버전: ${session.guidance.hash}\n\n## 자동 적용 크기\n\n${loaded.instructionBytes} / 32768 bytes (UTF-8 본문과 구분자 기준; 토큰 수 아님)\n\n${loaded.guidanceWarnings.map(warning => `- ${warning}`).join('\n') || '크기·동일 본문 경고 없음'}\n\n## 실제 적용된 지침\n\n${loaded.instructionFiles.map(file => `- ${file.path}: ${file.bytes} bytes${file.duplicateOf ? ` · 중복: ${file.duplicateOf}` : ''}`).join('\n')}\n\n## 발견된 스킬\n\n${loaded.availableSkills.map(skill => `- ${skill.name}: ${skill.path}`).join('\n') || '없음'}\n\n스킬 목록은 발견 여부를 나타내며 실제 사용 여부는 실행 기록에서 확인합니다. 필요할 때 읽는 지침도 실제 원문 열람 여부는 실행 기록에서 확인합니다.\n`);
          onIdentity({ ...loaded, progress: previousId ? '이전 대화를 이어가는 중' : '새 대화를 시작하는 중' });
          terminal.write('GUIDANCE', `적용 지침:\n${loaded.instructionSources.join('\n')}\n발견된 스킬: ${loaded.availableSkills.map(skill => skill.name).join(', ') || '없음'}`);
          terminal.write('GUIDANCE', `자동 적용: ${loaded.instructionBytes} / 32768 bytes${loaded.guidanceWarnings.length ? `\n${loaded.guidanceWarnings.join('\n')}` : ''}`);
        } catch (error) {
          onIdentity({ guidanceStatus: 'failed', guidanceError: error.message });
          throw error;
        }
        if (stopped) throw new Error(failure);
        entry.listeners.set(threadId, {
          event,
          request: (method, granted) => {
            if (granted) { terminal.write('PERMISSION', `최대 권한 정책으로 허용: ${method}`); return; }
            terminal.write('BLOCKED', `지원하지 않는 추가 승인/입력 요청: ${method}`);
            cancel(`추가 승인 또는 입력이 필요하여 중단했습니다: ${method}`);
          },
          failed: error => { failure ||= error.message; resolveTurn(); },
        });
        ownsListener = true;
        acceptingTurn = true;
        const started = await entry.rpc.call('turn/start', {
          threadId, input: [{ type: 'text', text: prompt }], cwd, ...CODEX_TURN_ACCESS,
          model: member.model || null, effort: session.reasoning === 'default' ? null : session.reasoning,
          summary: 'auto',
          ...(outputSchemaFor(session.kind) ? { outputSchema: outputSchemaFor(session.kind) } : {}),
        });
        if (!started?.turn?.id || (turnId && turnId !== started.turn.id)) {
          await entry.rpc.close(new Error('App Server의 turn ID를 확인하지 못해 실행 연결을 종료했습니다.'));
          throw new Error('App Server의 turn ID를 확인하지 못했습니다.');
        }
        rememberTurn(started.turn.id);
        if (!providerTurnStatus && ['completed', 'interrupted', 'failed'].includes(started.turn.status)) event('turn/completed', { threadId, turn: started.turn });
        await finished;
      } catch (error) {
        failure ||= error.message;
        // An error after turn/started must not leave an invisible worker behind.
        if (turnId && !providerTurnStatus && entry && !entry.rpc.failed) {
          cancel(failure);
          await finished;
        }
      } finally {
        settled = true;
        clearTimeout(timeout); clearTimeout(interruptTimer); clearTimeout(progressTimer);
        if (ownsListener) entry.listeners.delete(threadId);
        // Wait for cleanup on connection failure before releasing the member's slot.
        if (entry?.rpc.failed) await entry.rpc.closed;
        output = finalOutput ?? output;
        if (!output && !failure) failure = 'Codex가 결과를 반환하지 않았습니다.';
        activity.finish(stopped || providerTurnStatus === 'interrupted' ? 'interrupted' : failure ? 'failed' : 'completed');
        terminal?.write(failure ? 'ERROR' : 'DONE', failure || '응답 완료');
        await terminal?.flush();
      }
      return { output, structured: null, providerSessionId: threadId, providerTurnId: turnId, providerTurnStatus, failure, stopped, logPath,
        activity: activity.snapshot(), activityNote: pendingProgress?.extra.activityNote };
    })();
    return {
      promise, cancel,
      async steer(prompt) {
        if (stopped || settled || providerTurnStatus || !entry || !turnId) throw Object.assign(new Error('추가 지시를 받을 수 있는 실행 중인 턴이 없습니다.'), { statusCode: 409 });
        await entry.rpc.call('turn/steer', { threadId, expectedTurnId: turnId, input: [{ type: 'text', text: prompt }] });
        terminal.write('USER', prompt);
      },
    };
  }
  async close() {
    this.closing = true;
    await Promise.allSettled([...this.accounts.values()].map(entry => entry.rpc.close()));
    this.accounts.clear();
  }
}
