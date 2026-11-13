import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { claudeEfforts } from '../../shared/model-settings.mjs';

// Agent SDK initialization metadata only: no user message or inference request.
// Keep account/model settings, but never run user hooks, tools or MCP servers here.
export function readClaudeModels(binary, signal, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Claude metadata query aborted')); return; }
    const child = spawn(binary, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--setting-sources', 'user', '--settings', '{"disableAllHooks":true}', '--tools', '', '--disable-slash-commands'],
    { cwd: homedir(), stdio: ['pipe', 'pipe', 'ignore'], detached: true });
    let buffer = '', bytes = 0, settled = false;
    const fail = () => finish(new Error('Claude 모델 정보를 조회하지 못했습니다.'));
    const timer = setTimeout(fail, timeoutMs);
    function finish(error, models) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', fail);
      child.stdin.end();
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const kill = name => { try { process.kill(-child.pid, name); } catch { /* Already exited. */ } };
        kill('SIGTERM');
        const killTimer = setTimeout(() => kill('SIGKILL'), 1000);
        killTimer.unref();
        child.once('close', () => clearTimeout(killTimer));
      }
      if (error) reject(error); else resolve(models);
    }
    child.on('error', fail);
    child.on('exit', fail);
    child.stdin.on('error', fail);
    child.stdout.on('error', fail);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024) { fail(); return; }
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event?.type !== 'control_response' || event.response?.request_id !== 'tars-models') continue;
        const response = event.response;
        if (response.subtype !== 'success' || !Array.isArray(response.response?.models)) { fail(); return; }
        // Discard account/auth metadata; expose only the model catalog.
        finish(null, normalizeClaudeModels(response.response.models));
        return;
      }
    });
    signal.addEventListener('abort', fail, { once: true });
    if (signal.aborted) { fail(); return; }
    child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'tars-models', request: { subtype: 'initialize', hooks: {} } })}\n`);
  });
}

export function normalizeClaudeModels(items) {
  const models = new Map();
  const text = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
  // Modern CLI responses omit supportsEffort for unsupported models. Older CLIs
  // without capability metadata remain unknown, rather than inventing support.
  const hasCapabilities = items.some(item => item && typeof item === 'object'
    && ('supportsEffort' in item || 'supportedEffortLevels' in item || typeof item.resolvedModel === 'string'));
  for (const item of items.slice(0, 100)) {
    if (!item || typeof item.value !== 'string' || !item.value.trim() || item.value.length > 100) continue;
    const id = item.value.trim();
    const resolvedModel = text(item.resolvedModel, 100) || null;
    const name = id === 'default' ? '계정 권장 모델' : text(item.displayName, 120) || id;
    const label = resolvedModel ? `${name} · ${resolvedModel}` : name;
    const reasoningEfforts = item.supportsEffort === false ? []
      : Array.isArray(item.supportedEffortLevels) ? claudeEfforts.filter(level => item.supportedEffortLevels.includes(level))
        : hasCapabilities && !item.supportsEffort ? [] : null;
    models.set(id, { id, label, resolvedModel, reasoningEfforts, defaultReasoning: null, disabled: item.disabled === true });
  }
  return [...models.values()];
}
