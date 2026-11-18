// Full bodies are read on demand; public lists never contain credentials or immutable snapshots.
export function publicRecord(kind, record) {
  if (kind !== 'sessions') return record;
  const { processToken, usage, ...value } = record;
  return value;
}
export function summaryRecord(kind, record) {
  const value = { ...publicRecord(kind, record) };
  if (kind === 'sessions') {
    value.outputPreview = (value.output || '').slice(-240);
    delete value.output; delete value.request; delete value.activity; delete value.diff;
    if (value.interactions) value.interactions = value.interactions.filter(item => item.status === 'pending');
  }
  if (kind === 'documents') { value.preview = (value.content || '').slice(0, 160); delete value.content; delete value.revisions; }
  if (kind === 'workApprovals') { delete value.snapshot; delete value.content; }
  if (kind === 'tasks') delete value.report;
  if (kind === 'workflowJobs') delete value.snapshot;
  if (kind === 'taskReports') { delete value.content; delete value.result; delete value.artifacts; delete value.verification; }
  return value;
}
export function webState(state) {
  return Object.fromEntries(Object.entries(state).map(([kind, records]) => [kind, Array.isArray(records) ? records.map(record => summaryRecord(kind, record)) : records]));
}
