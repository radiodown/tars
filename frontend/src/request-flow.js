import { isWorkRequest, sessionRelatesToWork } from '../../shared/work-requests.mjs';
import { workProgress } from '../../shared/work-progress.mjs';

const live = status => ['preparing', 'running', 'waiting_input', 'stopping'].includes(status);
const blockedTask = task => !['done', 'cancelled'].includes(task.status) && (task.status === 'blocked' || Boolean(task.blocker));

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
      const taskIds = new Set(work.map(task => task.id));
      const runs = sessions.filter(session => sessionRelatesToWork(session, request, taskIds))
        .sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || '')));
      const documentIds = new Set(work.flatMap(task => task.documentIds || []));
      const docs = documents.filter(doc => doc.requestId === request.id || documentIds.has(doc.id)
        || (!doc.requestId && runs.some(session => session.id === doc.sessionId)));
      const taskReports = reports.filter(report => taskIds.has(report.taskId));
      const taskReviews = reviews.filter(review => taskIds.has(review.taskId));
      const workflowJobs = jobs.filter(job => job.requestId === request.id || taskIds.has(job.taskId));
      const hasDesign = docs.some(doc => doc.kind === 'agreement') && docs.some(doc => doc.kind === 'specification');
      const running = runs.some(session => live(session.status));
      const active = running || work.some(task => ['queued', 'running'].includes(task.status))
        || workflowJobs.some(job => ['queued', 'running'].includes(job.status));
      const blocked = request.status === 'blocked' || work.some(blockedTask)
        || workflowJobs.some(job => job.status === 'blocked');
      const waiting = ['awaiting_approval', 'awaiting_acceptance'].includes(request.status);
      const complete = request.status === 'accepted' || (!request.approvalRequired && request.status === 'reported');
      const progress = workProgress(request, work);
      const counts = { total: work.length, done: work.filter(task => task.status === 'done' && (!progress.planned || task.acceptedReportId)).length,
        running: work.filter(task => ['running', 'queued'].includes(task.status)).length,
        review: work.filter(task => task.status === 'review').length,
        blocked: work.filter(blockedTask).length };
      const nextTask = work.find(blockedTask)
        || work.find(task => task.status === 'running') || work.find(task => task.status === 'review')
        || work.find(task => ['queued', 'assigned', 'draft'].includes(task.status));
      const nextStep = complete ? '사용자 확인 완료' : request.paused ? '업무 재개 또는 범위 조정'
        : waiting ? request.status === 'awaiting_approval' ? '협의안 확인 및 승인' : '결과 보고 확인'
          : !progress.planned ? '팀장이 측정 목표와 작업 단위를 설정'
            : nextTask ? nextTask.blocker || nextTask.nextStep || nextTask.waitReason || nextTask.error || `${nextTask.title} · ${nextTask.status === 'review' ? '팀장 검토' : '작업 진행'}`
              : progress.unassignedGoals ? '팀장이 남은 목표 수량을 작업으로 배정'
                : progress.complete ? '최종 보고 및 사용자 확인' : '미완료 목표와 차단 사항 확인';
      return { request, tasks: work, sessions: runs, documents: docs, reports: taskReports,
        reviews: taskReviews, jobs: workflowJobs, hasDesign, running, active, blocked, complete, waiting, progress, counts, nextStep };
    });
}
