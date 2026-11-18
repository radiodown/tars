import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useWorkspace } from './App';
import { MemberChat } from './MemberChat';
import { Badge, Empty } from './ui';
import { isLive, time } from './api';
import './conversations.css';

export function Sessions() {
  const { data } = useWorkspace();
  const [params] = useSearchParams();
  const [search, setSearch] = useState('');
  const [memberFilter, setMemberFilter] = useState('');
  const legacyRun = data.sessions.find(run => run.id === params.get('session'));
  const conversationId = params.get('conversation') || legacyRun?.conversationId || '';
  const selected = (data.conversations || []).find(item => item.id === conversationId);
  const member = data.members.find(item => item.id === (selected?.memberId || params.get('member') || legacyRun?.memberId));
  if (member) return <div className="page conversation-page"><div className="page-heading"><div><h1>{member.name}의 세션</h1><p>선택한 세션의 문맥으로 대화를 이어갑니다.</p></div><Link className="button secondary" to="/sessions">세션 목록</Link></div><MemberChat key={`${member.id}:${conversationId}`} member={member} initialConversationId={conversationId} /></div>;
  if (conversationId) return <div className="page"><Empty title="이 세션의 담당 AI를 찾을 수 없습니다" description="실행 기록에서 보존된 결과를 확인하세요." /><Link to="/runs">실행 기록</Link></div>;
  const items = [...(data.conversations || [])].sort((a, b) => (b.lastActivityAt || b.createdAt).localeCompare(a.lastActivityAt || a.createdAt))
    .filter(item => (!memberFilter || item.memberId === memberFilter) && `${item.title} ${data.members.find(member => member.id === item.memberId)?.name || ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <div className="page sessions-page">
    <div className="page-heading"><div><h1>세션</h1><p>같은 대화 문맥을 공유하는 단위입니다. 기존 세션을 열어 재개하거나 새 세션을 시작하세요.</p></div><Link className="button secondary" to="/runs">전체 실행 기록</Link></div>
    <div className="toolbar"><input type="search" aria-label="세션 검색" placeholder="세션 제목 · AI 검색" value={search} onChange={event => setSearch(event.target.value)} /><select aria-label="세션 담당 AI" value={memberFilter} onChange={event => setMemberFilter(event.target.value)}><option value="">모든 AI</option>{data.members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select><span>{items.length}개 세션</span></div>
    <div className="conversation-start"><span>새 세션 시작</span>{data.members.map(member => <Link className="button secondary" key={member.id} to={`/sessions?member=${member.id}`}>{member.name}</Link>)}</div>
    <div className="conversation-list">{items.map(item => {
      const runs = data.sessions.filter(run => run.conversationId === item.id);
      const latest = runs[0];
      const active = runs.find(run => isLive(run.status));
      const owner = data.members.find(member => member.id === item.memberId);
      const project = data.projects.find(project => project.id === item.projectId);
      return <article className="panel conversation-card" key={item.id}>
        <div><h2><Link to={`/sessions?conversation=${item.id}`}>{item.title}</Link></h2><p>{owner?.name || '이전 AI'} · {project?.name || '프로젝트 미지정'} · {item.kind === 'chat' ? '대화' : '업무 수행'} · 실행 {runs.length}회</p><small>최근 {time(item.lastActivityAt || item.createdAt)}</small></div>
        <div className="conversation-actions">{active ? <Badge status={active.status} /> : latest && ['failed', 'interrupted', 'cancelled'].includes(latest.status) ? <Badge status={latest.status} /> : <span className="muted">{runs.length ? '응답 종료' : '시작 전'}</span>}<Link className="button secondary" to={`/sessions?conversation=${item.id}`}>{active ? '진행 보기' : '세션 열기 · 재개'}</Link></div>
      </article>;
    })}</div>
    {!items.length && <Empty title="저장된 세션이 없습니다" description="AI를 선택하고 첫 메시지를 보내면 세션이 만들어집니다." />}
  </div>;
}
