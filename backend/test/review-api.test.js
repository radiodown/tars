import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

test('review HTTP routes: compact state, detail loading, policy, input ownership and log offsets', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tars-review-api-'));
  const socket = createServer().listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const env = { ...process.env, TARS_DATA_DIR: directory, TARS_BACKEND_PORT: String(port) };
  const server = spawn(process.execPath, ['backend/src/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-4000); });
  const base = `http://127.0.0.1:${port}`;
  async function request(path, method = 'GET', body, token, status = 200) {
    const response = await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Tars-Execution-Token': token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
  }
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { try { ready = (await fetch(base + '/health')).ok; } catch {} if (ready || server.exitCode != null) break; await delay(100); }
    assert(ready, logs);
    const document = await request('/documents', 'POST', { title: '상세 문서', kind: 'note', content: 'FULL BODY '.repeat(1000) });
    const list = await request('/state');
    assert.equal(list.documents.find(item => item.id === document.id).content, undefined);
    assert.equal((await request(`/records/documents/${document.id}`)).content, document.content);
    const seed = spawn(process.execPath, ['--input-type=module', '-e', `
      import { Store, now } from './backend/src/store.js';
      import { mkdir, writeFile } from 'node:fs/promises'; import { join } from 'node:path';
      const store = new Store();
      store.put('members', {id:'worker', name:'worker', role:'member', status:'running'});
      store.put('requests', {id:'work', title:'work', instruction:'goal', acceptance:'done', registeredAt:now(), approvalMode:'scope', projectId:null});
      store.put('tasks', {id:'task', title:'task', status:'running', requestId:'work', assigneeId:'worker', sessionId:'run', dependsOn:[]});
      store.put('sessions', {id:'run', memberId:'worker', kind:'work', taskId:'task', requestId:'work', status:'running', processToken:'worker-secret', output:'FULL SESSION BODY'});
      await mkdir(join(process.env.TARS_DATA_DIR,'sessions','run'),{recursive:true});
      await writeFile(join(process.env.TARS_DATA_DIR,'sessions','run','terminal.log'),'abcdefghij'); store.db.close();
    `], { env, stdio: 'ignore' }); assert.equal((await once(seed, 'exit'))[0], 0);
    const sessions = (await request('/state')).sessions;
    assert.equal(sessions[0].output, undefined); assert.equal(sessions[0].processToken, undefined);
    const detail = await request('/records/sessions/run'); assert.equal(detail.output, 'FULL SESSION BODY'); assert.equal(detail.processToken, undefined);
    assert.equal((await request('/sessions/run/terminal?offset=2&limit=4')).content, 'cdef');
    const streamAbort = new AbortController();
    const stream = await fetch(base + '/api/sessions/run/terminal/stream?offset=5', { signal: streamAbort.signal });
    const chunk = await stream.body.getReader().read(); assert(new TextDecoder().decode(chunk.value).includes('fghij')); streamAbort.abort();
    await request('/requests/work', 'PATCH', { acceptance: 'changed' }, 'worker-secret', 403);
    const progress = await request('/execution/progress', 'POST', { message: 'saved', next: 'next' }, 'worker-secret'); assert.equal(progress.lastProgress, 'saved');
    await request('/input-requests/missing/answer', 'POST', { answers: {} }, 'worker-secret', 403);
    await request('/sessions/run/handoff', 'POST', { locked: true }, undefined, 409);
    await request('/records/appServerProcesses/anything', 'GET', undefined, undefined, 400);
  } finally {
    const exit = once(server, 'exit'); server.kill('SIGTERM'); const kill = setTimeout(() => server.kill('SIGKILL'), 5000);
    await exit; clearTimeout(kill); await rm(directory, { recursive: true, force: true });
  }
});
