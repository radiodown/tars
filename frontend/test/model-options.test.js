import test from 'node:test';
import assert from 'node:assert/strict';
import { reasoningOptions, reasoningAfterModelChange } from '../src/model-options.js';

const catalog = { models: [
  { id: 'opus', label: 'Opus 5', resolvedModel: 'claude-opus-5', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'haiku', label: 'Haiku 4.5', resolvedModel: 'claude-haiku-4-5-20251001', reasoningEfforts: [] },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', reasoningEfforts: ['low', 'medium', 'high', 'max'] },
  { id: 'default', label: 'Account default', reasoningEfforts: [] },
] };

test('Claude defaults are separate from depth; real model capabilities drive the slider', () => {
  const opus = reasoningOptions('claude', 'opus', 'default', catalog);
  assert.deepEqual(opus.levels, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(opus.error, null);
  assert.deepEqual(reasoningOptions('claude', 'haiku', 'default', catalog).levels, []);
  assert(reasoningOptions('claude', 'haiku', 'high', catalog).error);
  assert.equal(reasoningOptions('claude', 'claude-opus-5', 'max', catalog).error, null);
  assert(reasoningOptions('claude', 'claude-haiku-4-5-20251001', 'high', catalog).error);
  assert(reasoningOptions('claude', 'claude-sonnet-4-6', 'xhigh', catalog).error);
});

test('model changes retain compatible effort and reset incompatible effort', () => {
  assert.equal(reasoningAfterModelChange('claude', 'opus', 'high', catalog), 'high');
  assert.equal(reasoningAfterModelChange('claude', 'haiku', 'high', catalog), 'default');
  assert.equal(reasoningAfterModelChange('claude', '', 'ultra', catalog), 'default');
  assert.equal(reasoningAfterModelChange('claude', 'claude-sonnet-4-6', 'xhigh', catalog), 'default');
});

test('unresolved models never acquire guessed capabilities or foreign effort levels', () => {
  for (const model of ['', 'custom-deployment']) {
    const options = reasoningOptions('claude', model, 'ultra', catalog);
    assert.equal(options.unknown, true);
    assert(options.error);
    assert(!options.levels.includes('ultra'));
  }
  // Claude's "default" alias is not the absence of --model (saved user model).
  assert(reasoningOptions('claude', 'default', 'high', catalog).error);
  assert.equal(reasoningOptions('claude', '', 'high', catalog).error, null);
});

test('Codex retains model-advertised efforts and custom values when metadata is unavailable', () => {
  assert.deepEqual(reasoningOptions('codex', 'custom', 'ultra').levels, ['default', 'low', 'medium', 'high', 'ultra']);
  const codex = { models: [{ id: 'gpt', label: 'GPT', reasoningEfforts: ['high', 'ultra'] }] };
  assert.deepEqual(reasoningOptions('codex', 'gpt', 'ultra', codex).levels, ['default', 'high', 'ultra']);
  assert(reasoningOptions('codex', 'gpt', 'low', codex).error);
});
