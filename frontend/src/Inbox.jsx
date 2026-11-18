import { useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, RotateCcw, Trash2 } from 'lucide-react';
import { useWorkspace } from './App';
import { time } from './api';
import { isInboxDismissed } from './inbox-items';
import { SessionInteraction } from './SessionInteractions';
import { SessionQuestion } from './SessionQuestions';
import { Approval } from './WorkApprovals';
import { Empty } from './ui';
import './inbox.css';

function InboxRow({ item, dismissed, expanded, toggle, dismiss, comment, onCommentChange }) {
  const { open, fire, busy } = useWorkspace();
  const detailsId = useId();
  const titleId = `${detailsId}-title`;
  const { type, record, task, request } = item;
  const actionable = item.category === 'action';
  const question = type === 'question' || (type === 'interaction' && record.kind === 'question');
  const title = question ? item.reason || item.title : type === 'interaction' ? record.title || item.title : item.title;
  const context = actionable ? [request?.title !== title && request?.title, item.memberName].filter(Boolean) : item.context;
  const action = question ? '답변' : type === 'approval' || record.kind === 'approval' ? '검토' : '응답';
  return <li className="inbox-row" data-category={item.category}>
    <div className="inbox-row-main">
      <div className="inbox-row-copy">
        <div className="inbox-row-meta">
          {(!actionable || type === 'approval') && <span className="inbox-row-label">{item.label}</span>}
          {context.length > 0 && <span>{context.join(' · ')}</span>}
          {(!actionable || dismissed) && item.date && <time dateTime={item.date}>{time(item.date)}</time>}
        </div>
        <h2 id={titleId}>{title}</h2>
        {item.reason && item.reason !== title && <p>{item.reason}</p>}
      </div>
      <div className="inbox-row-actions">{dismissed
        ? <button type="button" className="button secondary" onClick={dismiss}><RotateCcw size={15} />복원</button>
        : actionable ? <button type="button" className="button secondary inbox-open" aria-expanded={expanded} aria-controls={detailsId} aria-describedby={titleId} onClick={toggle}>
          {expanded ? '접기' : action}<ChevronDown size={15} />
        </button> : <>
          {type === 'job' && <button type="button" className="button secondary" disabled={busy} onClick={() => fire(`/workflow-jobs/${record.id}/retry`, 'POST', {}, '후속 실행을 다시 예약했습니다.')}>다시 요청</button>}
          {type === 'job' && record.sessionId && <button type="button" className="text-button" onClick={() => open('sessionDetail', { id: record.sessionId })}>실행 기록</button>}
          {task && <button type="button" className="text-button" onClick={() => open('taskDetail', task)}>작업 보기</button>}
          {request && (type === 'job' || type === 'request') && <Link className="button secondary" to={`/requests?request=${encodeURIComponent(request.id)}`}>업무 보기</Link>}
          <button type="button" className="text-button inbox-delete" title="목록에서 삭제" aria-label={`${item.title} 알림 삭제`} onClick={dismiss}><Trash2 size={15} />삭제</button>
        </>}
      </div>
    </div>
    {actionable && !dismissed && <div id={detailsId} className="inbox-row-detail" hidden={!expanded}>
      {expanded && type === 'approval' && <Approval item={record} current comment={comment} onCommentChange={onCommentChange} />}
      {expanded && type === 'question' && <SessionQuestion item={record} />}
      {expanded && type === 'interaction' && <SessionInteraction session={item.session} request={record} />}
      {expanded && <button type="button" className="text-button inbox-delete" onClick={dismiss}><Trash2 size={15} />목록에서 삭제</button>}
    </div>}
  </li>;
}

export function Inbox({ items, dismissals, changeDismissal }) {
  const [expandedId, setExpandedId] = useState(null);
  const [comments, setComments] = useState({});
  const heading = useRef(null);
  const requests = [];
  const workStatus = [];
  const deleted = [];
  for (const item of items) {
    if (isInboxDismissed(item, dismissals)) deleted.push(item);
    else if (item.category === 'action') requests.push(item);
    else workStatus.push(item);
  }
  function renderList(rows, dismissed = false) {
    return <ul className="panel inbox-list">{rows.map(item => <InboxRow key={item.id} item={item}
      dismissed={dismissed} expanded={expandedId === item.id}
      toggle={() => setExpandedId(current => current === item.id ? null : item.id)}
      dismiss={() => {
        changeDismissal(item, !dismissed);
        if (expandedId === item.id) setExpandedId(null);
        heading.current?.focus();
      }}
      comment={comments[item.id] || ''}
      onCommentChange={comment => setComments(current => ({ ...current, [item.id]: comment }))} />)}</ul>;
  }
  return <div className="page inbox-page">
    <div className="page-heading"><h1 ref={heading} tabIndex={-1}>확인할 일</h1></div>
    {requests.length ? renderList(requests) : <div className="panel"><Empty compact title="응답할 요청이 없습니다" /></div>}
    {workStatus.length > 0 && <details className="inbox-secondary">
      <summary>작업 상태 <span>{workStatus.length}건</span></summary>
      {renderList(workStatus)}
    </details>}
    {deleted.length > 0 && <details className="inbox-secondary">
      <summary>삭제함 <span>{deleted.length}건</span></summary>
      {renderList(deleted, true)}
    </details>}
  </div>;
}
