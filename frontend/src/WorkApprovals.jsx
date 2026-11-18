import { useRecord } from './record-details';
import { useId, useState } from 'react';
import { Check, MessageSquare, History, Search } from 'lucide-react';
import { useWorkspace } from './App';
import { isLive, time } from './api';
import { Badge, Empty, Markdown } from './ui';
import './work-approvals.css';
import './record-lists.css';
import { approvalChanges, approvalSummaries, pendingApprovals } from './approval-state';

const states = { pending: '사용자 확인 대기', approved: '승인됨', feedback: '의견 전달됨', superseded: '새 버전으로 대체' };
const jobStates = { queued: '담당 AI 실행 대기', running: '담당 AI가 이어서 처리 중', done: '후속 응답 완료', blocked: '후속 실행 실패', cancelled: '후속 실행 중지', superseded: '새 응답으로 대체' };

export function Approval({ item: summary, current, comment, onCommentChange }) {
  const detail = useRecord('workApprovals', summary);
  const item = detail.record;
  const { data, perform, open, busy } = useWorkspace();
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const commentId = useId();
  const source = data.sessions.find(session => session.id === item.sourceSessionId);
  const previous = (data.workApprovals || []).filter(other => other.requestId === item.requestId && other.kind === item.kind && other.version < item.version)
    .sort((a, b) => b.version - a.version)[0];
  const previousDetail = useRecord('workApprovals', previous);
  const changes = approvalChanges(previousDetail.record?.snapshot, item.snapshot);
  const job = (data.workflowJobs || []).find(job => job.id === item.followupJobId);
  const name = id => data.members.find(member => member.id === id)?.name || '이전 담당자';
  const canRespond = current && item.status === 'pending' && source?.status === 'completed';
  const canGiveFeedback = current && item.status === 'pending' && source && !isLive(source.status);
  async function respond(event) {
    event.preventDefault();
    if (sending) return;
    const decision = event.nativeEvent.submitter?.value || 'feedback';
    if (['feedback', 'rescope'].includes(decision) && !comment.trim()) { setError('추가 의견을 입력하세요.'); return; }
    setError(''); setSending(true);
    try {
      await perform(`/requests/${item.requestId}/approvals/${item.id}/respond`, 'POST', { decision, comment },
        decision === 'approve' ? '승인을 기록했습니다. 준비된 작업은 자동 진행합니다.' : '의견을 저장하고 담당 AI의 후속 실행을 예약했습니다.');
      onCommentChange('');
    } catch (issue) { setError(issue.message); }
    finally { setSending(false); }
  }
  if (!item.snapshot) return <div className="approval-loading" role={detail.isError ? 'alert' : 'status'}><p>{detail.isError ? detail.error.message : '승인 내용을 불러오는 중…'}</p>{detail.isError && <button type="button" className="text-button" onClick={() => detail.refetch()}>다시 불러오기</button>}</div>;
  return <article className={`work-approval ${item.status}`}>
    <header><strong>{item.kind === 'plan' ? '협의안' : '결과 보고'} v{item.version} · {item.status === 'pending' && !current ? '이전 확인 요청' : states[item.status]}</strong><small>{name(item.memberId)} · {time(item.createdAt)}</small></header>
    <div className="work-approval-body">
      {item.restored && <p className="muted">이 기능을 적용하기 전에 저장된 기록입니다. 아래 내용을 확인하고 승인하거나 의견을 남겨주세요.</p>}
      <button type="button" className="text-button" onClick={() => open('sessionDetail', { id: item.sourceSessionId })}>작성한 AI 실행 보기</button>
      <h4>{item.snapshot.title}</h4>
      {previous && <section aria-label="이전 버전과의 차이"><strong>v{previous.version} 이후 변경</strong>{!previousDetail.record?.snapshot ? <p className="muted">{previousDetail.isError ? '이전 버전의 내용을 불러오지 못했습니다.' : '이전 버전과 비교하는 중…'}</p> : changes.length ? <ul>{changes.map((change, index) => <li key={index}>{change}</li>)}</ul> : <p className="muted">목표·문서·TASK 변경 없음</p>}</section>}
      <Markdown>{item.content}</Markdown>
      {item.snapshot.progressPlan && <section className="approval-goals"><h4>승인할 달성 목표</h4><p>{item.snapshot.progressPlan.goal}</p>
        <ul>{item.snapshot.progressPlan.goals.map(goal => <li key={goal.id}><strong>{goal.title} · {goal.target}{goal.unit} · 비중 {goal.weight}%</strong><p>{goal.acceptance}</p></li>)}</ul>
      </section>}
      {item.kind === 'plan' && <>
        <details><summary>목표와 작업 범위</summary><Markdown>{item.snapshot.instruction}</Markdown><h4>업무 완료 기준</h4><Markdown>{item.snapshot.acceptance || '문서에 기록된 완료 기준'}</Markdown><p>{item.snapshot.approvalMode === 'scope' ? '목표·범위 승인: 범위 안의 TASK 작성·배정은 자동 진행' : 'TASK 목록까지 승인'}</p></details>
        {item.snapshot.documents.map(doc => <details key={doc.id}><summary>{doc.title} · v{doc.version}</summary><Markdown>{doc.content}</Markdown></details>)}
        {item.snapshot.tasks.length > 0 && <div className="approval-task-scope"><h4>승인 대상 작업 · {item.snapshot.tasks.length}건</h4>{item.snapshot.tasks.map(task => <details key={task.id}><summary>{task.title} · {name(task.assigneeId)}</summary><Markdown>{`${task.description || ''}\n\n완료 기준:\n${task.acceptance || '미등록'}`}</Markdown></details>)}</div>}
      </>}
      {item.status === 'pending' && current && <form onSubmit={respond} className="approval-response">
        <label htmlFor={commentId}>추가 의견</label>
        <textarea id={commentId} value={comment} onChange={event => onCommentChange(event.target.value)} rows={3} maxLength={16000} placeholder="수정할 내용이나 추가로 논의할 내용을 적어주세요." />
        {source && isLive(source.status) && <p className="muted">담당 AI가 응답을 마무리하고 있습니다. 종료 후 승인하거나 의견을 보낼 수 있습니다.</p>}
        {!source || (source && !isLive(source.status) && source.status !== 'completed') ? <p className="form-error">원래 AI 응답이 정상 종료되지 않았습니다. 실행 기록을 확인하고 협의안을 다시 요청하세요.</p> : null}
        <div className="action-row">{item.kind === 'report' && !item.snapshot.report?.final && <><button type="submit" value="retry" className="button primary" disabled={busy || sending || !canRespond}>재시도</button><button type="submit" value="stop" className="button secondary" disabled={busy || sending || !canRespond}>업무 중단</button></>}<button type="submit" value="approve" className="button primary" disabled={busy || sending || !canRespond}><Check size={15} />{item.kind === 'plan' ? '승인하고 진행' : item.snapshot.report?.final ? '결과 승인' : '보고 확인'}</button><button type="submit" value={item.kind === 'report' && !item.snapshot.report?.final ? 'rescope' : 'feedback'} className="button secondary" disabled={busy || sending || !canGiveFeedback || !comment.trim()}><MessageSquare size={15} />{item.kind === 'report' && !item.snapshot.report?.final ? '범위 변경 · 재협의' : '의견 보내고 재협의'}</button></div>
        <p className="muted">{item.kind === 'plan' ? '배정과 완료 기준이 준비된 작업은 승인 즉시 대기열에 등록합니다. 추가 의견이나 미배정 작업이 있으면 담당 AI가 이어서 처리합니다.' : item.snapshot.report?.final ? '결과를 승인하면 업무가 완료됩니다. 확인용 AI 호출은 만들지 않습니다.' : '진행·차단 보고의 확인을 기록합니다. 남아 있는 작업은 완료 처리하지 않습니다.'}</p>
      </form>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {item.response && <section className="approval-user-response"><strong>{item.response.decision === 'approve' ? '사용자 승인' : '사용자 의견'} · {time(item.response.at)}</strong><Markdown>{item.response.comment || '내용 확인 후 승인했습니다.'}</Markdown></section>}
      {job && <div className="approval-continuation" role="status"><Badge status={job.status}>{jobStates[job.status]}</Badge>{job.error && <p className="form-error">{job.error}</p>}
        {job.sessionId && <button type="button" className="text-button" onClick={() => open('sessionDetail', { id: job.sessionId })}>이어서 처리한 AI 실행 보기</button>}
        {['blocked', 'cancelled'].includes(job.status) && <button type="button" className="text-button" disabled={busy} onClick={async () => { try { await perform(`/workflow-jobs/${job.id}/retry`, 'POST', {}, '후속 실행을 다시 예약했습니다.'); } catch (issue) { setError(issue.message); } }}>후속 실행 다시 요청</button>}
      </div>}
    </div>
  </article>;
}

function ApprovalBrowser({ items, pending = false }) {
  const { data, busy } = useWorkspace();
  const [selectedId, setSelectedId] = useState('');
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('');
  const [page, setPage] = useState(0);
  const [drafts, setDrafts] = useState({});
  const detailId = useId();
  const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const rows = approvalSummaries(data, items).filter(row => (!kind || row.item.kind === kind) && terms.every(term => row.searchText.includes(term)));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / 10) - 1));
  const visible = rows.slice(currentPage * 10, currentPage * 10 + 10);
  const selected = rows.find(row => row.item.id === selectedId);
  const current = selected && data.requests.some(request => request.pendingApprovalId === selected.item.id);
  return <div className="approval-browser">
    <div className="record-search-controls">
      <label className="record-search"><Search size={16} /><input type="search" aria-label="승인 검색" placeholder="업무 · 담당 AI 검색" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} /></label>
      <select aria-label="승인 종류" value={kind} onChange={event => { setKind(event.target.value); setPage(0); }}><option value="">모든 종류</option><option value="plan">협의안</option><option value="report">결과 보고</option></select>
    </div>
    <div className="approval-browser-layout">
      <div className="approval-list">
        <p className="record-count">{rows.length}건 · {pending ? '오래 기다린 순' : '최신순'}</p>
        {visible.map(row => <button type="button" key={row.item.id} className="approval-summary" aria-pressed={selectedId === row.item.id} aria-controls={detailId} disabled={busy} onClick={() => setSelectedId(row.item.id)}>
          <strong>{row.title}</strong><span>{row.kindLabel} · v{row.item.version}{!pending && ` · ${row.item.status === 'pending' ? '이전 확인 요청' : states[row.item.status]}`}</span>
          {pending && <span>{row.reason}</span>}<small>{row.memberName} · {time(row.item.createdAt)}</small>
        </button>)}
        {!rows.length && <p className="approval-loading">조건에 맞는 승인 항목이 없습니다.</p>}
        {rows.length > 10 && <div className="approval-pagination"><button type="button" className="text-button" disabled={!currentPage || busy} onClick={() => setPage(currentPage - 1)}>이전</button><span>{currentPage + 1} / {Math.ceil(rows.length / 10)}</span><button type="button" className="text-button" disabled={(currentPage + 1) * 10 >= rows.length || busy} onClick={() => setPage(currentPage + 1)}>다음</button></div>}
      </div>
      <div id={detailId} className="approval-detail" role="region" aria-label="선택한 승인 상세">
        {selected ? <><p className="approval-selected-title">{selected.title}</p><Approval key={selected.item.id} item={selected.item} current={current} comment={drafts[selected.item.id] || ''} onCommentChange={value => setDrafts(previous => ({ ...previous, [selected.item.id]: value }))} /></>
          : <Empty compact title="승인 항목을 선택하세요" description="내용과 변경 사항을 확인하고 승인하거나 의견을 남길 수 있습니다." />}
      </div>
    </div>
  </div>;
}

export function PendingApprovals({ memberId, conversationId }) {
  const { data } = useWorkspace();
  const items = pendingApprovals(data, memberId).filter(item => !conversationId
    || data.sessions.some(run => run.id === item.sourceSessionId && run.conversationId === conversationId));
  if (!items.length) return null;
  return <section className="work-approvals" aria-label="사용자 확인 대기"><h3>사용자 확인 대기 · {items.length}건</h3>
    <ApprovalBrowser items={items} pending />
  </section>;
}

export function WorkApprovals({ requestId }) {
  const { data } = useWorkspace();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [draft, setDraft] = useState({});
  const request = (data.requests || []).find(item => item.id === requestId);
  const items = (data.workApprovals || []).filter(item => item.requestId === requestId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  if (!request || !items.length) return null;
  const pending = items.find(item => item.id === request.pendingApprovalId && item.status === 'pending');
  const history = items.filter(item => item !== pending);
  return <section className="work-approvals" aria-label="사용자 승인과 협의 기록"><h3><History size={16} />승인·의견과 후속 처리</h3>
    {pending && <Approval key={pending.id} item={pending} current comment={draft[pending.id] || ''}
      onCommentChange={comment => setDraft({ [pending.id]: comment })} />}
    {history.length > 0 && <details className="approval-history" open={historyOpen} onToggle={event => setHistoryOpen(event.currentTarget.open)}><summary>이전 승인·의견 기록 · {history.length}건</summary>{historyOpen && <ApprovalBrowser items={history} />}</details>}
  </section>;
}
