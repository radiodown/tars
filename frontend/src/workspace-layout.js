export const LAYOUT_KEY = 'tars:office-layout:v1';
export const createPane = () => ({ id: `cli-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`, type: 'terminal', memberId: '' });
export const defaultLayout = () => ({ id: 'office-root', type: 'split', direction: 'row', ratio: 0.56,
  children: [{ id: 'office-chat', type: 'chat' }, createPane()] });

export function panes(node) {
  return node.type === 'split' ? node.children.flatMap(panes) : [node];
}

export function updateNode(node, id, update) {
  if (node.id === id) return update(node);
  return node.type === 'split' ? { ...node, children: node.children.map(child => updateNode(child, id, update)) } : node;
}

export function splitPane(tree, id, direction, pane = createPane()) {
  return updateNode(tree, id, node => node.type === 'split' ? node : {
    id: `split-${pane.id}`, type: 'split', direction, ratio: 0.5, children: [node, pane],
  });
}

export function closePane(node, id) {
  if (node.type !== 'split') return node;
  const [first, second] = node.children;
  if (first.id === id && first.type === 'terminal') return second;
  if (second.id === id && second.type === 'terminal') return first;
  return { ...node, children: node.children.map(child => closePane(child, id)) };
}

export function swapPanes(tree, firstId, secondId) {
  const leaves = panes(tree);
  const first = leaves.find(node => node.id === firstId);
  const second = leaves.find(node => node.id === secondId);
  if (!first || !second || first === second) return tree;
  const swap = node => node.id === firstId ? second : node.id === secondId ? first : node;
  const visit = node => node.type === 'split' ? { ...node, children: node.children.map(visit) } : swap(node);
  return visit(tree);
}

// Only accept our bounded tree shape; stale or damaged browser storage falls back cleanly.
export function restoreLayout(saved) {
  try {
    const tree = JSON.parse(saved);
    const ids = new Set();
    let chats = 0;
    function valid(node, depth = 0) {
      if (!node || depth > 24 || typeof node.id !== 'string' || !node.id || ids.has(node.id) || ids.size >= 49) return false;
      ids.add(node.id);
      if (node.type === 'chat') { chats++; return true; }
      if (node.type === 'terminal') return typeof node.memberId === 'string' || typeof node.sessionId === 'string';
      return node.type === 'split' && ['row', 'column'].includes(node.direction)
        && Number.isFinite(node.ratio) && node.ratio >= 0.05 && node.ratio <= 0.95
        && Array.isArray(node.children) && node.children.length === 2 && node.children.every(child => valid(child, depth + 1));
    }
    if (valid(tree) && chats === 1) return tree;
  } catch { /* Optional persistence. */ }
  return defaultLayout();
}

export function minimumSize(node, narrow = false) {
  if (node.type !== 'split') return { width: node.type === 'chat' && !narrow ? 360 : 280, height: node.type === 'chat' ? 430 : 320 };
  const [first, second] = node.children.map(child => minimumSize(child, narrow));
  const row = !narrow && node.direction === 'row';
  return { width: row ? first.width + second.width + 7 : Math.max(first.width, second.width),
    height: row ? Math.max(first.height, second.height) : first.height + second.height + 7 };
}
