import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, ArrowUpRight, Clock3, Crown, Layers3, Plus, Search, Terminal, Users } from 'lucide-react';
import { useWorkspace } from './App';
import { isLive, labels, providerLabel, time } from './api';
import { Avatar, Badge, Empty } from './ui';
import './workspace-monitor.css';

const sessionKinds = { ceo_chat: 'CEO 대화', oversight: '총괄 보고', plan: '협의 · 작업 설계', review: '결과 보고', work: '작업 실행' };
const roleLabel = member => member?.role === 'ceo' ? 'CEO' : member?.role === 'leader' ? '팀장' : '팀원';
const finished = status => ['done', 'completed', 'cancelled'].includes(status);
const problem = status => ['blocked', 'failed', 'interrupted'].includes(status);
const timestamp = value => Date.parse(value || '') || 0;
const sessionScope = session => `${session.memberId}:${session.kind}:${session.projectId || ''}`;

function collectWork(data) {
  const members = new Map(data.members.map(member => [member.id, member]));
  const tasks = new Map(data.tasks.map(task => [task.id, task]));
  const projects = new Map(data.projects.map(project => [project.id, project]));
  const departments = new Set(data.departments.map(department => department.id));
  const sessions = [...data.sessions].sort((a, b) => timestamp(b.startedAt) - timestamp(a.startedAt));
  const byTask = new Map(), latestStandalone = new Map(), activeByMember = new Map(), latestByMember = new Map();
  for (const session of sessions) {
    if (!latestByMember.has(session.memberId)) latestByMember.set(session.memberId, session);
    if (isLive(session.status) && !activeByMember.has(session.memberId)) activeByMember.set(session.memberId, session);
    if (session.taskId && tasks.has(session.taskId)) {
      const previous = byTask.get(session.taskId);
      if (!previous || (isLive(session.status) && !isLive(previous.status))) byTask.set(session.taskId, session);
    } else if (!latestStandalone.has(sessionScope(session))) latestStandalone.set(sessionScope(session), session.id);
  }
  function row(task, session) {
    const member = members.get(task ? task.assigneeId : session?.memberId);
    const departmentId = task?.departmentId || session?.departmentId || member?.departmentId;
    const ceo = member?.role === 'ceo' || (!task && ['ceo_chat', 'oversight'].includes(session?.kind));
    const updatedAt = [task?.updatedAt, session?.updatedAt].filter(Boolean).sort((a, b) => timestamp(b) - timestamp(a))[0];
    return {
      id: task ? `task:${task.id}` : `session:${session.id}`, task, session, member, updatedAt,
      project: projects.get(task?.projectId || session?.projectId),
      groupId: ceo ? 'ceo' : departments.has(departmentId) ? departmentId : 'unassigned',
      title: task?.title || sessionKinds[session?.kind] || 'AI 요청',
      status: task?.status || session?.status,
      live: isLive(session?.status),
      current: Boolean(task) || isLive(session?.status) || latestStandalone.get(sessionScope(session)) === session.id,
    };
  }
  const rows = data.tasks.map(task => row(task, byTask.get(task.id)));
  for (const session of sessions) if (!session.taskId || !tasks.has(session.taskId)) rows.push(row(null, session));
  return { rows, tasks, members, activeByMember, latestByMember, activeCount: sessions.filter(session => isLive(session.status)).length };
}

function progressText(row, work, settings) {
  const { task, session, live } = row;
  if (live) return session.progress || '실행 상태를 기다리고 있습니다.';
  if (!task) return session.progress || labels[session.status] || '실행 기록을 확인하세요.';
  if (task.status === 'blocked') return task.error || (problem(session?.status) ? session.progress : '') || '작업 상세에서 차단 사유를 확인하세요.';
  if (task.status === 'queued') {
    const waiting = (task.dependsOn || []).map(id => work.tasks.get(id)).filter(dependency => dependency?.status !== 'done');
    if (waiting.length) return `선행 작업 대기: ${waiting.map(dependency => dependency?.title || '확인할 수 없는 작업').join(', ')}`;
    if (!row.member) return '담당자 확인이 필요합니다.';
    if (work.activeByMember.has(task.assigneeId)) return `${row.member.name}의 현재 작업이 끝나기를 기다리고 있습니다.`;
    if (work.activeCount >= settings.maxConcurrent) return `동시 실행 한도 ${settings.maxConcurrent}개가 사용 중입니다. 실행 여유를 기다리고 있습니다.`;
    return '실행 순서를 기다리고 있습니다.';
  }
  if (task.status === 'running') return '작업은 진행 중으로 기록되어 있으나 실행 중인 세션이 없습니다. 실행 기록을 확인하세요.';
  if (task.status === 'review') return '실행 결과가 도착했습니다. 검토를 기다리고 있습니다.';
  if (task.status === 'done') return task.integratedAt ? '검토를 마치고 변경 사항을 원본에 적용했습니다.' : '작업이 완료 처리되었습니다.';
  if (task.status === 'cancelled') return '작업이 취소되었습니다.';
  return task.assigneeId ? '담당자에게 배정되었습니다. 실행 요청을 기다리고 있습니다.' : '담당자 배정을 기다리고 있습니다.';
}

function elapsed(startedAt, endedAt, now) {
  const start = timestamp(startedAt);
  if (!start) return '—';
  const seconds = Math.max(0, Math.floor(((endedAt ? timestamp(endedAt) : now) - start) / 1000));
  if (seconds < 60) return '1분 미만';
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}분` : `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
}

function WorkRow({ row, work, settings, now, open }) {
  const { task, session, member, live } = row;
  const detail = progressText(row, work, settings);
  const executionOwner = session && work.members.get(session.memberId);
  const heartbeat = timestamp(session?.heartbeatAt);
  const stale = live && heartbeat > 0 && now - heartbeat > 45000;
  const projectLabel = row.project?.name || (['ceo_chat', 'oversight'].includes(session?.kind) && !session.projectId ? '전체 프로젝트' : '프로젝트 미지정');
  return <tr className={`${live ? 'is-live' : ''} ${problem(row.status) ? 'needs-attention' : ''}`}>
    <td className="monitor-work-cell">
      <button type="button" className="monitor-work-title" onClick={() => open(task ? 'taskDetail' : 'sessionDetail', task || session)}>{row.title}</button>
      <span className="monitor-work-meta">{projectLabel} · {task ? `TSK-${task.id.slice(0, 4).toUpperCase()}` : sessionKinds[session.kind] || '실행 세션'}</span>
      {!task && session.prompt && <p className="monitor-request" title={session.prompt}>{session.prompt}</p>}
    </td>
    <td className="monitor-owner-cell"><div className="monitor-owner"><Avatar member={member} /><span><strong>{member?.name || '미배정'}</strong><small>{member ? roleLabel(member) : '담당자 필요'}</small></span></div></td>
    <td className="monitor-state-cell"><Badge status={row.status} />{live && session.status !== row.status && <span className="monitor-execution-state">{labels[session.status]}</span>}</td>
    <td className="monitor-progress-cell"><p title={detail}>{detail}</p><div className="monitor-timing">
      {session && (live || session.endedAt) && <span><Clock3 size={12} />{live ? '경과' : '최근 실행'} {elapsed(session.startedAt, session.endedAt, now)}</span>}
      <time dateTime={row.updatedAt}>갱신 {time(row.updatedAt)}</time>
      {live && <span className={stale ? 'activity-stale' : ''}>{stale ? '실행 확인 지연' : '서버 확인'} {heartbeat ? time(session.heartbeatAt) : '기록 없음'}</span>}
      {live && <span>AI 활동 {session.lastActivityAt ? time(session.lastActivityAt) : '이벤트 대기'}</span>}
      {executionOwner && executionOwner.id !== member?.id && <span>최근 실행 담당: {executionOwner.name}</span>}
    </div></td>
    <td className="monitor-actions-cell">{session ? <button type="button" className="monitor-session-button" onClick={() => open('sessionDetail', session)} aria-label={`${member?.name || 'AI'} · ${row.title} 실행 기록 보기`}><Terminal size={14} />{live ? '실행 보기' : '실행 기록'}</button> : <span className="monitor-no-session">실행 전</span>}</td>
  </tr>;
}

export function Dashboard() {
  const { data, open } = useWorkspace();
  const [department, setDepartment] = useState('all');
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [includeHistory, setIncludeHistory] = useState(false);
  const [now, setNow] = useState(Date.now);
  const work = useMemo(() => collectWork(data), [data]);
  // Only the visible monitor needs an elapsed-time clock. Status data uses the
  // existing workspace event stream/polling; no per-row API polling is added.
  useEffect(() => {
    if (!work.activeCount) return;
    let timer;
    const followVisibility = () => {
      clearInterval(timer);
      if (document.hidden) return;
      setNow(Date.now());
      timer = setInterval(() => setNow(Date.now()), 15000);
    };
    followVisibility();
    document.addEventListener('visibilitychange', followVisibility);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', followVisibility); };
  }, [work.activeCount]);

  const term = search.trim().toLocaleLowerCase();
  const departmentIds = new Set(data.departments.map(item => item.id));
  const groups = [
    { id: 'ceo', name: 'CEO · TARS', members: data.members.filter(member => member.role === 'ceo') },
    ...data.departments.map(item => ({ ...item, members: data.members.filter(member => member.departmentId === item.id && member.role !== 'ceo') })),
    { id: 'unassigned', name: '소속 미지정', members: data.members.filter(member => member.role !== 'ceo' && !departmentIds.has(member.departmentId)) },
  ];
  const rank = row => row.live ? 0 : problem(row.status) ? 1 : row.status === 'review' ? 2 : row.status === 'queued' ? 3 : finished(row.status) ? 6 : 4;
  const visibleGroups = groups.filter(group => department === 'all' || department === group.id).map(group => {
    const rows = work.rows.filter(row => row.groupId === group.id
      && (includeHistory || (row.live || (row.current && !finished(row.status)))))
      .filter(row => status === 'all' || (status === 'live' ? row.live || row.status === 'running'
        : status === 'waiting' ? ['draft', 'assigned', 'queued'].includes(row.status)
          : status === 'attention' ? problem(row.status) : row.status === status))
      .filter(row => !term || [row.title, row.task?.description, row.session?.prompt, row.member?.name, roleLabel(row.member), row.project?.name, group.name,
        labels[row.status], progressText(row, work, data.settings)].filter(Boolean).join(' ').toLocaleLowerCase().includes(term))
      .sort((a, b) => rank(a) - rank(b) || timestamp(b.updatedAt) - timestamp(a.updatedAt));
    const rosterMatch = !term || [group.name, ...group.members.map(member => member.name)].join(' ').toLocaleLowerCase().includes(term);
    return { ...group, rows, rosterMatch, liveCount: rows.filter(row => row.live).length };
  }).filter(group => group.rows.length || (status === 'all' && group.rosterMatch && (group.members.length || departmentIds.has(group.id))))
    .sort((a, b) => b.liveCount - a.liveCount);
  const total = visibleGroups.reduce((sum, group) => sum + group.rows.length, 0);

  return <div className="page dashboard workspace-monitor">
    <div className="page-heading"><div><h1>워크스페이스</h1><p>팀과 담당자별로 현재 작업, 대기 사유와 실행 상황을 확인하세요.</p></div><button type="button" className="button primary" onClick={() => open('task')}><Plus size={16} />작업 만들기</button></div>
    <div className="toolbar monitor-toolbar">
      <label className="search-input"><Search size={16} /><input type="search" aria-label="작업, 팀원, 프로젝트 검색" placeholder="작업 · 팀원 · 프로젝트 검색" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <select className="compact-select" aria-label="모니터링 부서" value={department} onChange={event => setDepartment(event.target.value)}><option value="all">전체 조직</option><option value="ceo">CEO · TARS</option>{data.departments.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}<option value="unassigned">소속 미지정</option></select>
      <select className="compact-select" aria-label="모니터링 상태" value={status} onChange={event => setStatus(event.target.value)}><option value="all">모든 진행 상태</option><option value="live">실행 중</option><option value="waiting">대기 중</option><option value="review">검토 대기</option><option value="attention">차단 · 실패 · 중단</option></select>
      <label className="checkbox-label"><input type="checkbox" checked={includeHistory} onChange={event => setIncludeHistory(event.target.checked)} />완료·취소·이전 실행 포함</label>
      <span className="toolbar-count">{total}건 표시</span>
    </div>
    <div className="monitor-section-heading"><span><Activity size={15} />작업 진행 현황 <small>상태 변경 시 자동 갱신</small></span><div><Link to="/tasks">작업 보드<ArrowUpRight size={13} /></Link><Link to="/organization">조직 관리<ArrowUpRight size={13} /></Link></div></div>
    <div className="monitor-groups">{visibleGroups.map(group => <section className="monitor-team" key={group.id} aria-labelledby={`monitor-team-${group.id}`}>
      <header className="monitor-team-heading"><div>{group.id === 'ceo' ? <Crown size={17} /> : <Layers3 size={17} />}<h2 id={`monitor-team-${group.id}`}>{group.name}</h2><span>{group.rows.length}건</span></div>{group.liveCount > 0 && <span className="monitor-live-label"><i />{group.liveCount}건 실행 중</span>}</header>
      <div className="monitor-roster" aria-label={`${group.name} 담당자 현황`}>{[...group.members].sort((a, b) => Number(b.role === 'leader') - Number(a.role === 'leader')).map(member => {
        const session = work.activeByMember.get(member.id) || work.latestByMember.get(member.id);
        const active = Boolean(work.activeByMember.get(member.id));
        return <button type="button" key={member.id} className={`monitor-member ${active ? 'is-live' : ''}`} disabled={!session} onClick={() => session && open('sessionDetail', session)} title={`${providerLabel(member)} · ${session ? '현재 또는 최근 실행 기록 보기' : '실행 기록 없음'}`}>
          <Avatar member={member} /><span><strong>{member.name}<small>{roleLabel(member)}</small></strong><span><i />{active ? labels[session.status] : '실행 중 작업 없음'}</span></span>
        </button>;
      })}{!group.members.length && <span className="monitor-roster-empty"><Users size={14} />등록된 담당자가 없습니다.</span>}</div>
      {group.rows.length ? <div className="monitor-table-scroll" role="region" tabIndex={0} aria-label={`${group.name} 작업 목록`}><table className="monitor-table"><thead><tr><th scope="col">작업 · 요청</th><th scope="col">담당자</th><th scope="col">상태</th><th scope="col">현재 진행 상황</th><th scope="col">실행 기록</th></tr></thead><tbody>{group.rows.map(row => <WorkRow key={row.id} row={row} work={work} settings={data.settings} now={now} open={open} />)}</tbody></table></div>
        : <p className="monitor-team-empty">현재 조건에 해당하는 진행 작업이 없습니다.</p>}
    </section>)}</div>
    {!visibleGroups.length && <div className="panel"><Empty title="조건에 맞는 작업이 없습니다" description="검색어나 상태 필터를 바꾸거나 완료·이전 실행을 포함해 확인하세요." compact /></div>}
    <details className="monitor-activity"><summary><Activity size={15} />최근 활동 <span>최근 {Math.min(data.events.length, 12)}개</span></summary>
      {data.events.length ? <ol>{data.events.slice(0, 12).map(event => <li key={event.id} className={event.level === 'error' ? 'is-error' : ''}><time dateTime={event.createdAt}>{time(event.createdAt)}</time><span>{event.message}</span>{event.sessionId && data.sessions.some(session => session.id === event.sessionId) && <button type="button" onClick={() => open('sessionDetail', { id: event.sessionId })}>실행 보기<ArrowUpRight size={12} /></button>}</li>)}</ol> : <p>아직 활동 기록이 없습니다.</p>}
    </details>
  </div>;
}
