import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, History, ArrowUpRight } from 'lucide-react';
import { useWorkspace } from './App';
import { api, isLive, labels, providerLabel, time } from './api';
import { Badge, Markdown } from './ui';
import { WorkApprovals } from './WorkApprovals';
import './work-history.css';

const eventNames = { status: '상태', progress: '진행 단계', note: 'AI 진행 보고', instruction: '추가 지시', assignment: '담당자', edited: '작업 수정', integrated: '통합', submitted: '결과 제출', reviewed: '결과 검토', approval_requested: '사용자 확인 요청', user_response: '사용자 승인·의견' };
const entityNames = { sessions: '실행', tasks: 'TASK', members: 'AI' };
const timestamp = value => value ? new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value)) : '기록 없음';

export function HistoryTimeline({ kind, id, revision, live }) {
  const { data } = useWorkspace();
  const [before, setBefore] = useState(null);
  const query = useQuery({
    queryKey: ['work-history', kind, id, revision, before],
    queryFn: ({ signal }) => api(`/${kind}/${id}/history?limit=50${before ? `&before=${before}` : ''}`, 'GET', undefined, { signal }),
    refetchInterval: live && !before ? 3000 : false, refetchIntervalInBackground: false,
  });
  return <section className="work-history">
    <header><h3><History size={15} />상태·지시 이력</h3><span>{query.data ? `${query.data.total}건` : ''}</span></header>
    {query.isError && <p className="form-error" role="alert">{query.error.status === 404 ? '업무 이력 API를 적용하려면 백엔드를 재시작해주세요.' : query.error.message}</p>}
    {query.isPending && <p className="muted">이력을 불러오는 중…</p>}
    {query.data && !query.data.events.length && <p className="muted">아직 기록된 변경이 없습니다. 기능 적용 전의 상태 이력은 복원하지 않습니다.</p>}
    <ol>{(query.data?.events || []).map(event => <li key={event.sequence}>
      <div className="history-event-meta"><strong>{entityNames[event.kind]} · {eventNames[event.event] || event.event}</strong><time dateTime={event.at} title={event.at}>{timestamp(event.at)}</time></div>
      {event.status && <div className="history-status-change">{event.fromStatus && <><Badge status={event.fromStatus} /><span>→</span></>}<Badge status={event.status} /></div>}
      <p>{event.message}</p>
      {event.event === 'instruction' && <p className="history-instruction">{event.details?.prompt}</p>}
      {event.event === 'assignment' && <p>{data.members.find(member => member.id === event.details?.from)?.name || '미지정'} → {data.members.find(member => member.id === event.details?.to)?.name || '미지정'}</p>}
      {event.event === 'edited' && <details><summary>변경 내용</summary><pre>{JSON.stringify(event.details, null, 2)}</pre></details>}
      <small>{event.actor === 'user' ? '사용자' : event.actor === 'system' ? '실행 관리자' : data.members.find(member => member.id === event.actor)?.name || event.actor}</small>
    </li>)}</ol>
    {(before || query.data?.nextBefore) && <footer>
      {before && <button type="button" className="text-button" onClick={() => setBefore(null)}>최신 이력</button>}
      {query.data?.nextBefore && <button type="button" className="text-button" onClick={() => setBefore(query.data.nextBefore)}>이전 50건</button>}
    </footer>}
  </section>;
}

export function ExecutionRecord({ session }) {
  const { data, open } = useWorkspace();
  const request = session.request;
  return <section className="work-record">
    <header><h3><History size={16} />실행 기록</h3>{session.recordPath && <a href={`/api/sessions/${session.id}/record`} download><Download size={14} />기록 MD</a>}</header>
    <dl>
      <div><dt>담당</dt><dd>{request?.worker.name || data.members.find(member => member.id === session.memberId)?.name || '기록 없음'} · {providerLabel(session)}</dd></div>
      <div><dt>상위 관리자</dt><dd>{request?.manager?.name || '없음 / 이전 기록'}</dd></div>
      <div><dt>시작 / 종료</dt><dd>{timestamp(session.startedAt)} / {session.endedAt ? timestamp(session.endedAt) : '진행 중'}</dd></div>
      <div><dt>마지막 실행 이벤트</dt><dd>{timestamp(session.lastActivityAt)}</dd></div>
      {isLive(session.status) && <div><dt>서버 실행 확인</dt><dd>{timestamp(session.heartbeatAt)}</dd></div>}
      {session.resultSnapshot?.taskStatus && <div><dt>실행 종료 시 task</dt><dd><Badge status={session.resultSnapshot.taskStatus} /></dd></div>}
    </dl>
    {session.continuationOf && <p className="muted">{session.continuationMode === 'resumed' ? '원래 AI 세션을 재개했습니다.' : session.continuationMode === 'resuming' ? '원래 AI 세션 재개를 요청했습니다.' : '원래 협의·결과와 사용자 의견을 전달해 이어서 실행합니다.'} <button type="button" className="text-button" onClick={() => open('sessionDetail', { id: session.continuationOf })}>원래 실행 보기</button></p>}
    {[...new Set([session.requestId, ...(session.requestIds || [])].filter(Boolean))].map(requestId => <WorkApprovals key={requestId} requestId={requestId} />)}
    <details className="work-request"><summary>받은 지시와 배정 task{request?.task ? ` · ${request.task.title}` : ''}</summary>
      {request ? <>
        <p className="muted">실행 당시 저장한 내용 · 지시/배정자: {request.requestedBy.name}</p>
        <Markdown>{request.instruction || '별도의 요청 본문이 없습니다.'}</Markdown>
        {request.task && <><h4>완료 기준</h4><Markdown>{request.task.acceptance || '등록된 기준이 없습니다.'}</Markdown>
          {data.tasks.some(task => task.id === request.task.id) && <button className="text-button" onClick={() => open('taskDetail', { id: request.task.id })}>현재 task 보기<ArrowUpRight size={13} /></button>}
        </>}
        {request.source && <details><summary>{request.source.relation === 'created_from' ? '이 task를 만든 협의 지시' : '참조 문서의 관련 협의'}</summary><Markdown>{request.source.instruction || '별도 요청이 없습니다.'}</Markdown>
          {data.sessions.some(item => item.id === request.source.sessionId) && <button className="text-button" onClick={() => open('sessionDetail', { id: request.source.sessionId })}>협의 실행 기록<ArrowUpRight size={13} /></button>}
        </details>}
        {!!request.documents?.length && <p className="muted">요청 시 참조 문서: {request.documents.map(doc => `${doc.title} v${doc.version}`).join(' · ')}</p>}
      </> : <><p className="muted">기능 적용 이전 실행은 당시 task 사본이 없습니다.</p><Markdown>{session.prompt || '저장된 요청 본문이 없습니다.'}</Markdown></>}
      {(session.steering || []).map(input => <div className="history-instruction" key={input.id}><h4>추가 지시 · {timestamp(input.createdAt)}</h4><p>{input.prompt}</p></div>)}
    </details>
    {(session.resultSnapshot?.tasks.length > 0 || session.resultSnapshot?.documents.length > 0) && <details><summary>생성한 task · 문서</summary>
      {session.resultSnapshot.tasks.map(task => <p key={task.id}><button className="text-button" onClick={() => open('taskDetail', { id: task.id })}>{task.title}<ArrowUpRight size={13} /></button></p>)}
      {session.resultSnapshot.documents.map(doc => <p key={doc.id}>{doc.title} · v{doc.version}</p>)}
    </details>}
    {session.recordError && <p className="form-error">기록 파일 저장 실패: {session.recordError}. 저장된 요청·결과·상태 이력은 이 화면에서 확인할 수 있습니다.</p>}
    <p className="work-record-note">서버 실행 확인은 AI 활동과 별개이며, 실행 종료는 작업의 검토 완료를 뜻하지 않습니다.</p>
  </section>;
}

export function TaskExecutionHistory({ task }) {
  const { data, open } = useWorkspace();
  const [limit, setLimit] = useState(10);
  const sessions = data.sessions.filter(session => session.taskId === task.id);
  return <section className="task-execution-history">
    <header><h3>실행별 업무 기록</h3><span>{sessions.length}회</span></header>
    {!sessions.length && <p className="muted">실행을 시작하면 지시·task·결과가 실행별로 보관됩니다.</p>}
    <div className="execution-attempts">{sessions.slice(0, limit).map((session, index) => <button type="button" key={session.id} onClick={() => open('sessionDetail', session)}>
      <span><strong>{sessions.length - index}차 · {session.request?.worker.name || data.members.find(member => member.id === session.memberId)?.name || 'AI'}</strong><small>{time(session.startedAt)} · {providerLabel(session)}</small></span>
      <Badge status={session.status} /><ArrowUpRight size={14} />
    </button>)}</div>
    {sessions.length > limit && <button type="button" className="text-button" onClick={() => setLimit(value => value + 10)}>이전 실행 더 보기</button>}
    <HistoryTimeline kind="tasks" id={task.id} revision={task.updatedAt} live={['queued', 'running'].includes(task.status) || sessions.some(session => isLive(session.status))} />
  </section>;
}
