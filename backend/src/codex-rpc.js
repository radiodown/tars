import { spawn } from 'node:child_process';

// Read-only app-server metadata RPCs: no thread, turn, prompt, or model execution.
// The CLI owns credentials, keyring access, and any normal authentication refresh.
export function codexConnection(binary, signal) {
  const child = spawn(binary, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'], detached: true });
  const pending = new Map();
  let nextId = 0, buffer = '', bytes = 0, failure;
  const fail = () => {
    failure ||= new Error('Codex metadata query unavailable');
    for (const item of pending.values()) item.reject(failure);
    pending.clear();
  };
  const timer = setTimeout(fail, 15_000);
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
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (!message || typeof message !== 'object') continue;
      if (message.method) {
        // Never service auth refresh requests or other server-initiated actions here.
        if (message.id != null) child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'Unsupported request' } })}\n`);
        continue;
      }
      const item = pending.get(message.id);
      if (!item) continue;
      pending.delete(message.id);
      if (message.error) item.reject(new Error('Codex metadata RPC unavailable'));
      else item.resolve(message.result);
    }
  });
  signal.addEventListener('abort', fail, { once: true });
  if (signal.aborted) fail();
  return {
    call(method, params) {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`);
      });
    },
    initialized() { child.stdin.write('{"method":"initialized"}\n'); },
    close() {
      clearTimeout(timer);
      signal.removeEventListener('abort', fail);
      fail();
      child.stdin.end();
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      const kill = signalName => { try { process.kill(-child.pid, signalName); } catch { /* Already exited. */ } };
      kill('SIGTERM');
      const killTimer = setTimeout(() => kill('SIGKILL'), 1000);
      killTimer.unref();
      child.once('close', () => clearTimeout(killTimer));
    },
  };
}
