import { z } from 'zod';

// Explicit fields keep logs, prompts, approval snapshots and credentials out of lists.
const fields = {
  departments: ['name', 'projectId'],
  members: ['name', 'role', 'departmentId', 'provider', 'codexAccount', 'model', 'reasoning', 'status', 'currentSessionId'],
  projects: ['name', 'path'],
  requests: ['title', 'projectId', 'departmentId', 'createdBy', 'status', 'paused', 'pendingApprovalId'],
  tasks: ['title', 'requestId', 'departmentId', 'projectId', 'assigneeId', 'status', 'error'],
  documents: ['title', 'kind', 'version', 'requestId', 'departmentId', 'projectId'],
  sessions: ['memberId', 'taskId', 'requestId', 'projectId', 'kind', 'status', 'progress', 'startedAt', 'endedAt'],
  workApprovals: ['requestId', 'memberId', 'kind', 'version', 'status', 'sourceSessionId'],
  workflowJobs: ['requestId', 'taskId', 'memberId', 'kind', 'status', 'error'],
};
export const agentStateSchema = z.object({
  collection: z.enum(Object.keys(fields)).optional(),
  id: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
}).strict().refine(value => !value.id || value.collection, { message: 'id 조회에는 collection이 필요합니다.' });
export const agentStateQuerySchema = z.preprocess(value => ({ ...value,
  ...(value.limit === undefined ? {} : { limit: Number(value.limit) }),
  ...(value.offset === undefined ? {} : { offset: Number(value.offset) }),
}), agentStateSchema);

export function agentState(store, input = {}) {
  const { collection, id, limit, offset } = agentStateSchema.parse(input);
  if (id) {
    const { processToken, usage, ...item } = store.require(collection, id);
    return { collection, item };
  }
  const totals = {}, result = {};
  for (const kind of collection ? [collection] : Object.keys(fields)) {
    const records = store.list(kind);
    totals[kind] = records.length;
    result[kind] = records.slice(offset, offset + limit).map(record => Object.fromEntries(
      ['id', 'updatedAt', ...fields[kind]].filter(key => record[key] !== undefined)
        .map(key => [key, typeof record[key] === 'string' ? record[key].slice(0, 500) : record[key]])));
  }
  return { ...result, totals, limit, offset, detail: 'Use collection + id to read one complete record.' };
}

export function agentStateFromState(state, input) {
  return agentState({
    list: kind => state[kind] || [],
    require: (kind, id) => {
      const item = (state[kind] || []).find(record => record.id === id);
      if (!item) throw new Error('항목을 찾을 수 없습니다.');
      return item;
    },
  }, input);
}
