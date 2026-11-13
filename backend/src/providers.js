import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, readdir, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { DATA } from './store.js';
import { planJsonSchema } from './contracts.js';

export async function executable(provider) {
  const name = process.env[`TARS_${provider.toUpperCase()}_BIN`] || provider;
  const candidates = name.includes('/') ? [name] : (process.env.PATH || '').split(delimiter).map(dir => join(dir, name));
  for (const path of candidates) {
    try { await access(path, constants.X_OK); return path; } catch { /* Try next PATH entry. */ }
  }
  return null;
}

export async function providers() {
  return Promise.all(['codex', 'claude'].map(async name => ({
    name, installed: Boolean(await executable(name)), authentication: 'unchecked',
  })));
}

export async function killOwned(session, signal = 'SIGTERM') {
  if (!session.pid || !session.processToken) return;
  // A group leader may have exited while its command is still alive.
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) !== session.pid || fields[0] === 'Z') continue;
      const environment = await readFile(`/proc/${pid}/environ`);
      if (!environment.toString().split('\0').includes(`TARS_SESSION_TOKEN=${session.processToken}`)) continue;
      process.kill(-session.pid, signal);
      return;
    } catch (error) { if (!['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) throw error; }
  }
}

const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export async function launch({ session, member, cwd, prompt, minutes, onEvent, onSpawn }) {
  const binary = await executable(member.provider);
  if (!binary) throw new Error(`${member.provider} CLI를 찾을 수 없습니다. 설치 및 PATH 설정을 확인하세요.`);
  const directory = join(DATA, 'sessions', session.id);
  await mkdir(directory, { recursive: true });
  const schemaPath = join(directory, 'schema.json');
  if (session.kind === 'plan') await writeFile(schemaPath, JSON.stringify(planJsonSchema));
  const readOnly = session.kind !== 'work';
  let args;
  if (member.provider === 'codex') {
    args = ['--ask-for-approval', 'never', 'exec', '--json', '--skip-git-repo-check', '--sandbox', readOnly ? 'read-only' : 'workspace-write'];
    if (member.model) args.push('--model', member.model);
    if (member.reasoning !== 'default') args.push('-c', `model_reasoning_effort=${JSON.stringify(member.reasoning)}`);
    if (session.kind === 'plan') args.push('--output-schema', schemaPath);
    args.push('-');
  } else {
    const toolset = readOnly ? 'Read,Glob,Grep' : 'Read,Glob,Grep,Edit,Write';
    args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk', '--tools', toolset, '--allowedTools', toolset,
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
    if (member.model) args.push('--model', member.model);
    if (member.reasoning !== 'default') args.push('--effort', member.reasoning);
    if (session.kind === 'plan') args.push('--json-schema', JSON.stringify(planJsonSchema));
  }
  const child = spawn(binary, args, {
    cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TARS_SESSION_TOKEN: session.processToken },
  });
  if (child.pid) {
    try { onSpawn(child.pid); }
    catch (error) { process.kill(-child.pid, 'SIGKILL'); throw error; }
  }
  let buffer = '', stderr = '', output = '', structured = null, providerSessionId = null;
  let usage = null, failure = null, stopped = false, settled = false, totalBytes = 0;
  let killTimer;
  const logPath = join(directory, 'activity.log');
  let logQueue = Promise.resolve();
  function log(message) {
    const line = `${new Date().toISOString()} ${message}\n`;
    logQueue = logQueue.then(() => appendFile(logPath, line)).catch(() => {});
  }
  function notify(message, extra = {}) {
    log(message);
    try { onEvent(message, extra); } catch (error) { failure = error.message; cancel(); }
  }
  function cancel(reason = '사용자가 실행을 중지했습니다.') {
    if (settled) return;
    stopped = true;
    failure ||= reason;
    try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
    if (!killTimer) killTimer = setTimeout(() => {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
    }, 3000);
  }
  function parse(line) {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (!event || typeof event !== 'object') return;
    if (member.provider === 'codex') {
      if (event.type === 'thread.started') providerSessionId = event.thread_id;
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        output = typeof event.item.text === 'string' ? event.item.text : '';
        notify('응답을 작성했습니다.');
      }
      if (event.type === 'item.started' && ['command_execution', 'file_change', 'mcp_tool_call'].includes(event.item?.type)) {
        notify(`작업 중: ${event.item.type}`);
      }
      if (event.type === 'turn.completed') {
        const u = event.usage || {};
        usage = { input: numeric(u.input_tokens), output: numeric(u.output_tokens), cached: numeric(u.cached_input_tokens), costUsd: null, source: 'codex-cli' };
      }
      if (['turn.failed', 'error'].includes(event.type)) failure = String(event.error?.message || event.message || 'Codex 실행 오류');
    } else {
      if (event.type === 'system' && event.session_id) providerSessionId = event.session_id;
      if (event.type === 'assistant') {
        const blocks = Array.isArray(event.message?.content) ? event.message.content.filter(Boolean) : [];
        const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
        if (text) output = text;
        for (const block of blocks.filter(b => b.type === 'tool_use')) notify(`작업 중: ${block.name}`);
      }
      if (event.type === 'result') {
        output = typeof event.result === 'string' ? event.result : output;
        structured = event.structured_output || null;
        providerSessionId = event.session_id || providerSessionId;
        const u = event.usage || {};
        const counts = [u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens];
        usage = { input: numeric(u.input_tokens) === null ? null : counts.reduce((n, value) => n + (numeric(value) || 0), 0),
          output: numeric(u.output_tokens), cached: numeric(u.cache_read_input_tokens), costUsd: numeric(event.total_cost_usd), source: 'claude-cli' };
        if (event.is_error || (typeof event.subtype === 'string' && event.subtype.startsWith('error'))) failure = (Array.isArray(event.errors) ? event.errors.join('\n') : '') || output || 'Claude 실행 오류';
        if (event.permission_denials?.length) failure ||= '도구 권한이 거부되었습니다. 결과와 권한 설정을 확인하세요.';
      }
    }
  }
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const promise = new Promise(resolve => {
    child.on('error', error => { failure = error.message; });
    child.stdout.on('error', error => cancel(error.message));
    child.stderr.on('error', error => cancel(error.message));
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') failure = error.message; });
    child.stdout.on('data', chunk => {
      totalBytes += Buffer.byteLength(chunk);
      if (totalBytes > 8 * 1024 * 1024) { cancel('출력 제한 8 MiB를 초과했습니다.'); return; }
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-6000); });
    child.on('close', async (code, signal) => {
      settled = true;
      clearTimeout(timeout); clearTimeout(killTimer);
      if (buffer.trim()) parse(buffer);
      if (code !== 0 && !failure) failure = stderr.trim() || `CLI 종료: ${code ?? signal}`;
      if (!output && !structured && !failure) failure = 'CLI가 결과를 반환하지 않았습니다.';
      log(failure ? `종료: ${failure}` : '응답 완료');
      await logQueue;
      resolve({ output: output.slice(-80000), structured, usage, providerSessionId, failure, stopped, logPath });
    });
  });
  const timeout = setTimeout(() => cancel(`실행 시간 제한 ${minutes}분을 초과했습니다.`), minutes * 60000);
  child.stdin.end(prompt);
  return { promise, cancel };
}
