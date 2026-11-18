import test from 'node:test';
import assert from 'node:assert/strict';
import { chatCommands, completionContext, completionItems, insertCompletion } from '../src/chat-completions.js';

test('slash suggestions only match the first command token, including editing inside it', () => {
  const commands = chatCommands();
  assert(completionItems(completionContext('/', 1), commands).some(item => item.name === '/clear'));
  assert.deepEqual(completionItems(completionContext('/cl', 3), commands).map(item => item.name), ['/clear']);
  const context = completionContext('  /clexx', 5);
  assert.deepEqual(insertCompletion('  /clexx', context, '/clear'), { text: '  /clear ', caret: 9 });
  for (const value of ['hello /cl', '/home/user', 'https://example.com/', '```\n/cl']) assert.equal(completionContext(value, value.length), null);
  assert.equal(completionContext('/clear', 2, 5), null);
});

test('skill completion preserves surrounding prose and replaces the whole current token', () => {
  const value = '먼저 $old-name 그리고 계속';
  const context = completionContext(value, value.indexOf('old') + 2);
  assert.deepEqual(insertCompletion(value, context, '$new-skill'), { text: '먼저 $new-skill 그리고 계속', caret: 13 });
  const catalog = [{ name: 'plugin:review', description: '코드 검토', path: '/skills/review/SKILL.md' }];
  assert.equal(completionItems(completionContext('$rev', 4), [], catalog)[0].name, '$plugin:review');
  for (const value of ['$$var', '\\$var', 'foo$var', '`$var', '```sh\n$var', '~~~sh\n$var']) assert.equal(completionContext(value, value.length), null);
  assert.equal(completionContext('`example` $rev', 14).kind, 'skill');
  assert.equal(insertCompletion('$old trailing', { start: 0, end: 4 }, '$long-name', 10), null);
});

test('suggested commands expose availability and provider support without fictional actions', () => {
  const running = { id: 'active', status: 'running' };
  const commands = chatCommands({ current: running, latest: running, locked: true });
  assert(commands.find(item => item.name === '/clear').disabledReason);
  assert(commands.find(item => item.name === '/model').disabledReason);
  assert.equal(commands.find(item => item.name === '/stop').disabledReason, '');
  assert.equal(commands.find(item => item.name === '/status').disabledReason, '');
  assert.equal(commands.find(item => item.name === '/new').action, 'clear');
  assert(!chatCommands({ provider: 'claude' }).some(item => item.name === '/skills'));
  assert.deepEqual(chatCommands({ terminal: true }).map(item => item.name), ['/stop']);
  assert(!commands.some(item => ['/compact', '/permissions', '/fork'].includes(item.name)));
});
