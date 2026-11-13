import { useWorkspace } from './App';
import { Empty } from './ui';
import { PendingApprovals, WorkApprovals } from './WorkApprovals';
import { pendingApprovals } from './approval-state';
import { WorkflowJobs } from './TaskWorkflow';

export function Inbox() {
  const { data, open } = useWorkspace();
  const waiting = data.tasks.filter(task => task.status === 'blocked' || task.waitReason);
  const jobs = (data.workflowJobs || []).filter(job => job.status === 'blocked');
  const stale = data.requests.filter(request => !request.pendingApprovalId && request.executionBlockReason && !request.paused && request.status !== 'accepted');
  return <div className="page inbox-page"><div className="page-heading"><div><h1>확인할 일</h1><p>협의안·결과 승인과 실행을 막고 있는 사유를 확인하세요.</p></div></div>
    <PendingApprovals />
    {stale.map(request => <section className="panel" key={request.id}><h2>{request.title}</h2><p>{request.executionBlockReason}</p><WorkApprovals requestId={request.id} /></section>)}
    {waiting.length > 0 && <section className="panel"><h2>작업 대기·차단</h2>{waiting.map(task => <div key={task.id}><button className="text-button" onClick={() => open('taskDetail', task)}>{task.title}</button><p>{task.waitReason || task.error || '실행 기록을 확인하세요.'}</p></div>)}</section>}
    {jobs.length > 0 && <section className="panel"><h2>후속 실행 확인</h2><WorkflowJobs jobs={jobs} /></section>}
    {!pendingApprovals(data).length && !waiting.length && !jobs.length && !stale.length && <Empty title="확인할 일이 없습니다" />}
  </div>;
}
