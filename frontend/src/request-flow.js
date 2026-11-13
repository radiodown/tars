import { isWorkRequest, sessionBelongsToRequest } from '../../shared/work-requests.mjs';

const live = status => ['preparing', 'running', 'stopping'].includes(status);

export function requestFlows(data) {
  const requests = data.requests || [];
  const tasks = data.tasks || [];
  const sessions = data.sessions || [];
  const documents = data.documents || [];
  const reviews = data.taskReviews || [];
  const reports = data.taskReports || [];
  const jobs = data.workflowJobs || [];
  return requests.filter(request => isWorkRequest(request, tasks))
    .sort((a, b) => String(b.registeredAt || b.createdAt || b.updatedAt).localeCompare(String(a.registeredAt || a.createdAt || a.updatedAt)))
    .map(request => {
      const work = tasks.filter(task => task.requestId === request.id);
      const runs = sessions.filter(session => sessionBelongsToRequest(session, request.id)
        || session.id === request.sourceSessionId || work.some(task => task.id === session.taskId))
        .sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || '')));
      const documentIds = new Set(work.flatMap(task => task.documentIds || []));
      const docs = documents.filter(doc => doc.requestId === request.id || documentIds.has(doc.id)
        || (!doc.requestId && runs.some(session => session.id === doc.sessionId)));
      const taskIds = new Set(work.map(task => task.id));
      const taskReports = reports.filter(report => taskIds.has(report.taskId));
      const taskReviews = reviews.filter(review => taskIds.has(review.taskId));
      const workflowJobs = jobs.filter(job => job.requestId === request.id);
      const hasDesign = docs.some(doc => doc.kind === 'agreement') && docs.some(doc => doc.kind === 'specification');
      const active = runs.some(session => live(session.status)) || work.some(task => ['queued', 'running'].includes(task.status))
        || workflowJobs.some(job => ['queued', 'running'].includes(job.status));
      const blocked = request.status === 'blocked' || work.some(task => task.status === 'blocked')
        || workflowJobs.some(job => job.status === 'blocked');
      const waiting = ['awaiting_approval', 'awaiting_acceptance'].includes(request.status);
      const complete = request.status === 'accepted' || (!request.approvalRequired && request.status === 'reported');
      return { request, tasks: work, sessions: runs, documents: docs, reports: taskReports,
        reviews: taskReviews, jobs: workflowJobs, hasDesign, active, blocked, complete, waiting };
    });
}
