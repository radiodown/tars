import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('API and execution reject incompatible Claude settings while preserving Codex and CLI defaults', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tars-model-settings-'));
  const binary = join(dir, 'claude');
  const trace = join(dir, 'cli.jsonl');
  const models = [
    { value: 'opus', displayName: 'Opus', resolvedModel: 'claude-opus-5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'haiku', displayName: 'Haiku', resolvedModel: 'claude-haiku-4-5-20251001' },
    { value: 'fable', displayName: 'Fable', resolvedModel: 'claude-fable-5-1', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  ];
  await writeFile(binary, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const args=process.argv.slice(2).flatMap(arg => arg.startsWith('--') && arg.includes('=') ? [arg.slice(0,arg.indexOf('=')), arg.slice(arg.indexOf('=')+1)] : [arg]);
appendFileSync(${JSON.stringify(trace)},JSON.stringify(args)+'\\n');
if(args.includes('--input-format')) {
  createInterface({input:process.stdin}).on('line',line=>{
    const request=JSON.parse(line);
    if (request.type === 'user') { console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'fake CLI completed', session_id: 'fake-session' })); return; }
    if(request.type!=='control_request'||request.request.subtype!=='initialize')process.exit(3);
    console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:request.request_id,response:{models:${JSON.stringify(models)}}}}));
  });
} else {
  process.stdin.resume();
  process.stdin.on('end',()=>console.log(JSON.stringify({type:'result',result:'fake CLI completed',session_id:'fake-session'})));
}
`, { mode: 0o700 });
  const socket = createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const env = { ...process.env, TARS_DATA_DIR: dir, TARS_CLAUDE_BIN: binary, TARS_BACKEND_PORT: String(port) };
  const server = spawn(process.execPath, ['backend/src/server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-6000); });
  const base = `http://127.0.0.1:${port}`;
  async function request(path, method = 'GET', body, status = 200) {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    assert.equal(response.status, status, JSON.stringify(data));
    return data;
  }
  try {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      try { ready = (await fetch(base + '/health')).ok; } catch { /* Startup. */ }
      if (ready || server.exitCode !== null) break;
      await delay(100);
    }
    assert(ready, logs);
    const catalog = await request('/api/models/claude');
    assert(catalog.models.some(model => model.id === 'fable'));
    assert.deepEqual(catalog.models.find(model => model.id === 'haiku').reasoningEfforts, []);
    const dep = await request('/api/departments', 'POST', { name: 'test' });
    const member = { name: 'Claude', departmentId: dep.id, role: 'member', provider: 'claude', model: 'opus', reasoning: 'max' };
    const saved = await request('/api/members', 'POST', member);
    assert.equal(saved.reasoning, 'max');
    for (const input of [{ reasoning: 'ultra' }, { model: 'haiku', reasoning: 'high' }, { model: 'claude-haiku-4-5-20251001', reasoning: 'high' }]) {
      await request('/api/members', 'POST', { ...member, ...input }, 400);
    }
    await request(`/api/members/${saved.id}`, 'PATCH', { model: 'haiku' }, 400);
    assert.equal((await request('/api/state')).members.find(item => item.id === saved.id).model, 'opus');
    const codex = await request('/api/members', 'POST', { ...member, provider: 'codex', model: 'custom-gpt', reasoning: 'ultra' });
    await request(`/api/members/${codex.id}`, 'PATCH', { provider: 'claude', model: 'opus' }, 400);
    const ceo = await request('/api/ceo', 'PATCH', { provider: 'claude', model: 'opus', reasoning: 'high' });
    assert.equal(ceo.reasoning, 'high');
    await request('/api/ceo', 'PATCH', { reasoning: 'ultra' }, 400);
    await request('/api/ceo', 'PATCH', { model: 'haiku' }, 400);
    assert.equal((await request('/api/ceo', 'PATCH', { model: 'haiku', reasoning: 'default' })).reasoning, 'default');

    // Old persisted settings bypassing today's API must still be rejected before
    // inference; valid settings must reach the real launch argument builder.
    const runner = spawn(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { launch } from './backend/src/providers.js';
      const base = { cwd: ${JSON.stringify(dir)}, prompt: 'test', minutes: 1, onEvent() {}, onSpawn() {} };
      for (const [model,reasoning] of [['opus','ultra'],['haiku','high']]) {
        await assert.rejects(launch({ ...base, session: {id: 'invalid', provider:'claude'}, member: {provider:'claude',model,reasoning} }));
      }
      for (const reasoning of ['max','default']) {
        const run=await launch({ ...base, session: {id:reasoning,provider:'claude',processToken:'test'}, member: {name:'test',provider:'claude',model:'opus',reasoning} });
        assert.equal((await run.promise).failure,null);
      }
    `], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    for (const stream of [runner.stdout, runner.stderr]) stream.on('data', chunk => { output += chunk; });
    assert.equal((await once(runner, 'exit'))[0], 0, output);
    const calls = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
    const runs = calls.filter(args => args.includes('--permission-mode'));
    assert.equal(runs.length, 2, 'invalid profiles must not launch inference');
    assert.equal(runs[0][runs[0].indexOf('--effort') + 1], 'max');
    assert(!runs[1].includes('--effort'), 'default delegates to CLI settings');
  } finally {
    if (server.exitCode === null && server.signalCode === null) {
      const done = once(server, 'exit');
      server.kill('SIGTERM');
      const timer = setTimeout(() => server.kill('SIGKILL'), 3000);
      await done;
      clearTimeout(timer);
    }
    await rm(dir, { recursive: true, force: true });
  }
});
