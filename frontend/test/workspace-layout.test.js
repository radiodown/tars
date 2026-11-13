import test from 'node:test';
import assert from 'node:assert/strict';
import { closePane, defaultLayout, minimumSize, panes, restoreLayout, splitPane, swapPanes, updateNode } from '../src/workspace-layout.js';

test('mixed splits retain selected sessions and collapse cleanly when closed', () => {
  const initial = defaultLayout();
  const terminal = initial.children[1];
  let tree = updateNode(initial, terminal.id, pane => ({ ...pane, sessionId: 'ceo-session' }));
  tree = splitPane(tree, terminal.id, 'column', { id: 'second-cli', type: 'terminal', sessionId: 'worker-session' });
  tree = splitPane(tree, 'second-cli', 'row', { id: 'third-cli', type: 'terminal', sessionId: 'history-session' });
  const restored = restoreLayout(JSON.stringify(tree));
  assert.deepEqual(restored, tree);
  assert.equal(panes(restored).find(pane => pane.id === terminal.id).sessionId, 'ceo-session');
  tree = closePane(restored, 'second-cli');
  assert.deepEqual(panes(tree).map(pane => pane.sessionId).filter(Boolean), ['ceo-session', 'history-session']);
  tree = closePane(closePane(tree, terminal.id), 'third-cli');
  assert.deepEqual(tree, initial.children[0]);
  assert.deepEqual(closePane(initial, initial.children[0].id), initial);
  assert.equal(panes(splitPane(tree, tree.id, 'row')).length, 2);
});

test('moving panes preserves identities, sessions, and split ratios', () => {
  const initial = defaultLayout();
  const terminal = { ...initial.children[1], sessionId: 'selected-session' };
  const tree = { ...initial, children: [initial.children[0], terminal] };
  const swapped = swapPanes(tree, tree.children[0].id, terminal.id);
  assert.equal(swapped.ratio, initial.ratio);
  assert.equal(swapped.children[0], terminal);
  assert.equal(swapped.children[1], initial.children[0]);
  assert.equal(swapPanes(tree, 'missing', terminal.id), tree);
  assert.deepEqual(swapPanes(swapped, tree.children[0].id, terminal.id), tree);
});

test('malformed storage cannot hide chat or create invalid split controls', () => {
  const base = defaultLayout();
  const invalid = [null, '{', 'null', JSON.stringify({ ...base, ratio: null }),
    JSON.stringify({ ...base, ratio: 2 }), JSON.stringify({ ...base, direction: 'diagonal' }),
    JSON.stringify({ ...base, children: [base.children[1], base.children[1]] }),
    JSON.stringify({ ...base, children: [base.children[0], { ...base.children[0], id: 'other-chat' }] }),
    JSON.stringify({ ...base.children[1], sessionId: null })];
  for (const saved of invalid) {
    const tree = restoreLayout(saved);
    assert.equal(panes(tree).filter(pane => pane.type === 'chat').length, 1);
    assert.equal(panes(tree).length, 2);
    assert.equal(tree.ratio, 0.56);
  }
});

test('narrow layouts stack every pane without shrinking content below its minimum', () => {
  const initial = defaultLayout();
  const tree = splitPane(initial, initial.children[1].id, 'column', { id: 'extra', type: 'terminal', sessionId: '' });
  const desktop = minimumSize(tree);
  const narrow = minimumSize(tree, true);
  assert.equal(desktop.width, 360 + 280 + 7);
  assert.equal(desktop.height, 320 * 2 + 7);
  assert.equal(narrow.width, 280);
  assert.equal(narrow.height, 430 + 320 * 2 + 7 * 2);
});
