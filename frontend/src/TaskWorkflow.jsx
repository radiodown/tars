import { useState } from 'react';
import { Download, History } from 'lucide-react';
import { useWorkspace } from './App';
import { time } from './api';
import { Badge, Field, Markdown } from './ui';
import { WorkApprovals } from './WorkApprovals';
import './work-history.css';

const decisions = { accepted: '검토 통과', rework: '보완 요청', blocked: '판단·해결 필요' };
const stages = { task_review: '팀장 검토', request_report: '담당 관리자 최종 보고', request_escalation: '담당 관리자 차단 보고', user_followup: '사용자 응답 후속 처리' };
const states = { queued: '대기', running: '진행 중', done: '처리 완료', blocked: '차단', cancelled: '중지', superseded: '새 결과로 대체' };

export function WorkflowJobs({ jobs }) {
  const { fire, busy, open } = useWorkspace();
  return <div className="workflow-jobs">{jobs.map(job => <div key={job.id}>
    <span>{stages[job.kind]} · {states[job.status]}</span>
    {job.error && <p className="muted">{job.error}</p>}
    {job.sessionId && <button className="text-button" onClick={() => open('sessionDetail', { id: job.sessionId })}>실행 기록</button>}
    {['blocked', 'cancelled'].includes(job.status) && <button className="text-button" disabled={busy} onClick={() => fire(`/workflow-jobs/${job.id}/retry`, 'POST', {}, '후속 처리를 다시 예약했습니다.')}>다시 요청</button>}
  </div>)}</div>;
}

export function RequestRecord({ requestId }) {
  const { data, open, fire, busy } = useWorkspace();
  const request = (data.requests || []).find(item => item.id === requestId);
  if (!request) return null;
  const tasks = data.tasks.filter(task => task.requestId === requestId);
  const document = data.documents.find(item => item.id === request.reportDocumentId);
  const jobs = (data.workflowJobs || []).filter(job => job.requestId === requestId && !job.taskId && job.status !== 'superseded');
  return <details className="request-record" open={Boolean(request.pendingApprovalId || request.followupJobId)}><summary>{request.title} · {tasks.filter(task => task.status === 'done').length}/{tasks.length} 작업 완료{request.paused ? ' · 자동 보고 중지' : ''}</summary>
    <Markdown>{request.instruction}</Markdown>
    <button className="text-button" disabled={busy} onClick={() => fire(`/requests/${request.id}/${request.paused ? 'resume' : 'stop'}`, 'POST', {}, request.paused ? '대기 중 자동 진행을 재개했습니다.' : '요청의 자동 진행을 중지했습니다.')}>{request.paused ? '대기 중 자동 진행 재개' : '이 업무의 실행·자동 진행 중지'}</button>
    <div className="request-tasks">{tasks.map(task => <button className="text-button" key={task.id} onClick={() => open('taskDetail', task)}>{task.title} <Badge status={task.status} /></button>)}</div>
    <WorkflowJobs jobs={jobs} />
    <WorkApprovals requestId={requestId} />
    {document && <section><h4>{document.title}</h4><Markdown>{document.content}</Markdown></section>}
  </details>;
}

export function RequestList({ tasks }) {
  const ids = [...new Set(tasks.map(task => task.requestId).filter(Boolean))];
  return ids.length ? <section className="request-list"><h2>업무별 결과</h2>{ids.map(id => <RequestRecord key={id} requestId={id} />)}</section> : null;
}

export function TaskResultVersions({ task }) {
  const { data, open, perform, busy } = useWorkspace();
  const [selected, setSelected] = useState('');
  const [decision, setDecision] = useState('accepted');
  const [error, setError] = useState('');
  const reports = (data.taskReports || []).filter(report => report.taskId === task.id).sort((a, b) => b.version - a.version);
  const report = reports.find(item => item.id === selected) || reports.find(item => item.id === task.latestReportId) || reports[0];
  const review = (data.taskReviews || []).find(item => item.reportId === report?.id);
  const name = id => id === 'user' ? '사용자' : data.members.find(member => member.id === id)?.name || '이전 담당자';
  const jobs = (data.workflowJobs || []).filter(job => job.taskId === task.id && job.reportId === task.latestReportId && job.status !== 'superseded');
  async function submit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError('');
    try {
      await perform(`/tasks/${task.id}/reviews`, 'POST', { reportId: report.id, decision,
        rationale: form.get('rationale'), reworkInstructions: decision === 'rework' ? form.get('rationale') : '',
        checks: (report.criteria || [{ id: task.acceptance || '완료 기준 미등록' }]).map(criterion => ({ criterion: criterion.id, status: decision === 'accepted' ? 'passed' : 'not_verified', evidence: form.get('evidence') })), knowledge: [],
      }, '검토 결과를 기록했습니다.');
    } catch (issue) { setError(issue.message); }
  }
  return <section className="work-record task-results">
    <header><h3><History size={16} />작업 결과·검토</h3><a href={`/api/tasks/${task.id}/record`} download><Download size={14} />업무 기록 MD</a></header>
    <RequestRecord requestId={task.requestId} />
    {task.recordError && <p className="form-error">업무 기록 파일 저장 오류: {task.recordError}. 아래 저장된 결과는 유지됩니다.</p>}
    <WorkflowJobs jobs={jobs} />
    <p className="muted">자동 보완 {task.reworkCount || 0} / {data.settings.maxReworkAttempts ?? 2}회</p>
    {task.reworkInstructions && <details><summary>최근 보완 지시</summary><Markdown>{task.reworkInstructions}</Markdown></details>}
    {reports.length > 0 ? <>
      <Field label="결과 버전"><select value={report.id} onChange={event => setSelected(event.target.value)}>{reports.map(item => <option value={item.id} key={item.id}>v{item.version} · {time(item.recordedAt || item.createdAt)}{item.id === task.acceptedReportId ? ' · 채택됨' : ''}{item.legacy ? ' · 이전 기록' : ''}</option>)}</select></Field>
      <p className="muted">작성: {name(report.authorId)} · {report.id === task.acceptedReportId ? '채택된 결과' : '제출된 결과'}{report.sessionId && <> · <button className="text-button" onClick={() => open('sessionDetail', { id: report.sessionId })}>실행 상세</button></>}</p>
      <Markdown>{report.content}</Markdown>
      <div className="task-review-result"><h4>{review ? decisions[review.decision] : '검토 기록 없음'}</h4>
        {review && <><p className="muted">검토: {name(review.authorId)} · {time(review.createdAt)}</p><Markdown>{review.rationale}</Markdown>
          <ul>{review.checks.map((check, index) => <li key={index}><strong>{report.criteria?.find(criterion => criterion.id === check.criterion)?.text || check.criterion} · {check.status === 'passed' ? '확인됨' : check.status === 'failed' ? '실패' : '미검증'}</strong><p>{check.evidence}</p></li>)}</ul>
        </>}
      </div>
      {task.status === 'review' && report.id === task.latestReportId && !report.legacy && !review && <details><summary>직접 검토 결과 남기기</summary>
        <form onSubmit={submit}>
          <Field label="판정"><select value={decision} onChange={event => setDecision(event.target.value)}>{Object.entries(decisions).map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></Field>
          <Field label={decision === 'rework' ? '구체적인 보완 지시' : '판정 이유'}><textarea required name="rationale" maxLength={6000} rows={3} /></Field>
          <Field label="확인한 완료 기준과 검증 근거"><textarea required name="evidence" maxLength={3000} rows={3} /></Field>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="button secondary" disabled={busy}>검토 기록 저장</button>
        </form>
      </details>}
    </> : <p className="muted">결과를 제출하면 버전별 보고와 검토 근거가 여기에 모입니다.</p>}
  </section>;
}
