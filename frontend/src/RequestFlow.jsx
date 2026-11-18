import { useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ChevronRight, FileText, MessageSquare, Search, Terminal, Trash2 } from 'lucide-react';
import { useWorkspace } from './App';
import { labels, time } from './api';
import { Badge, Dialog, Empty } from './ui';
import { requestFlows } from './request-flow';
import { RequestPolicy } from './RequestPolicy';
import { RecordBody } from './record-details';
import { WorkApprovals } from './WorkApprovals';
import { WorkflowJobs } from './TaskWorkflow';
import { sessionTitle } from './session-list';
import './request-flow.css';
import './record-lists.css';

const titleFor = request => request.title || request.instruction || '제목 없는 업무';
const pageSize = 12;
const priority = flow => flow.waiting ? 0 : flow.blocked || flow.request.paused ? 1 : flow.complete ? 3 : 2;

function WorkStatus({ flow }) {
  const { request, progress } = flow;
  if (flow.complete) return <Badge status={request.status === 'accepted' ? 'accepted' : 'done'} />;
  if (request.paused) return <Badge status="blocked">일시 중지</Badge>;
  if (flow.waiting) return <Badge status={request.status} />;
  if (flow.blocked) return <Badge status="blocked">확인 필요</Badge>;
  if (flow.active) return <Badge status={flow.running ? 'running' : 'queued'} />;
  return <Badge status="planned">{progress.complete ? '최종 보고 대기' : '준비 중'}</Badge>;
}

function ProgressBar({ progress, title }) {
  return <div className="work-progress-track" role="progressbar" aria-label={title + ' 검토된 달성률'}
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}
    aria-valuetext={'검토 완료 ' + progress.percent + '%, 수행 보고 ' + progress.reportedPercent + '%'}>
    <span className="reported" style={{ width: progress.reportedPercent + '%' }} />
    <span className="verified" style={{ width: progress.percent + '%' }} />
  </div>;
}

function WorkOverview({ flow }) {
  const { data, open } = useWorkspace();
  const { request, progress, counts } = flow;
  const guide = data.documents.find(doc => doc.title === '업무 목표·진행률·UI 작성 규칙');
  return <div className="work-overview">
    <div className="work-progress-heading"><strong>{progress.planned ? <>달성률 <b>{progress.percent}%</b></> : '목표 설정 필요'}</strong>
      <span>작업 {counts.done}/{counts.total}건 완료{progress.planned && ` · 수행 보고 ${progress.reportedPercent}%`}</span></div>
    {progress.planned && <>
      <ProgressBar progress={progress} title={titleFor(request)} />
      <h3 className="work-goal-statement">{request.progressPlan.goal}</h3>
      <div className="work-goals" aria-label="달성 목표">{progress.goals.map(goal => <section className="work-goal" key={goal.id}>
        <header><strong>{goal.title}</strong><span>검토 완료 <b>{goal.verified}/{goal.target}{goal.unit}</b></span></header>
        <progress aria-label={goal.title + ' 달성 수량'} value={goal.verified} max={goal.target} />
        <div className="work-goal-counts"><span>수행 보고 {goal.reported}{goal.unit}</span><span>배정 {goal.allocated}{goal.unit}</span>
          <span>비중 {goal.weight}%</span>{goal.unassigned > 0 && <span className="work-unassigned">미배정 {goal.unassigned}{goal.unit}</span>}</div>
        <p><strong>완료 기준</strong> {goal.acceptance}</p>
      </section>)}</div>
    </>}
    <RequestPolicy key={request.id + ':' + request.updatedAt} request={request} />
    {guide && <button type="button" className="text-button work-guide-link" onClick={() => open('document', guide)}><FileText size={14} />목표 작성 규칙</button>}
  </div>;
}

function WorkTasks({ flow, memberName }) {
  const { open } = useWorkspace();
  const goals = new Map(flow.progress.goals.map(goal => [goal.id, goal]));
  return flow.tasks.length ? <ul className="work-detail-list">{flow.tasks.map(task => {
    const goal = goals.get(task.goalId);
    return <li key={task.id}><button type="button" onClick={() => open('taskDetail', task)}>
      <span><strong>{task.title}</strong><small>{memberName(task.assigneeId) || '담당자 미정'}{goal && ` · ${goal.title} · 배정 ${task.plannedUnits}${goal.unit}`}</small></span>
      <Badge status={task.status} /><ChevronRight size={15} aria-hidden="true" />
    </button></li>;
  })}</ul> : <Empty compact title="배정된 작업이 없습니다" />;
}

function WorkRecords({ flow, memberName }) {
  const { data, open } = useWorkspace();
  const [limit, setLimit] = useState(10);
  const { documents, sessions } = flow;
  if (!documents.length && !sessions.length) return <Empty compact title="문서와 실행 기록이 없습니다" />;
  return <div className="work-records">
    {documents.length > 0 && <section><h3><FileText size={15} />문서 <span>{documents.length}</span></h3>
      <ul className="work-detail-list">{documents.slice(0, limit).map(doc => <li key={doc.id}><button type="button" onClick={() => open('document', doc)}>
        <span><strong>{doc.title}</strong><small>v{doc.version} · {time(doc.updatedAt)}</small></span><ChevronRight size={15} aria-hidden="true" />
      </button></li>)}</ul></section>}
    {sessions.length > 0 && <section><h3><Terminal size={15} />실행 <span>{sessions.length}</span></h3>
      <ul className="work-detail-list">{sessions.toReversed().slice(0, limit).map(session => <li key={session.id}>
        <button type="button" onClick={() => open('sessionDetail', session)}>
          <span><strong>{sessionTitle(session, data)}</strong><small>{[memberName(session.memberId), time(session.startedAt)].filter(Boolean).join(' · ')}</small></span>
          <Badge status={session.status} /><ChevronRight size={15} aria-hidden="true" />
        </button>
      </li>)}</ul></section>}
    {Math.max(documents.length, sessions.length) > limit && <button type="button" className="text-button" onClick={() => setLimit(value => value + 10)}>이전 기록 더 보기</button>}
  </div>;
}

function WorkDetail({ flow, memberName, projectName, onDelete, onBack }) {
  const { data, fire, busy } = useWorkspace();
  const [tab, setTab] = useState(flow.waiting ? 'approvals' : 'overview');
  const { request, documents, jobs } = flow;
  const approvals = (data.workApprovals || []).filter(item => item.requestId === request.id);
  const followups = jobs.filter(job => !job.taskId && job.kind !== 'user_followup' && job.status !== 'superseded');
  const report = documents.find(doc => doc.id === request.reportDocumentId);
  const standaloneReport = report && !approvals.some(approval => approval.kind === 'report');
  const summary = request.progressPlan?.summary || request.instruction;
  const tabs = [['overview', '개요·목표'], ['tasks', `작업 ${flow.tasks.length}`], ['approvals', '승인·보고'], ['records', '문서·실행']];
  return <section className="panel work-detail" id="work-detail" aria-label="업무 상세">
    <div className="work-detail-header">
      <button className="text-button work-back" type="button" onClick={onBack}><ArrowLeft size={16} />업무 목록</button>
      <div className="work-detail-top"><span>{[projectName(request.projectId), memberName(request.createdBy)].filter(Boolean).join(' · ')}</span><WorkStatus flow={flow} /></div>
      <h2>{titleFor(request)}</h2>
      {summary && summary !== titleFor(request) && <p className="work-summary">{summary}</p>}
      <div className="work-detail-actions">
        {!flow.complete && (flow.active || request.paused) && <button type="button" className="button secondary" disabled={busy}
          onClick={() => fire(`/requests/${request.id}/${request.paused && !flow.running ? 'resume' : 'stop'}`, 'POST', undefined,
            request.paused && !flow.running ? '업무를 재개했습니다.' : '업무 중지를 요청했습니다.')}>
          {request.paused && !flow.running ? '업무 재개' : '업무 중지'}
        </button>}
        <button type="button" className="button secondary work-delete" disabled={busy} onClick={onDelete}><Trash2 size={15} />업무 삭제</button>
      </div>
    </div>
    {!flow.complete && <p className="work-next-step"><strong>다음</strong><span>{flow.nextStep}</span></p>}
    <div className="work-detail-tabs" role="group" aria-label="업무 상세 보기">{tabs.map(([key, label]) =>
      <button key={key} type="button" aria-pressed={tab === key} onClick={() => setTab(key)}>
        {label}{key === 'approvals' && flow.waiting && <span className="work-pending" aria-label="확인 대기" />}
      </button>)}</div>
    <div className="work-detail-content">
      {tab === 'overview' && <WorkOverview flow={flow} />}
      {tab === 'tasks' && <WorkTasks flow={flow} memberName={memberName} />}
      {tab === 'approvals' && <>
        {request.executionBlockReason && !flow.complete && <p className="muted work-block-reason">{request.executionBlockReason}</p>}
        <WorkApprovals requestId={request.id} />
        {followups.length > 0 && <WorkflowJobs jobs={followups} />}
        {standaloneReport && <section className="request-final-report"><h3>{report.title}</h3><RecordBody kind="documents" record={report} /></section>}
        {!approvals.length && !standaloneReport && !followups.length && <Empty compact title="승인과 보고 기록이 없습니다" />}
      </>}
      {tab === 'records' && <WorkRecords flow={flow} memberName={memberName} />}
    </div>
  </section>;
}

function DeleteWork({ request, running, onClose, onDeleted }) {
  const { perform } = useWorkspace();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  function close() { if (!inFlight.current) onClose(); }
  async function submit(event) {
    event.preventDefault();
    if (inFlight.current || running) return;
    inFlight.current = true;
    setDeleting(true);
    setError('');
    try {
      await perform(`/requests/${request.id}`, 'DELETE', undefined, '업무를 삭제했습니다.');
      onDeleted();
    } catch (issue) {
      setError(issue.message);
      inFlight.current = false;
      setDeleting(false);
    }
  }
  return <Dialog title="업무 삭제" subtitle={titleFor(request)} onClose={close}>
    <form onSubmit={submit}>
      <p className="work-delete-copy">{running ? '연결된 실행이 끝나거나 중지되면 삭제할 수 있습니다.'
        : '업무 목록에서 삭제하고 미완료 작업과 대기 중인 후속 처리를 취소합니다. 저장된 결과와 문서는 보관됩니다.'}</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-footer">
        <button className="button secondary" type="button" disabled={deleting} onClick={close}>취소</button>
        <button className="button secondary work-delete" type="submit" disabled={deleting || running}>{deleting ? '삭제 중' : '삭제'}</button>
      </div>
    </form>
  </Dialog>;
}

export function RequestFlow() {
  const { data } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState(null);
  const [limit, setLimit] = useState(pageSize);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const all = useMemo(() => requestFlows(data).sort((a, b) => priority(a) - priority(b)), [data]);
  const requestId = params.get('request');
  const requested = all.find(flow => flow.request.id === requestId);
  const filterConflicts = requested && ((filter === 'current' && requested.complete) || (filter === 'done' && !requested.complete));
  const status = !filter || filterConflicts ? requested?.complete ? 'done' : 'current' : filter;
  const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const flows = all.filter(flow => {
    if (status === 'done' && !flow.complete || status === 'current' && flow.complete) return false;
    const searchable = [titleFor(flow.request), flow.request.progressPlan?.summary, flow.request.progressPlan?.goal,
      ...flow.tasks.map(task => task.title)].filter(Boolean).join(' ').toLocaleLowerCase();
    return terms.every(term => searchable.includes(term));
  });
  const selected = requestId ? requested : flows[0];
  const completedCount = all.filter(flow => flow.complete).length;
  const memberName = id => id === 'user' ? '사용자' : data.members.find(member => member.id === id)?.name;
  const projectName = id => data.projects.find(project => project.id === id)?.name || '프로젝트 미지정';
  const requestParams = id => {
    const next = new URLSearchParams(params);
    if (id) next.set('request', id);
    else next.delete('request');
    return next;
  };
  function backToList() {
    setFilter(status);
    setParams(requestParams(), { replace: true });
  }
  function changeList(update) {
    update();
    setLimit(pageSize);
    if (requestId) setParams(requestParams(), { replace: true });
  }
  const visible = flows.slice(0, limit);
  if (requested && flows.includes(requested) && !visible.includes(requested)) visible.push(requested);
  const deleteFlow = all.find(flow => flow.request.id === deleteTarget?.id);
  return <div className="page request-flow-page">
    <div className="page-heading"><h1>업무</h1><Link className="button primary" to="/ceo"><MessageSquare size={16} />TARS에게 지시하기</Link></div>
    <div className={'work-layout' + (requestId ? ' showing-detail' : '')}>
      <section className="panel work-list" aria-label="업무 목록">
        <div className="work-list-controls">
          <div className="record-filters" role="group" aria-label="업무 상태">
            {[['current', '미완료', all.length - completedCount], ['done', '완료', completedCount], ['all', '전체', all.length]].map(([key, label, count]) =>
              <button type="button" key={key} aria-pressed={status === key} onClick={() => changeList(() => setFilter(key))}>{label}<span>{count}</span></button>)}
          </div>
          <label className="record-search"><Search size={16} /><input type="search" aria-label="업무와 작업 검색" placeholder="업무 · 목표 · 작업 검색"
            value={search} onChange={event => changeList(() => { setFilter(status); setSearch(event.target.value); })} /></label>
        </div>
        {visible.length ? <ul className="work-list-items">{visible.map(flow => <li key={flow.request.id}>
          <Link to={{ search: requestParams(flow.request.id).toString() }} aria-current={selected?.request.id === flow.request.id ? 'true' : undefined}>
            <strong>{titleFor(flow.request)}</strong>
            <span className="work-list-context">{[projectName(flow.request.projectId), memberName(flow.request.createdBy)].filter(Boolean).join(' · ')}</span>
            <span className="work-list-meta"><WorkStatus flow={flow} /><span>{flow.progress.planned ? `달성 ${flow.progress.percent}%` : `작업 ${flow.counts.done}/${flow.counts.total}건`}</span></span>
            <ChevronRight className="work-row-arrow" size={16} aria-hidden="true" />
          </Link>
        </li>)}</ul> : <Empty compact title={search ? '일치하는 업무가 없습니다' : status === 'done' ? '완료된 업무가 없습니다'
          : status === 'current' ? '미완료 업무가 없습니다' : '등록된 업무가 없습니다'} />}
        {flows.length > limit && <button type="button" className="text-button record-more" onClick={() => setLimit(value => value + pageSize)}>업무 더 보기</button>}
      </section>
      {selected ? <WorkDetail key={selected.request.id} flow={selected} memberName={memberName} projectName={projectName}
        onBack={backToList} onDelete={() => setDeleteTarget(selected.request)} />
        : requestId && <section className="panel work-detail" aria-label="업무 상세">
          <Empty compact title="업무를 찾을 수 없습니다" action={backToList} label="업무 목록으로" />
        </section>}
    </div>
    {deleteTarget && <DeleteWork request={deleteTarget} running={Boolean(deleteFlow?.running)} onClose={() => setDeleteTarget(null)}
      onDeleted={() => { setDeleteTarget(null); if (requestId === deleteTarget.id) backToList(); }} />}
  </div>;
}
