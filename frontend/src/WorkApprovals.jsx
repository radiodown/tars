import { useId, useState } from 'react';
import { Check, MessageSquare, History } from 'lucide-react';
import { useWorkspace } from './App';
import { isLive, time } from './api';
import { Badge, Markdown } from './ui';
import './work-approvals.css';

const states = { pending: '사용자 확인 대기', approved: '승인됨', feedback: '의견 전달됨', superseded: '새 버전으로 대체' };
const jobStates = { queued: '담당 AI 실행 대기', running: '담당 AI가 이어서 처리 중', done: '후속 응답 완료', blocked: '후속 실행 실패', cancelled: '후속 실행 중지', superseded: '새 응답으로 대체' };

function Approval({ item, current, expanded }) {
  const { data, perform, open, busy } = useWorkspace();
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const commentId = useId();
  const source = data.sessions.find(session => session.id === item.sourceSessionId);
  const job = (data.workflowJobs || []).find(job => job.id === item.followupJobId);
  const name = id => data.members.find(member => member.id === id)?.name || '이전 담당자';
  const canRespond = current && item.status === 'pending' && source?.status === 'completed';
  const canGiveFeedback = current && item.status === 'pending' && source && !isLive(source.status);
  async function respond(event) {
    event.preventDefault();
    if (sending) return;
    const decision = event.nativeEvent.submitter?.value || 'feedback';
    if (decision === 'feedback' && !comment.trim()) { setError('추가 의견을 입력하세요.'); return; }
    setError(''); setSending(true);
    try {
      await perform(`/requests/${item.requestId}/approvals/${item.id}/respond`, 'POST', { decision, comment },
        decision === 'approve' ? '승인을 기록하고 담당 AI의 후속 실행을 예약했습니다.' : '의견을 저장하고 담당 AI의 후속 실행을 예약했습니다.');
      setComment('');
    } catch (issue) { setError(issue.message); }
    finally { setSending(false); }
  }
  return <details className={`work-approval ${item.status}`} open={expanded}>
    <summary><span>{item.kind === 'plan' ? '협의안' : '결과 보고'} v{item.version} · {states[item.status]}</span><small>{name(item.memberId)} · {time(item.createdAt)}</small></summary>
    <div className="work-approval-body">
      {item.restored && <p className="muted">이 기능을 적용하기 전에 저장된 기록입니다. 아래 내용을 확인하고 승인하거나 의견을 남겨주세요.</p>}
      <button type="button" className="text-button" onClick={() => open('sessionDetail', { id: item.sourceSessionId })}>작성한 AI 실행 보기</button>
      <h4>{item.snapshot.title}</h4>
      <Markdown>{item.content}</Markdown>
      {item.kind === 'plan' && <>
        <details><summary>목표와 작업 범위</summary><Markdown>{item.snapshot.instruction}</Markdown></details>
        {item.snapshot.documents.map(doc => <details key={doc.id}><summary>{doc.title} · v{doc.version}</summary><Markdown>{doc.content}</Markdown></details>)}
        {item.snapshot.tasks.length > 0 && <div className="approval-task-scope"><h4>승인 대상 작업 · {item.snapshot.tasks.length}건</h4>{item.snapshot.tasks.map(task => <details key={task.id}><summary>{task.title} · {name(task.assigneeId)}</summary><Markdown>{`${task.description || ''}\n\n완료 기준:\n${task.acceptance || '미등록'}`}</Markdown></details>)}</div>}
      </>}
      {item.status === 'pending' && current && <form onSubmit={respond} className="approval-response">
        <label htmlFor={commentId}>추가 의견</label>
        <textarea id={commentId} value={comment} onChange={event => setComment(event.target.value)} rows={3} maxLength={16000} placeholder="수정할 내용이나 추가로 논의할 내용을 적어주세요." />
        {source && isLive(source.status) && <p className="muted">담당 AI가 응답을 마무리하고 있습니다. 종료 후 승인하거나 의견을 보낼 수 있습니다.</p>}
        {!source || (source && !isLive(source.status) && source.status !== 'completed') ? <p className="form-error">원래 AI 응답이 정상 종료되지 않았습니다. 실행 기록을 확인하고 협의안을 다시 요청하세요.</p> : null}
        <div className="action-row"><button type="submit" value="approve" className="button primary" disabled={busy || sending || !canRespond}><Check size={15} />{item.kind === 'plan' ? '승인하고 진행' : item.snapshot.report?.final ? '결과 승인' : '보고 확인'}</button><button type="submit" value="feedback" className="button secondary" disabled={busy || sending || !canGiveFeedback || !comment.trim()}><MessageSquare size={15} />의견 보내고 재협의</button></div>
        <p className="muted">{item.kind === 'plan' ? '이 버전의 협의안을 승인하면 담당 AI가 이어서 처리합니다.' : item.snapshot.report?.final ? '결과를 승인하면 업무가 완료되고 담당 AI가 확인 답변을 남깁니다.' : '진행·차단 보고의 확인을 기록합니다. 남아 있는 작업은 완료 처리하지 않습니다.'}</p>
      </form>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {item.response && <section className="approval-user-response"><strong>{item.response.decision === 'approve' ? '사용자 승인' : '사용자 의견'} · {time(item.response.at)}</strong><Markdown>{item.response.comment || '내용 확인 후 승인했습니다.'}</Markdown></section>}
      {job && <div className="approval-continuation" role="status"><Badge status={job.status}>{jobStates[job.status]}</Badge>{job.error && <p className="form-error">{job.error}</p>}
        {job.sessionId && <button type="button" className="text-button" onClick={() => open('sessionDetail', { id: job.sessionId })}>이어서 처리한 AI 실행 보기</button>}
        {['blocked', 'cancelled'].includes(job.status) && <button type="button" className="text-button" disabled={busy} onClick={async () => { try { await perform(`/workflow-jobs/${job.id}/retry`, 'POST', {}, '후속 실행을 다시 예약했습니다.'); } catch (issue) { setError(issue.message); } }}>후속 실행 다시 요청</button>}
      </div>}
    </div>
  </details>;
}

export function WorkApprovals({ requestId }) {
  const { data } = useWorkspace();
  const request = (data.requests || []).find(item => item.id === requestId);
  const items = (data.workApprovals || []).filter(item => item.requestId === requestId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  if (!request || !items.length) return null;
  return <section className="work-approvals" aria-label="사용자 승인과 협의 기록"><h3><History size={16} />승인·의견과 후속 처리</h3>
    {items.map((item, index) => <Approval key={item.id} item={item} current={request.pendingApprovalId === item.id} expanded={request.pendingApprovalId === item.id || index === 0} />)}
  </section>;
}
