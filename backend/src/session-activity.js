// Only user-facing summaries and tool activity are retained. Never persist raw reasoning events.
const TEXT_LIMIT = 12000;
const ITEM_LIMIT = 100;
const RECORD_LIMIT = 240000;
const text = (value, limit = TEXT_LIMIT) => typeof value === 'string' ? value.slice(0, limit) : '';
const status = (value, completed) => ({ inProgress: 'running', completed: 'completed', failed: 'failed', declined: 'declined', interrupted: 'interrupted' }[value] || (completed ? 'completed' : 'running'));
const contentText = blocks => Array.isArray(blocks) ? blocks.filter(block => block?.type === 'text').map(block => text(block.text)).join('\n') : '';

export function createSessionActivity(clock = () => new Date().toISOString()) {
  const items = new Map();
  let revision = 0, omitted = 0, diff = '', diffTruncated = false;
  function set(key, values) {
    if (!key) return;
    const previous = items.get(key);
    items.set(key, { id: key, startedAt: clock(), ...previous, ...values });
  }
  function bounded() {
    let size = diff.length;
    const entries = [...items.entries()];
    for (const [, item] of entries) size += JSON.stringify(item).length;
    for (const [key, item] of entries) {
      if (items.size <= ITEM_LIMIT && size <= RECORD_LIMIT) break;
      if (items.size <= 1) break;
      items.delete(key); size -= JSON.stringify(item).length; omitted++;
    }
    revision++;
  }
  function append(key, kind, title, field, delta) {
    if (!key || typeof delta !== 'string') return false;
    const previous = items.get(key);
    const value = (previous?.[field] || '') + delta;
    set(key, { kind, title: previous?.title || title, status: previous?.status || 'running',
      [field]: text(value), truncated: previous?.truncated || value.length > TEXT_LIMIT });
    return true;
  }
  function event(method, params) {
    let changed = false;
    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/summaryPartAdded') {
      const key = params.itemId;
      const index = Number.isInteger(params.summaryIndex) ? params.summaryIndex : 0;
      if (!key || index < 0 || index >= 64) return false;
      const previous = items.get(key);
      const parts = [...(previous?.summaryParts || [])];
      const value = (parts[index] || '') + (method.endsWith('summaryTextDelta') ? text(params.delta) : '');
      parts[index] = text(value, 2000);
      set(key, { kind: 'reasoning', title: '추론 요약', status: previous?.status || 'running', summaryParts: parts,
        text: text(parts.filter(Boolean).join('\n\n')), truncated: previous?.truncated || value.length > 2000 || parts.join('\n\n').length > TEXT_LIMIT });
      changed = true;
    } else if (method === 'item/commandExecution/outputDelta') {
      changed = append(params.itemId, 'command', '명령 실행', 'output', params.delta);
    } else if (method === 'turn/diff/updated' && typeof params.diff === 'string') {
      diff = text(params.diff, 48000); diffTruncated = params.diff.length > 48000; changed = true;
    } else if (method === 'turn/plan/updated' && Array.isArray(params.plan)) {
      const steps = params.plan.slice(0, 60).map(step => ({ text: text(step.step, 1000), status: status(step.status, false) }));
      // Pending steps must not be shown as running.
      params.plan.slice(0, 60).forEach((step, index) => { if (step.status === 'pending') steps[index].status = 'pending'; });
      set('turn-plan', { kind: 'plan', title: '작업 계획', steps, text: text(params.explanation),
        status: steps.length && steps.every(step => step.status === 'completed') ? 'completed' : 'running' });
      changed = true;
    } else if (['item/started', 'item/completed'].includes(method) && params.item?.id) {
      const item = params.item, key = item.id, completed = method === 'item/completed';
      const common = { status: status(item.status, completed), ...(completed ? { endedAt: clock() } : {}) };
      const previous = items.get(key);
      if (item.type === 'reasoning') {
        const summary = Array.isArray(item.summary) ? item.summary.filter(value => typeof value === 'string').join('\n\n') : '';
        set(key, { ...common, kind: 'reasoning', title: '추론 요약', ...(summary ? { text: text(summary), summaryParts: [], truncated: summary.length > TEXT_LIMIT } : {}) });
      } else if (item.type === 'commandExecution') {
        const action = item.commandActions?.find(value => ['read', 'listFiles', 'search'].includes(value.type));
        const title = action?.type === 'read' ? `파일 확인: ${action.path || action.name || ''}`
          : action?.type === 'listFiles' ? `파일 목록: ${action.path || ''}`
            : action?.type === 'search' ? `검색: ${action.query || action.path || ''}` : `명령 실행: ${item.command || ''}`;
        set(key, { ...common, kind: 'command', title: text(title, 240), command: text(item.command), cwd: text(item.cwd, 2000),
          ...(typeof item.aggregatedOutput === 'string' && (item.aggregatedOutput || !previous?.output) ? { output: text(item.aggregatedOutput), truncated: item.aggregatedOutput.length > TEXT_LIMIT } : {}),
          ...(Number.isFinite(item.exitCode) ? { exitCode: item.exitCode, ...(item.exitCode !== 0 && completed ? { status: 'failed' } : {}) } : {}) });
      } else if (item.type === 'fileChange') {
        const changes = (Array.isArray(item.changes) ? item.changes : []).slice(0, 40).map(change => ({
          path: text(change.path, 2000), kind: text(typeof change.kind === 'string' ? change.kind : change.kind?.type, 40),
          diff: text(change.diff, 4000), truncated: typeof change.diff === 'string' && change.diff.length > 4000,
        }));
        set(key, { ...common, kind: 'files', title: text(`파일 수정: ${changes.map(change => change.path).join(', ')}`, 240), changes,
          truncated: (item.changes?.length || 0) > changes.length });
      } else if (['mcpToolCall', 'dynamicToolCall'].includes(item.type)) {
        const result = item.result?.content || item.contentItems;
        const body = contentText(result);
        set(key, { ...common, kind: 'tool', title: text(`도구 호출: ${[item.server, item.tool].filter(Boolean).join(' / ')}`, 240),
          ...(completed ? { output: text(body || item.error?.message), truncated: body.length > TEXT_LIMIT } : {}),
          ...(item.error || item.success === false ? { status: 'failed' } : {}) });
      } else if (item.type === 'webSearch') {
        set(key, { ...common, kind: 'search', title: text(`웹 검색: ${item.query || item.action?.url || ''}`, 240) });
      } else if (item.type === 'contextCompaction') {
        set(key, { ...common, kind: 'context', title: '대화 문맥 압축' });
      } else if (item.type === 'plan' || (item.type === 'agentMessage' && item.phase === 'commentary')) {
        set(key, { ...common, kind: item.type === 'plan' ? 'plan' : 'message', title: item.type === 'plan' ? '작업 계획' : '진행 설명', text: text(item.text), truncated: (item.text?.length || 0) > TEXT_LIMIT });
      } else return false;
      changed = true;
    }
    if (changed) bounded();
    return changed;
  }
  function snapshot() {
    const list = [...items.values()].map(({ summaryParts, ...item }) => item);
    const current = [...list].reverse().find(item => item.status === 'running' && item.kind !== 'plan');
    return { revision, items: list, omitted, diff, diffTruncated,
      current: current ? (current.kind === 'reasoning' ? '추론 중' : current.title) : '' };
  }
  function finish(result) {
    const finalStatus = result === 'completed' ? 'incomplete' : result === 'interrupted' ? 'interrupted' : 'failed';
    for (const [key, item] of items) if (item.status === 'running') set(key, {
      status: finalStatus, endedAt: clock(),
      ...(item.steps ? { steps: item.steps.map(step => step.status === 'running' ? { ...step, status: finalStatus } : step) } : {}),
    });
    bounded();
  }
  return { event, snapshot, finish };
}

export function saveSessionActivity(store, sessionId, activity) {
  store.require('sessions', sessionId);
  store.put('sessionActivities', { ...activity, id: sessionId });
  return { activityCount: activity.items.length + activity.omitted, activityRevision: activity.revision,
    activityAvailable: activity.items.length > 0 || Boolean(activity.diff), currentActivity: activity.current };
}

export function readSessionActivity(store, sessionId) {
  const session = store.require('sessions', sessionId);
  const record = store.get('sessionActivities', sessionId) || { items: [], omitted: 0, diff: '', revision: 0 };
  // Recovery can end a session without receiving another provider event.
  if (!['preparing', 'running', 'waiting_input', 'stopping'].includes(session.status)) {
    const finalStatus = session.status === 'completed' ? 'incomplete' : session.status === 'failed' ? 'failed' : 'interrupted';
    return { ...record, current: '', items: record.items.map(item => item.status === 'running'
      ? { ...item, status: finalStatus, ...(item.steps ? { steps: item.steps.map(step => step.status === 'running' ? { ...step, status: finalStatus } : step) } : {}) } : item) };
  }
  return record;
}
