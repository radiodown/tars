import { sandboxEnvironment, guardFileWrite, readOnlyCommand } from './claude-sandbox.js';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA } from './store.js';
import { outputSchemaFor } from './contracts.js';
import { claudeAccessArgs, TARS_TOOL_NAMES } from './agent-access.js';
import { createTerminalRecorder } from './terminal.js';
import { executionDeadline } from './session-interactions.js';
import { claudeInteraction, claudeResponse } from './provider-interactions.js';

export async function launchClaude({ binary, session, member, cwd, prompt, minutes, onSpawn = () => {}, onIdentity = () => {}, onEvent = () => {}, onInteraction, isWaiting, query }) {
  // Loading the SDK is unnecessary for API startup, Codex sessions and metadata pages.
  query ||= (await import('@anthropic-ai/claude-agent-sdk')).query;
  const directory = join(DATA, 'sessions', session.id);
  await mkdir(directory, { recursive: true });
  const terminal = createTerminalRecorder(directory);
  const abort = new AbortController();
  const inputAbort = new AbortController();
  const queued = [];
  let wake, nextInput = prompt, ended = false, stopped = false, failure = null, child, run;
  let output = '', structured = null, providerSessionId = session.resumeClaudeId || null;
  let progressTimer, pendingProgress;
  function notify(message, extra = {}) {
    pendingProgress = { message, extra: { ...pendingProgress?.extra, ...extra } };
    if (!progressTimer) progressTimer = setTimeout(() => {
      progressTimer = null;
      const update = pendingProgress; pendingProgress = null;
      try { onEvent(update.message, update.extra); } catch (error) { cancel(error.message); }
    }, 150);
  }
  const deadline = executionDeadline(minutes * 60000, () => cancel(`실행 시간 제한 ${minutes}분을 초과했습니다.`), isWaiting);
  async function* input() {
    while (!ended) {
      if (nextInput == null) await new Promise(resolve => { wake = resolve; });
      if (ended) return;
      const text = nextInput; nextInput = null;
      yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: providerSessionId || '' };
    }
  }
  function cancel(reason = '사용자가 실행을 중지했습니다.') {
    if (ended) return;
    stopped = true; failure ||= reason;
    inputAbort.abort(); abort.abort(); wake?.();
  }
  const args = claudeAccessArgs(session.processToken, session, cwd);
  const settingIndex = args.indexOf('--settings');
  const settings = settingIndex < 0 ? {} : JSON.parse(args[settingIndex + 1]);
  const mcpIndex = args.indexOf('--mcp-config');
  const mcpServers = mcpIndex < 0 ? {} : JSON.parse(args[mcpIndex + 1]).mcpServers;
  const allowedIndex = args.indexOf('--allowedTools');
  const allowedTools = [];
  for (let i = allowedIndex + 1; allowedIndex >= 0 && i < args.length && !args[i].startsWith('--'); i++) allowedTools.push(args[i]);
  const toolNames = args[args.indexOf('--tools') + 1];
  const tools = toolNames === 'default' ? { type: 'preset', preset: 'claude_code' } : [...new Set([...toolNames.split(','), 'AskUserQuestion'])];
  const options = {
    cwd, pathToClaudeCodeExecutable: binary,
    // Keep Claude Code's native prompt, user/project/local settings, skills and login environment.
    systemPrompt: { type: 'preset', preset: 'claude_code' }, settingSources: ['user', 'project', 'local'],
    env: { ...await sandboxEnvironment(), TARS_SESSION_TOKEN: session.processToken }, tools, settings, mcpServers,
    sandbox: { ...settings.sandbox, enabled: true, failIfUnavailable: true },
    hooks: { PreToolUse: [
      { matcher: 'Write|Edit|NotebookEdit', hooks: [input => guardFileWrite(input, session, cwd)] },
      { matcher: 'Bash', hooks: [input => readOnlyCommand(input, session)] },
    ] },
    strictMcpConfig: args.includes('--strict-mcp-config'),
    permissionMode: 'default', allowedTools: session.permissionMode === 'review' ? ['Read', 'Glob', 'Grep', 'mcp__tars__*'] : allowedTools,
    abortController: abort, includePartialMessages: true,
    ...(session.resumeClaudeId ? { resume: session.resumeClaudeId } : {}),
    ...(member.model ? { model: member.model } : {}),
    ...(member.reasoning && member.reasoning !== 'default' ? { effort: member.reasoning } : {}),
    ...(outputSchemaFor(session.kind) ? { outputFormat: { type: 'json_schema', schema: outputSchemaFor(session.kind) } } : {}),
    stderr: text => terminal.write('STDERR', text),
    spawnClaudeCodeProcess(spawnOptions) {
      child = spawn(spawnOptions.command, spawnOptions.args, { cwd: spawnOptions.cwd, env: spawnOptions.env,
        signal: spawnOptions.signal, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', text => terminal.write('STDERR', text));
      if (child.pid) onSpawn(child.pid);
      return child;
    },
    async canUseTool(toolName, toolInput, context) {
      if (!onInteraction) return { behavior: 'deny', message: '사용자 입력 처리기가 연결되지 않았습니다.' };
      try {
        const response = await onInteraction(claudeInteraction(toolName, toolInput, context.suggestions), {
          signal: AbortSignal.any([context.signal, inputAbort.signal]), onWaiting: value => deadline.waiting(value),
        });
        return claudeResponse(toolName, toolInput, response, context.suggestions);
      } catch (error) { return { behavior: 'deny', message: error.message, interrupt: true }; }
    },
    async onElicitation(request, context) {
      if (!onInteraction) return { action: 'cancel' };
      try {
        const response = await onInteraction({ kind: 'elicitation', title: request.title || `${request.serverName} 입력 요청`,
          message: request.message, schema: request.requestedSchema, url: request.url,
          providerRequestId: context.requestId, decisions: ['accept', 'decline', 'cancel'] }, {
          signal: AbortSignal.any([context.signal, inputAbort.signal]), onWaiting: value => deadline.waiting(value),
        });
        return { action: response.decision, ...(response.decision === 'accept' && request.requestedSchema ? { content: response.content || {} } : {}) };
      } catch { return { action: 'cancel' }; }
    },
  };
  terminal.write('SESSION', `${member.name} · Claude Code · ${member.model || '기본 모델'}\n작업 디렉토리: ${cwd}`);
  const promise = (async () => {
    try {
      run = query({ prompt: input(), options });
      onIdentity({ status: 'running', inputMode: 'queued', supportsInput: true, canSteer: true });
      let streamed = '';
      for await (const event of run) {
        if (event.type === 'system' && event.subtype === 'init') {
          const missing = TARS_TOOL_NAMES.filter(name => !(event.tools || []).includes(`mcp__tars__${name}`));
          if (missing.length) throw new Error(`TARS 도구 준비 실패: ${missing.join(', ')}`);
          onIdentity({ toolsReady: true });
        }
        terminal.event('claude', event);
        if (event.session_id && event.session_id !== providerSessionId) { providerSessionId = event.session_id; onIdentity({ providerSessionId }); }
        if (event.type === 'stream_event') {
          if (event.event.type === 'message_start') streamed = '';
          if (event.event.type === 'content_block_delta' && event.event.delta?.type === 'text_delta') {
            streamed = (streamed + event.event.delta.text).slice(-80000);
            output = streamed; notify('응답을 작성하고 있습니다.', { output });
          }
        }
        if (event.type === 'assistant') {
          const blocks = event.message?.content || [];
          const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('\n');
          if (text) { output = text; notify('응답을 작성하고 있습니다.', { output }); }
          for (const block of blocks.filter(block => block.type === 'tool_use')) notify(`작업 중: ${block.name}`);
        }
        if (event.type === 'result') {
          output = typeof event.result === 'string' ? event.result : output;
          structured = event.structured_output || null;
          if (event.is_error || event.subtype?.startsWith('error')) throw new Error(event.errors?.join('\n') || output || 'Claude 실행 오류');
          if (queued.length) { nextInput = queued.shift(); wake?.(); }
          else break;
        }
      }
      if (!output && !structured && !failure) failure = 'Claude가 결과를 반환하지 않았습니다.';
    } catch (error) { failure ||= error.message; }
    finally {
      ended = true; deadline.close(); clearTimeout(progressTimer); inputAbort.abort(); wake?.(); run?.close();
      // Finish the owned process group before releasing the member's execution slot.
      if (child?.pid) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
        await new Promise(resolve => setTimeout(resolve, 1000));
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
      terminal.write(failure ? 'ERROR' : 'DONE', failure || '응답 완료'); await terminal.flush();
    }
    return { output: output.slice(-80000), structured, providerSessionId, failure, stopped, logPath: join(directory, 'terminal.log') };
  })();
  return { promise, cancel, waiting: value => deadline.waiting(value), async steer(text) {
    if (ended || stopped) throw Object.assign(new Error('추가 지시를 받을 실행이 없습니다.'), { statusCode: 409 });
    queued.push(text); terminal.write('USER', `다음 응답에 반영할 추가 지시: ${text}`);
  } };
}
