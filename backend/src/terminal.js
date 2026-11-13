import { appendFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA } from './store.js';

const clean = value => String(value ?? '')
  .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
const textBlocks = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(block => block?.type === 'text').map(block => block.text || '').join('\n') : '';

// Only public messages, tool activity, and command output enter the terminal.
// Raw JSON events, reasoning blocks, authentication events, and usage payloads are not copied.
export function createTerminalRecorder(directory) {
  let queue = Promise.resolve(), bytes = 0, capped = false;
  const seen = new Map();
  const file = join(directory, 'terminal.log');
  function write(kind, value) {
    if (capped || !value) return;
    const raw = clean(value);
    const body = raw.length > 12000 ? `${raw.slice(0, 12000)}\n[… 긴 출력 생략]` : raw;
    let line = `${new Date().toISOString()} [${kind}] ${body}\n`;
    if (bytes + Buffer.byteLength(line) > 2 * 1024 * 1024) {
      capped = true;
      line = `${new Date().toISOString()} [SYSTEM] 터미널 기록 한도 2 MiB에 도달했습니다. 이후 출력은 생략합니다.\n`;
    }
    bytes += Buffer.byteLength(line);
    queue = queue.then(() => appendFile(file, line, { mode: 0o600 })).catch(() => {});
  }
  function once(key, kind, value) {
    if (!value || seen.has(key)) return;
    seen.set(key, true);
    write(kind, value);
  }
  function growing(key, kind, value) {
    if (typeof value !== 'string' || !value) return;
    const previous = seen.get(key) || 0;
    if (value.length > previous) write(kind, value.slice(previous));
    seen.set(key, value.length);
  }
  function event(provider, value) {
    if (capped) return;
    if (provider === 'codex') {
      const item = value.item;
      if (!item || !['item.started', 'item.updated', 'item.completed'].includes(value.type)) return;
      const key = item.id || `${item.type}:${item.command || item.text || ''}`;
      if (item.type === 'agent_message') growing(`${key}:text`, 'AI', item.text);
      if (item.type === 'command_execution') {
        once(`${key}:command`, 'COMMAND', `$ ${item.command || '(명령 실행)'}`);
        growing(`${key}:output`, 'OUTPUT', item.aggregated_output);
        if (value.type === 'item.completed') once(`${key}:exit`, 'EXIT', `종료 코드 ${item.exit_code ?? '알 수 없음'} · ${item.status || 'completed'}`);
      }
      if (item.type === 'file_change' && value.type === 'item.completed') {
        const changes = Array.isArray(item.changes) ? item.changes.filter(Boolean) : [];
        once(`${key}:files`, 'FILES', changes.map(change => `${change.kind || 'change'} ${change.path || ''}`).join('\n'));
      }
      if (item.type === 'mcp_tool_call') {
        once(`${key}:tool`, 'TOOL', `${item.server || ''} / ${item.tool || 'MCP'}`);
        if (value.type === 'item.completed') once(`${key}:result`, 'OUTPUT', textBlocks(item.result?.content) || (item.error ? String(item.error.message || item.error) : item.status));
      }
      if (item.type === 'web_search') once(`${key}:search`, 'SEARCH', item.query);
      if (item.type === 'todo_list' && Array.isArray(item.items)) write('PLAN', item.items.filter(Boolean).map(todo => `${todo.completed ? '[x]' : '[ ]'} ${todo.text || ''}`).join('\n'));
    } else {
      const blocks = Array.isArray(value.message?.content) ? value.message.content : [];
      for (const [index, block] of blocks.entries()) {
        if (!block) continue;
        const key = block.id || `${value.message?.id || value.uuid || value.type}:${index}`;
        if (value.type === 'assistant' && block.type === 'text') growing(`${key}:text`, 'AI', block.text);
        if (block.type === 'tool_use') {
          const input = block.input || {};
          const target = input.file_path || input.path || input.pattern || input.command || '';
          once(`${key}:tool`, 'TOOL', `${block.name || 'tool'}${target ? ` · ${String(target).slice(0, 1000)}` : ''}`);
        }
        if (block.type === 'tool_result') once(`${block.tool_use_id || key}:result`, block.is_error ? 'ERROR' : 'OUTPUT', textBlocks(block.content));
      }
      if (value.type === 'result' && value.result) write(value.is_error ? 'ERROR' : 'RESULT', value.result);
    }
  }
  function appServerEvent(method, params) {
    if (capped) return;
    const deltaKind = { 'item/agentMessage/delta': ['text', 'AI'], 'item/commandExecution/outputDelta': ['output', 'OUTPUT'] }[method];
    if (deltaKind && typeof params.delta === 'string') {
      const key = `${params.itemId}:${deltaKind[0]}`;
      seen.set(key, (seen.get(key) || 0) + params.delta.length);
      write(deltaKind[1], params.delta);
      return;
    }
    if (method === 'turn/plan/updated' && Array.isArray(params.plan)) {
      write('PLAN', params.plan.map(step => `${step.status === 'completed' ? '[x]' : '[ ]'} ${step.step || ''}`).join('\n'));
    }
    const item = params.item;
    if (!item || !['item/started', 'item/completed'].includes(method)) return;
    const types = { agentMessage: 'agent_message', commandExecution: 'command_execution', fileChange: 'file_change', mcpToolCall: 'mcp_tool_call', webSearch: 'web_search' };
    if (types[item.type]) event('codex', {
      type: method.replace('/', '.'),
      item: { ...item, type: types[item.type], aggregated_output: item.aggregatedOutput, exit_code: item.exitCode,
        changes: item.changes?.map(change => ({ path: change.path, kind: typeof change.kind === 'string' ? change.kind : change.kind?.type })) },
    });
    if (item.type === 'contextCompaction') once(`${item.id}:compact`, 'CONTEXT', '대화 문맥을 압축하고 있습니다.');
    if (item.type === 'plan' && method === 'item/completed') write('PLAN', item.text);
  }
  return { write, event, appServerEvent, flush: () => queue };
}

export async function readTerminal(session) {
  for (const name of ['terminal.log', 'activity.log']) {
    let file;
    try {
      file = await open(join(DATA, 'sessions', session.id, name), 'r');
      const { size } = await file.stat();
      const limit = 48 * 1024;
      const start = Math.max(0, size - limit);
      const buffer = Buffer.alloc(Math.min(size, limit));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      let content = buffer.subarray(0, bytesRead).toString('utf8');
      if (start > 0) content = content.slice(content.indexOf('\n') + 1);
      return { content: clean(content), truncated: start > 0, legacy: name === 'activity.log' };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    finally { await file?.close(); }
  }
  return { content: '', truncated: false, legacy: false };
}
