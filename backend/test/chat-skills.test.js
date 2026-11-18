import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatSkills, codexChatInput, normalizeSkills } from '../src/chat-skills.js';
import { skillMentions } from '../../shared/skill-mentions.mjs';

const cwd = '/workspace/project';
const skill = (name, path = `/skills/${name}/SKILL.md`, extra = {}) => ({ name, path, enabled: true, description: `Use ${name}`, ...extra });
const response = skills => ({ data: [{ cwd: '/another-project', skills: [skill('foreign')] }, { cwd, skills, errors: [] }] });

test('skill discovery filters by cwd and enabled state, deduplicates and marks ambiguous names', () => {
  const result = normalizeSkills(response([skill('review'), skill('review'), skill('off', undefined, { enabled: false }),
    skill('duplicate', '/one/SKILL.md'), skill('duplicate', '/two/SKILL.md'), skill('invalid name'),
    skill('plugin:docs', undefined, { interface: { displayName: 'Docs', shortDescription: 'Read docs' }, scope: 'user' }),
  ]), cwd);
  assert.deepEqual(result.skills.map(item => item.name), ['duplicate', 'duplicate', 'plugin:docs', 'review']);
  assert(result.skills.filter(item => item.name === 'duplicate').every(item => item.disabledReason));
  assert.equal(result.skills.find(item => item.name === 'plugin:docs').description, 'Read docs');
  assert.throws(() => normalizeSkills(response([]), '/missing'));
});

test('native skill input uses only current, explicit, enabled mentions and never inherited history', () => {
  const skills = normalizeSkills(response([skill('review'), skill('plugin:docs')]), cwd).skills;
  assert.deepEqual([...skillMentions('$review, ($plugin:docs) $review \n`$ignored`\n```sh\n$ignored\n```')], ['review', 'plugin:docs']);
  const text = 'Past user: $review\nCurrent user: hello';
  assert.deepEqual(codexChatInput(text, 'hello', skills), [{ type: 'text', text }]);
  assert.deepEqual(codexChatInput('full context', 'please $review $review and $unknown', skills), [
    { type: 'text', text: 'full context' }, { type: 'skill', name: 'review', path: '/skills/review/SKILL.md' },
  ]);
  assert.deepEqual(codexChatInput('code', '`$review` \\$review $$review prefix$review', skills), [{ type: 'text', text: 'code' }]);
  assert.throws(() => codexChatInput('$review', '$review', [{ ...skills.find(item => item.name === 'review'), disabledReason: 'ambiguous' }]), /ambiguous/);
});

test('catalog uses the execution account and workspace with metadata RPCs only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tars-chat-skills-'));
  const binary = join(directory, 'codex2');
  const log = join(directory, 'calls.jsonl');
  const previous = process.env.TARS_CODEX2_BIN;
  try {
    await writeFile(binary, `#!${process.execPath}
const fs = require('node:fs');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), ...message }) + '\\n');
  if (!message.id) return;
  if (!['initialize', 'skills/list'].includes(message.method)) process.exit(2);
  const result = message.method === 'skills/list' ? { data: [{ cwd: message.params.cwds[0], skills: [${JSON.stringify(skill('account-two'))}], errors: [] }] } : {};
  process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
});
`, { mode: 0o700 });
    process.env.TARS_CODEX2_BIN = binary;
    const member = { id: 'member', provider: 'codex', codexAccount: 'codex', role: 'member' };
    const session = { id: 'session', memberId: member.id, provider: 'codex', codexAccount: 'codex2', workspace: directory };
    const store = { require: (type, id) => type === 'members' ? member : { ...session, ...(id === 'foreign' ? { memberId: 'other' } : {}) } };
    const result = await chatSkills(store, member.id, { sessionId: session.id });
    assert.equal(result.status, 'ready');
    assert.equal(result.account, 'codex2');
    assert.equal(result.cwd, directory);
    assert.equal(result.skills[0].name, 'account-two');
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls.map(item => item.method), ['initialize', 'initialized', 'skills/list']);
    assert(calls.every(item => item.args.join(' ') === 'app-server'));
    assert.deepEqual(calls.at(-1).params, { cwds: [directory], forceReload: true });
    await assert.rejects(chatSkills(store, member.id, { sessionId: 'foreign' }), /다른 AI/);
  } finally {
    if (previous === undefined) delete process.env.TARS_CODEX2_BIN; else process.env.TARS_CODEX2_BIN = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
