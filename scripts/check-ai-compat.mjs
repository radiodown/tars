// Read-only protocol checks. No prompt, model turn, or user workspace edits.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { executable } from '../backend/src/executables.js';
import { codexConnection } from '../backend/src/codex-rpc.js';

const exec = promisify(execFile);
async function files(path) {
  const entries = await readdir(path, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)]))).flat();
}
const checks = [];
for (const provider of ['codex', 'codex2', 'claude']) {
  const binary = await executable(provider);
  if (!binary) { checks.push({ provider, status: 'not-installed' }); continue; }
  const directory = await mkdtemp(join(tmpdir(), 'tars-ai-compat-'));
  try {
    const { stdout } = await exec(binary, ['--version'], { timeout: 15000 });
    if (provider.startsWith('codex')) {
      await exec(binary, ['app-server', 'generate-json-schema', '--experimental', '--out', directory], { timeout: 30000 });
      const paths = await files(directory);
      for (const name of ['ToolRequestUserInputResponse', 'CommandExecutionRequestApprovalResponse', 'FileChangeRequestApprovalResponse', 'PermissionsRequestApprovalResponse']) {
        if (!paths.some(path => path.endsWith(`/${name}.json`))) throw new Error(`필수 프로토콜 형식 없음: ${name}`);
      }
      const response = paths.find(path => path.endsWith('/ThreadStartResponse.json'));
      if (!response || !JSON.parse(await readFile(response, 'utf8')).properties?.instructionSources) throw new Error('지침 로딩 확인을 위한 instructionSources 없음');
      const connection = codexConnection(binary, new AbortController().signal);
      try {
        await connection.call('initialize', { clientInfo: { name: 'tars-compat', version: '1.0.0' }, capabilities: { experimentalApi: true, requiredHumanApproval: true } });
        connection.initialized();
        const result = await connection.call('model/list', { limit: 100 });
        checks.push({ provider, version: stdout.trim(), status: 'compatible-schema-and-handshake', modelCount: result.data?.length || 0 });
      } finally { connection.close(); }
    } else {
      const abort = new AbortController();
      let release;
      async function* input() { await new Promise(resolve => { release = resolve; }); }
      const run = query({ prompt: input(), options: { cwd: directory, pathToClaudeCodeExecutable: binary, abortController: abort,
        systemPrompt: { type: 'preset', preset: 'claude_code' }, settingSources: ['user', 'project', 'local'] } });
      const timeout = setTimeout(() => abort.abort(), 30000);
      try { const models = await run.supportedModels(); checks.push({ provider, version: stdout.trim(), status: 'compatible-handshake', modelCount: models.length }); }
      finally { clearTimeout(timeout); release?.(); run.close(); }
    }
  } catch (error) { checks.push({ provider, status: 'failed', error: error.message }); process.exitCode = 1; }
  finally { await rm(directory, { recursive: true, force: true }); }
}
console.log(JSON.stringify({ scope: 'schema-and-handshake-only', checks }, null, 2));
