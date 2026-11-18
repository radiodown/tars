// Opt-in follow-up to verify-review-runtime.mjs. Pass its isolated data directory.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
const directory = process.argv[2];
if (!directory) throw new Error('Pass an isolated verify-review-runtime fixture directory');
const previous = JSON.parse(await readFile(join(directory, 'verification.json'), 'utf8'));
if (!previous.passed || previous.directory !== directory) throw new Error('Not a successful isolated workflow fixture');
const source = previous.sessions.find(session => session.kind === 'member_chat');
const socket = createServer().listen(0, '127.0.0.1'); await once(socket, 'listening');
const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['backend/src/server.js'], { env: { ...process.env, TARS_DATA_DIR: directory, TARS_BACKEND_PORT: String(port), TARS_AGENT_API_BASE: base }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; for (const stream of [server.stdout, server.stderr]) stream.on('data', data => { logs = (logs + data).slice(-100000); });
async function api(path, body) {
  const response = await fetch(base + '/api' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const value = await response.json(); if (!response.ok) throw new Error(JSON.stringify(value)); return value;
}
let result = { provider: previous.provider, directory, passed: false };
try {
  let ready;
  for (let i = 0; i < 200; i++) { try { ready = (await fetch(base + '/health')).ok; } catch {} if (ready || server.exitCode != null) break; await delay(100); }
  if (!ready) throw new Error('Server startup failed');
  const next = await api(`/sessions/${source.id}/continue`, { prompt: '기능 검증입니다. 이전 대화와 같은 세션인지 확인합니다. 새 업무나 TASK를 만들지 마세요. Bash로 printf READ_ONLY_OK를 한 번 실행한 뒤, 반드시 tars_ask로 "재개 검증 답변을 입력하세요" 질문을 하고 답을 기다리세요. 받은 답변을 최종 응답에 그대로 포함하고 이전 업무 제목을 덧붙이세요. 그 외 변경이나 질문은 하지 마세요.' });
  if (next.processToken) throw new Error('Public continue response exposed execution token');
  let answered = false;
  for (let i = 0; i < 240; i++) {
    const state = await api('/state');
    const session = state.sessions.find(item => item.id === next.id);
    const question = state.inputRequests.find(item => item.sessionId === next.id && item.status === 'pending');
    if (question) {
      if (session.status !== 'waiting_input') throw new Error('Question did not suspend the same session');
      await api(`/input-requests/${question.id}/answer`, { answers: { answer: ['RESUME_ANSWER_OK'] } }); answered = true;
    }
    if (['failed', 'interrupted', 'cancelled'].includes(session.status)) throw new Error(session.progress);
    if (session.status === 'completed') {
      const detail = await api(`/records/sessions/${next.id}`);
      if (!answered || !detail.output.includes('RESUME_ANSWER_OK')) throw new Error('Question answer did not reach model');
      if (detail.providerSessionId !== source.providerSessionId) throw new Error('Continuation opened a different provider session');
      const terminal = await readFile(join(directory, 'sessions', next.id, 'terminal.log'), 'utf8');
      if (!terminal.includes('READ_ONLY_OK') || terminal.includes('Read-only file system')) throw new Error('Read-only shell bookkeeping failed');
      result = { ...result, passed: true, sessionId: next.id, providerSessionId: detail.providerSessionId, answered, toolsReady: detail.toolsReady };
      break;
    }
    await delay(1000);
  }
  if (!result.passed) throw new Error('Continuation deadline exceeded');
} catch (error) { result.error = error.message; process.exitCode = 1; }
finally {
  const exited = once(server, 'exit'); server.kill('SIGTERM'); const timer = setTimeout(() => server.kill('SIGKILL'), 20000); await exited; clearTimeout(timer);
  await writeFile(join(directory, 'continuation-verification.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  await writeFile(join(directory, 'continuation-server.log'), logs, { mode: 0o600 });
  console.log(JSON.stringify(result));
}
