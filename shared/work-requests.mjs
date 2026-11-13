// Old requests were created for every chat turn. Retain task-backed history,
// but only explicit registration makes a new request a business work item.
export const isWorkRequest = (request, tasks = []) => Boolean(request?.id && (request.registeredAt
  || tasks.some(task => task.requestId === request.id)));

export const sessionBelongsToRequest = (session, requestId) => session.requestId === requestId
  || (session.requestIds || []).includes(requestId);
