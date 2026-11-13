import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readClaudeModels, normalizeClaudeModels } from '../src/claude-models.js';

test('CLI metadata supplies versions, disables unsupported effort and retains unavailable rows', () => {
  const models = normalizeClaudeModels([
    { value: 'fable', resolvedModel: 'claude-fable-5-1', displayName: 'Fable', supportsEffort: true, supportedEffortLevels: ['max', 'low', 'ultra', 'low'] },
    { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku' },
    { value: 'disabled', displayName: 'Unavailable', disabled: true, supportsEffort: false },
    null, 'invalid', { value: '' }, { value: 'x'.repeat(101) },
  ]);
  assert.equal(models.length, 3);
  assert.equal(models[0].label, 'Fable · claude-fable-5-1');
  assert.deepEqual(models[0].reasoningEfforts, ['low', 'max']);
  assert.deepEqual(models[1].reasoningEfforts, []);
  assert.equal(models[2].disabled, true);
  assert.equal(normalizeClaudeModels([{ value: 'legacy' }])[0].reasoningEfforts, null);
  assert.deepEqual(normalizeClaudeModels([{ value: 'haiku', resolvedModel: 'claude-haiku-4-5' }])[0].reasoningEfforts, []);
});

test('metadata transport sends initialization only and closes on success, failure and timeout', { timeout: 10000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tars-claude-models-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, 'claude');
  const trace = join(dir, 'requests.jsonl');
  await writeFile(binary, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
appendFileSync(${JSON.stringify(trace)}, JSON.stringify({args:process.argv.slice(2)})+'\\n');
createInterface({ input: process.stdin }).on('line', line => {
  appendFileSync(${JSON.stringify(trace)},line+'\\n');
  const request = JSON.parse(line);
  console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:request.request_id,response:{models:[{value:'opus',resolvedModel:'claude-opus-5',supportsEffort:true,supportedEffortLevels:['low','high','max']}],account:{secret:'must not escape'}}}}));
});
`, { mode: 0o700 });
  const result = await readClaudeModels(binary, new AbortController().signal);
  assert.equal(result[0].resolvedModel, 'claude-opus-5');
  assert(!JSON.stringify(result).includes('secret'));
  const requests = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(requests.length, 2);
  assert(requests[0].args.includes('--no-session-persistence'));
  assert(requests[0].args.includes('--strict-mcp-config'));
  assert(requests[0].args.includes('{"disableAllHooks":true}'));
  assert.equal(requests[1].request.subtype, 'initialize');
  await assert.rejects(readClaudeModels('/missing/claude', new AbortController().signal));
  await assert.rejects(readClaudeModels(binary, AbortSignal.abort()));
  await writeFile(binary, `#!${process.execPath}\nprocess.stdin.resume();\n`, { mode: 0o700 });
  await assert.rejects(readClaudeModels(binary, new AbortController().signal, { timeoutMs: 100 }));
  await writeFile(binary, `#!${process.execPath}\nprocess.stdin.once('data',()=>console.log(JSON.stringify({type:'control_response',response:{request_id:'tars-models',subtype:'success',response:{}}})));\n`, { mode: 0o700 });
  await assert.rejects(readClaudeModels(binary, new AbortController().signal));
});
