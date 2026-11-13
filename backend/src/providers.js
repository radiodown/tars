import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, readdir, mkdir, appendFile } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { DATA } from './store.js';
import { codexAccountSchema, planJsonSchema } from './contracts.js';
import { createTerminalRecorder } from './terminal.js';

export async function executable(provider) {
  const name = process.env[`TARS_${provider.toUpperCase()}_BIN`] || provider;
  const directories = [...(process.env.PATH || '').split(delimiter).filter(Boolean), join(homedir(), '.local', 'bin'), join(homedir(), 'bin')];
  // Preserve wrapper names: codex2 selects its account from argv[0], so do not realpath it.
  const candidates = name.includes('/') ? [name] : [...new Set(directories)].map(dir => join(dir, name));
  for (const path of candidates) {
    try { await access(path, constants.X_OK); return path; } catch { /* Try next PATH entry. */ }
  }
  return null;
}

export async function providers() {
  return Promise.all(['codex', 'claude'].map(async name => {
    const accounts = await Promise.all((name === 'codex' ? ['codex', 'codex2'] : ['claude'])
      .map(async id => ({ id, installed: Boolean(await executable(id)), authentication: 'unchecked' })));
    return { name, installed: accounts.some(account => account.installed), authentication: 'unchecked', accounts };
  }));
}

export function providerCommand(member) {
  return member.provider === 'codex' ? codexAccountSchema.parse(member.codexAccount || 'codex') : member.provider;
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

export async function launch({ session, member, cwd, prompt, minutes, onEvent, onSpawn, onIdentity, codexServers }) {
  const command = providerCommand(session);
  const binary = await executable(command);
  if (!binary) throw new Error(`${command} CLI를 찾을 수 없습니다. 선택한 계정의 실행 명령과 PATH 설정을 확인하세요.`);
  if (session.provider === 'codex') {
    return codexServers.launch({ binary, session, member, cwd, prompt, minutes, onEvent, onIdentity });
  }
  const directory = join(DATA, 'sessions', session.id);
  await mkdir(directory, { recursive: true });
  const terminal = createTerminalRecorder(directory);
  terminal.write('SESSION', `${member.name} · ${command} · ${member.model || 'CLI 기본 모델'}\n작업 디렉토리: ${cwd}`);
  const readOnly = session.kind !== 'work';
  const toolset = readOnly ? 'Read,Glob,Grep' : 'Read,Glob,Grep,Edit,Write';
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk', '--tools', toolset, '--allowedTools', toolset,
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
  if (member.model) args.push('--model', member.model);
  if (member.reasoning !== 'default') args.push('--effort', member.reasoning);
  if (session.kind === 'plan') args.push('--json-schema', JSON.stringify(planJsonSchema));
  const child = spawn(binary, args, {
    cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TARS_SESSION_TOKEN: session.processToken },
  });
  if (child.pid) {
    try { onSpawn(child.pid); }
    catch (error) { process.kill(-child.pid, 'SIGKILL'); throw error; }
  }
  let buffer = '', stderr = '', output = '', structured = null, providerSessionId = null;
  let failure = null, stopped = false, settled = false, totalBytes = 0;
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
    terminal.event(member.provider, event);
    if (event.type === 'system' && event.session_id) providerSessionId = event.session_id;
    if (event.type === 'assistant') {
      const blocks = Array.isArray(event.message?.content) ? event.message.content.filter(Boolean) : [];
      const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
      if (text) { output = text; notify('응답을 작성하고 있습니다.', { output,
        ...(blocks.some(block => block.type === 'tool_use') ? { activityNote: text.slice(0, 1000) } : {}) }); }
      for (const block of blocks.filter(b => b.type === 'tool_use')) notify(`작업 중: ${block.name}`);
    }
    if (event.type === 'result') {
      output = typeof event.result === 'string' ? event.result : output;
      structured = event.structured_output || null;
      providerSessionId = event.session_id || providerSessionId;
      if (event.is_error || (typeof event.subtype === 'string' && event.subtype.startsWith('error'))) failure = (Array.isArray(event.errors) ? event.errors.join('\n') : '') || output || 'Claude 실행 오류';
      if (event.permission_denials?.length) failure ||= '도구 권한이 거부되었습니다. 결과와 권한 설정을 확인하세요.';
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
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-6000); terminal.write('STDERR', chunk.toString()); });
    child.on('close', async (code, signal) => {
      settled = true;
      clearTimeout(timeout); clearTimeout(killTimer);
      if (buffer.trim()) parse(buffer);
      if (code !== 0 && !failure) failure = stderr.trim() || `CLI 종료: ${code ?? signal}`;
      if (!output && !structured && !failure) failure = 'CLI가 결과를 반환하지 않았습니다.';
      log(failure ? `종료: ${failure}` : '응답 완료');
      terminal.write(failure ? 'ERROR' : 'DONE', failure || '응답 완료');
      await logQueue;
      await terminal.flush();
      resolve({ output: output.slice(-80000), structured, providerSessionId, failure, stopped, logPath });
    });
  });
  const timeout = setTimeout(() => cancel(`실행 시간 제한 ${minutes}분을 초과했습니다.`), minutes * 60000);
  child.stdin.end(prompt);
  return { promise, cancel };
}
