// Opt-in live smoke test. Uses CLI credentials and model calls, isolated from operational TARS data.
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
const provider = process.argv[2];
if (!['codex', 'claude'].includes(provider)) throw new Error('Usage: node scripts/verify-review-runtime.mjs codex|claude');
const directory = await mkdtemp(join(tmpdir(), 'tars-review-live-'));
const socket = createServer().listen(0, '127.0.0.1'); await once(socket, 'listening');
const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
process.env.TARS_DATA_DIR = directory;
process.env.TARS_BACKEND_PORT = String(port);
process.env.TARS_AGENT_API_BASE = `http://127.0.0.1:${port}`;
const { Store } = await import('../backend/src/store.js');
const store = new Store();
store.patch('settings', 'main', { maxConcurrent: 2, maxSessionMinutes: 3 });
const department = store.put('departments', { name: '격리 검증팀', projectId: null });
const profile = { provider, model: provider === 'codex' ? 'gpt-6.1-sol' : '', reasoning: provider === 'codex' ? 'low' : 'default', codexAccount: 'codex', status: 'idle', departmentId: department.id, instructions: '', specialty: '격리 검증' };
const leader = store.put('members', { ...profile, name: '검증 팀장', role: 'leader' });
const worker = store.put('members', { ...profile, name: '검증 팀원', role: 'member' });
store.db.close();
const server = spawn(process.execPath, ['backend/src/server.js'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-100000); });
const base = `http://127.0.0.1:${port}`;
async function api(path, method = 'GET', body) {
  const response = await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json(); if (!response.ok) throw new Error(JSON.stringify(value)); return value;
}
let result = { provider, directory, passed: false };
try {
  let ready = false;
  for (let i = 0; i < 200; i++) { try { ready = (await fetch(base + '/health')).ok; } catch {} if (ready || server.exitCode != null) break; await delay(100); }
  if (!ready) throw new Error('Isolated server did not start');
  const prompt = `격리된 기능 검증입니다. 외부 연락·커밋·배포는 하지 마세요. 아래 작은 업무를 TARS 도구로 등록하고 TASK 한 개를 초안으로 만들어 승인을 기다리세요. 최종 답변은 짧게 작성하세요.
업무 목표: 팀원의 작업 폴더에 result.txt를 만들고 내용이 REVIEW_OK인지 확인한다.
업무 완료 기준: result.txt의 내용이 REVIEW_OK이며 팀장이 파일을 읽어서 확인한다.
tars_register_work로 title='리뷰 종단 검증', instruction='result.txt 작성 및 내용 확인', acceptance='result.txt 내용 REVIEW_OK 확인', projectId=null을 등록합니다.
반환된 requestId를 사용해 tars_api POST /api/tasks로 title='검증 파일 작성', description='개인 작업 폴더에 result.txt 내용 REVIEW_OK를 쓰고 읽어서 검증한다. tars_log_progress로 진행 기록을 남긴 뒤 최종 구조화 결과를 제출한다.', acceptance='result.txt 내용 REVIEW_OK 확인', departmentId='${department.id}', assigneeId='${worker.id}', projectId=null, isolation='personal', dependsOn=[], documentIds=[]를 만드세요. 승인 전에 실행하지 마세요. 별도 질문은 필요 없습니다.`;
  await api(`/members/${leader.id}/chat`, 'POST', { prompt });
  const approved = new Set();
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const state = await api('/state');
    for (const session of state.sessions) if (['failed', 'interrupted', 'cancelled'].includes(session.status)) throw new Error(`${session.kind}: ${session.progress}`);
    if (state.inputRequests?.some(item => item.status === 'pending') || state.sessions.some(session => session.interactionState)) throw new Error('Unexpected user input in deterministic smoke scenario');
    for (const approval of state.workApprovals.filter(item => item.status === 'pending')) {
      if (approved.has(approval.id) || state.sessions.find(session => session.id === approval.sourceSessionId)?.status !== 'completed') continue;
      const detail = await api(`/records/workApprovals/${approval.id}`);
      if (approval.kind === 'report' && !detail.snapshot.report.final) throw new Error('Workflow produced a blocked report');
      await api(`/requests/${approval.requestId}/approvals/${approval.id}/respond`, 'POST', { decision: 'approve' }); approved.add(approval.id);
    }
    if (state.requests.some(request => request.status === 'accepted')) {
      const task = state.tasks.find(task => task.status === 'done'); if (!task) throw new Error('No accepted task');
      if ((await readFile(join(task.workspace, 'result.txt'), 'utf8')).trim() !== 'REVIEW_OK') throw new Error('Actual artifact did not match completion criteria');
      const sessions = await Promise.all(state.sessions.map(session => api(`/records/sessions/${session.id}`)));
      if (sessions.some(session => !session.toolsReady)) throw new Error('Tool readiness was not verified');
      result = { ...result, passed: true, taskId: task.id, sessions: sessions.map(session => ({ id: session.id, kind: session.kind, status: session.status, providerSessionId: session.providerSessionId, accessProfile: session.accessProfile, toolsReady: session.toolsReady })) };
      break;
    }
    await delay(1000);
  }
  if (!result.passed) throw new Error('Live workflow deadline exceeded');
} catch (error) { result.error = error.message; process.exitCode = 1; }
finally {
  const exited = once(server, 'exit'); server.kill('SIGTERM'); const kill = setTimeout(() => server.kill('SIGKILL'), 20000); await exited; clearTimeout(kill);
  await writeFile(join(directory, 'verification.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  await writeFile(join(directory, 'server.log'), logs, { mode: 0o600 });
  console.log(JSON.stringify(result));
}
