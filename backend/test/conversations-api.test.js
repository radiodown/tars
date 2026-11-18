import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('session APIs create/select/read without invoking models; chat requires explicit session to resume', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tars-conversations-api-'));
  process.env.TARS_DATA_DIR = directory;
  const { Store } = await import('../src/store.js');
  const { Orchestrator } = await import('../src/orchestrator.js');
  const { registerConversationRoutes } = await import('../src/conversation-routes.js');
  const { ceoChatSchema } = await import('../src/contracts.js');
  const store = new Store();
  const app = Fastify();
  let launches = 0;
  const orchestrator = new Orchestrator(store, { launchRun: async () => { launches++; throw new Error('model should not be called'); } });
  app.addHook('onRequest', async request => { request.identity = { actor: request.headers['x-test-actor'] || 'user' }; });
  app.setErrorHandler((error, request, reply) => reply.code(error.statusCode || (error.name === 'ZodError' ? 400 : 500)).send({ error: error.message }));
  registerConversationRoutes(app, store, orchestrator, async (key, fn) => fn());
  const member = store.put('members', { role: 'ceo', name: 'TARS', provider: 'codex', codexAccount: 'codex', status: 'idle' });
  const request = async (method, url, payload, status = 200, headers = {}) => {
    const result = await app.inject({ method, url: '/api' + url, payload, headers });
    assert.equal(result.statusCode, status, result.body);
    return result.json();
  };
  try {
    const first = await request('POST', `/members/${member.id}/conversations`, { title: '첫 세션' });
    const second = await request('POST', `/members/${member.id}/conversations`, {});
    assert.notEqual(first.id, second.id);
    assert.equal((await request('GET', `/conversations?memberId=${member.id}`)).length, 2);
    assert.equal((await request('POST', `/conversations/${first.id}/resume`, {})).id, first.id);
    assert.equal(store.list('sessions').length, 0);
    assert.equal(launches, 0);
    const run = store.put('sessions', { memberId: member.id, conversationId: first.id, kind: 'ceo_chat', status: 'completed',
      output: 'FULL OUTPUT', processToken: 'SECRET', prompt: 'one' });
    store.put('sessions', { memberId: member.id, conversationId: second.id, prompt: 'OTHER SESSION', status: 'completed' });
    const runs = await request('GET', `/conversations/${first.id}/runs`);
    assert.equal(runs.length, 1); assert.equal(runs[0].id, run.id);
    assert.equal(runs[0].processToken, undefined); assert.equal(runs[0].output, undefined);
    await request('POST', `/members/${member.id}/conversations`, {}, 403, { 'x-test-actor': member.id });
    await request('POST', `/conversations/${first.id}/resume`, {}, 403, { 'x-test-actor': member.id });
    store.patch('members', member.id, { codexAccount: 'codex2' });
    await request('POST', `/conversations/${first.id}/resume`, {}, 409);
    await request('GET', '/conversations/missing', undefined, 404);
    await request('POST', `/members/${member.id}/conversations`, { title: '' }, 400);
    assert.equal(ceoChatSchema.parse({ prompt: 'continue', conversationId: first.id }).conversationId, first.id);
    assert.equal(ceoChatSchema.parse({ prompt: 'continue' }).projectId, undefined);
    assert.equal(launches, 0);
  } finally {
    await orchestrator.shutdown(); await app.close(); store.db.close(); rmSync(directory, { recursive: true, force: true });
  }
});
