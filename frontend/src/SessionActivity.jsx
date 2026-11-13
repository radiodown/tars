import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, Brain, Check, FileCode2, ListChecks, LoaderCircle, MessageSquare, Search, Terminal, Wrench } from 'lucide-react';
import { api, isLive } from './api';
import { Markdown } from './ui';
import './session-activity.css';

const icons = { reasoning: Brain, command: Terminal, files: FileCode2, tool: Wrench, search: Search, plan: ListChecks, message: MessageSquare };
const statuses = { running: '진행 중', pending: '대기', completed: '완료', failed: '실패', declined: '거부됨', interrupted: '중단됨', incomplete: '완료 확인 안 됨' };
const fileKinds = { add: '추가', delete: '삭제', update: '수정' };

function Diff({ value }) {
  return <pre className="activity-diff" tabIndex={0} aria-label="코드 변경 내용"><code>{value.split('\n').map((line, index) => <span key={index}
    className={line.startsWith('+') && !line.startsWith('+++') ? 'diff-add' : line.startsWith('-') && !line.startsWith('---') ? 'diff-delete' : line.startsWith('@@') ? 'diff-range' : ''}>{line}{'\n'}</span>)}</code></pre>;
}

function ActivityItem({ item }) {
  const Icon = icons[item.kind] || Activity;
  return <li className={`activity-item activity-${item.status}`}><details>
    <summary><Icon size={14} aria-hidden="true" /><span className="activity-item-title">{item.title}</span><span className="activity-item-status">{statuses[item.status] || '확인 중'}</span></summary>
    <div className="activity-item-body">
      {item.command && <pre className="activity-command" tabIndex={0}><code>$ {item.command}</code></pre>}
      {item.cwd && <p className="activity-path">작업 경로: {item.cwd}</p>}
      {item.text && <Markdown>{item.text}</Markdown>}
      {item.kind === 'reasoning' && !item.text && <p className="activity-note">{item.status === 'running' ? '추론 요약을 기다리고 있습니다.' : '제공된 추론 요약이 없습니다.'}</p>}
      {item.steps?.length > 0 && <ul className="activity-plan">{item.steps.map((step, index) => <li key={index}>
        {step.status === 'completed' ? <Check size={13} /> : step.status === 'running' ? <LoaderCircle size={13} className="spin" /> : <span aria-hidden="true">○</span>}
        <span>{step.text}</span><small>{statuses[step.status]}</small>
      </li>)}</ul>}
      {item.changes?.map((change, index) => <div className="activity-file" key={`${change.path}:${index}`}>
        <p><span>{fileKinds[change.kind] || '변경'}</span><code>{change.path}</code></p>
        {change.diff && <Diff value={change.diff} />}
        {change.truncated && <p className="activity-note">긴 변경 내용의 일부를 표시합니다.</p>}
      </div>)}
      {item.output && <pre className="activity-output" tabIndex={0} aria-label="실행 결과">{item.output}</pre>}
      {item.exitCode != null && <p className="activity-note">종료 코드 {item.exitCode}</p>}
      {item.truncated && <p className="activity-note">긴 작업 내용의 일부를 표시합니다.</p>}
    </div>
  </details></li>;
}

export function SessionActivity({ session }) {
  const [expanded, setExpanded] = useState(false);
  const live = isLive(session.status);
  const query = useQuery({
    queryKey: ['session-activity', session.id, session.status],
    queryFn: ({ signal }) => api(`/sessions/${session.id}/activity`, 'GET', undefined, { signal }),
    enabled: expanded && Boolean(session.activityAvailable),
    refetchInterval: expanded && live ? 1000 : false, refetchIntervalInBackground: false, staleTime: 0,
  });
  const record = query.data;
  if (!live && !session.activityAvailable) return null;
  return <div className="session-activity">
    {live && <p className="activity-current" role="status"><LoaderCircle size={13} className="spin" aria-hidden="true" />
      <span>{session.status === 'stopping' ? session.progress : session.currentActivity || session.progress || '응답을 기다리고 있습니다.'}</span>
    </p>}
    {session.activityAvailable && <details className="activity-history" onToggle={event => { if (event.target === event.currentTarget) setExpanded(event.currentTarget.open); }}>
      <summary><Activity size={14} aria-hidden="true" /><span>작업 내역</span><small>{session.activityCount || 0}개</small></summary>
      {expanded && <div className="activity-history-body">
        {query.isPending && <p className="activity-note" role="status">작업 내역을 불러오는 중…</p>}
        {query.isError && <p className="activity-note" role="alert">작업 내역을 불러오지 못했습니다. <button type="button" onClick={() => query.refetch()}>다시 시도</button></p>}
        {record?.omitted > 0 && <p className="activity-note">최근 작업 {record.items.length}개를 표시합니다. 앞선 {record.omitted}개는 보관 한도를 넘었습니다.</p>}
        {record?.items?.length > 0 && <ol className="activity-list">{record.items.map(item => <ActivityItem key={item.id} item={item} />)}</ol>}
        {record?.diff && <details className="activity-total-diff"><summary><FileCode2 size={14} />전체 변경 내용</summary><Diff value={record.diff} />
          {record.diffTruncated && <p className="activity-note">긴 변경 내용의 일부를 표시합니다.</p>}
        </details>}
      </div>}
    </details>}
  </div>;
}
