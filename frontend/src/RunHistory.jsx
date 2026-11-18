import { useId, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronDown, Search } from 'lucide-react';
import { useWorkspace } from './App';
import { time } from './api';
import { Badge, Empty } from './ui';
import { filterSessionGroups, sessionDate, sessionGroups, sessionTitle } from './session-list';
import './record-lists.css';

const filters = [['attention', '확인 필요'], ['active', '진행 중'], ['all', '전체 기록']];

function SessionGroup({ group }) {
  const { data, open } = useWorkspace();
  const [expanded, setExpanded] = useState(false);
  const [limit, setLimit] = useState(10);
  const id = useId();
  const memberName = memberId => data.members.find(member => member.id === memberId)?.name || '이전 AI';
  const projects = group.projectIds.map(projectId => data.projects.find(project => project.id === projectId)?.name).filter(Boolean);
  return <article className="session-group">
    <button type="button" className="session-group-summary" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}>
      <ChevronDown size={17} className="record-chevron" />
      <span className="session-group-copy"><strong>{group.title}</strong><small>{group.kind}{projects.length ? ` · ${projects.join(', ')}` : ''} · {group.memberIds.map(memberName).join(', ')}</small></span>
      <Badge status={group.status}>{group.statusLabel}</Badge>
      <span className="session-group-meta"><strong>실행 {group.sessions.length}회</strong><small>최근 {time(sessionDate(group.latest))}</small></span>
    </button>
    {expanded && <div id={id} className="session-group-runs">
      <div className="session-group-context"><span>최근 실행부터 표시합니다.</span>{group.needsAttention && <Link to="/inbox">확인할 일 보기</Link>}</div>
      {group.sessions.slice(0, limit).map(session => <button type="button" className="session-history-row" key={session.id} onClick={() => open('sessionDetail', session)}>
        <span>{sessionTitle(session, data)}<small>{memberName(session.memberId)}</small></span>
        <Badge status={session.interactionState || session.status} /><small>{time(sessionDate(session))}</small>
      </button>)}
      {group.sessions.length > limit && <button type="button" className="text-button record-more" onClick={() => setLimit(value => value + 10)}>이전 실행 더 보기 · {group.sessions.length - limit}회 남음</button>}
    </div>}
  </article>;
}

function SessionResults({ groups, filtered, reset }) {
  const [limit, setLimit] = useState(20);
  return <div className="panel session-group-list">
    {groups.slice(0, limit).map(group => <SessionGroup key={group.id} group={group} />)}
    {groups.length > limit && <button type="button" className="text-button record-more" onClick={() => setLimit(value => value + 20)}>묶음 더 보기 · {groups.length - limit}개 남음</button>}
    {!groups.length && <Empty title={filtered ? '조건에 맞는 실행 기록이 없습니다' : '실행 기록이 없습니다'} description={filtered ? '상태나 검색 조건을 바꿔보세요.' : 'AI가 실행되면 업무와 대화별로 여기에 모입니다.'} action={filtered ? reset : undefined} label="전체 기록 보기" />}
  </div>;
}

export function RunHistory() {
  const { data } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const search = params.get('q') || '';
  const memberId = params.get('member') || '';
  const days = ['7', '30', '90'].includes(params.get('days')) ? params.get('days') : '';
  const status = filters.some(([key]) => key === params.get('status')) ? params.get('status') : 'all';
  const groups = useMemo(() => sessionGroups(data), [data.sessions, data.requests, data.tasks, data.members, data.projects, data.workApprovals, data.workflowJobs, data.inputRequests]);
  const scoped = filterSessionGroups(groups, { search, memberId, days });
  const visible = filterSessionGroups(scoped, { status });
  const counts = { all: scoped.length, attention: scoped.filter(group => group.needsAttention).length, active: scoped.filter(group => group.active).length };
  const sessionCount = new Set(visible.flatMap(group => group.sessions.map(session => session.id))).size;
  const filtered = Boolean(search || memberId || days || status !== 'all');
  function update(key, value) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  }
  return <div className="page sessions-page">
    <div className="page-heading"><div><h1>실행 기록</h1><p>업무와 대화별로 현재 상태를 확인하고, 펼쳐서 개별 실행을 열어보세요.</p></div></div>
    <div className="record-toolbar">
      <div className="record-filters" role="group" aria-label="실행 상태">{filters.map(([key, label]) => <button type="button" key={key} aria-pressed={status === key} onClick={() => update('status', key === 'all' ? '' : key)}>{label}<span>{counts[key]}</span></button>)}</div>
      <div className="record-search-controls">
        <label className="record-search"><Search size={16} /><input type="search" aria-label="실행 검색" placeholder="업무 · 작업 · AI · 프로젝트 검색" value={search} onChange={event => update('q', event.target.value)} /></label>
        <select aria-label="참여 AI" value={memberId} onChange={event => update('member', event.target.value)}><option value="">모든 AI</option>{memberId && !data.members.some(member => member.id === memberId) && <option value={memberId}>이전 AI</option>}{data.members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select>
        <select aria-label="최근 실행 기간" value={days} onChange={event => update('days', event.target.value)}><option value="">전체 기간</option><option value="7">최근 7일</option><option value="30">최근 30일</option><option value="90">최근 90일</option></select>
        {filtered && <button type="button" className="text-button" onClick={() => setParams({}, { replace: true })}>초기화</button>}
      </div>
      <p className="record-count" role="status">{visible.length}개 묶음 · 실행 {sessionCount}회</p>
    </div>
    <SessionResults key={params.toString()} groups={visible} filtered={filtered} reset={() => setParams({}, { replace: true })} />
  </div>;
}
