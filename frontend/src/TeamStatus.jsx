import { useState } from 'react';
import { Terminal, Users } from 'lucide-react';
import { useWorkspace } from './App';
import { isLive, providerLabel, time } from './api';
import { Avatar, Badge, Dialog, Empty } from './ui';
import { SessionTerminal, sessionTitle } from './SessionTerminal';
import './team-status.css';

function memberSessions(data, memberId) {
  return data.sessions.filter(session => session.memberId === memberId)
    .sort((a, b) => Number(isLive(b.status)) - Number(isLive(a.status))
      || (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0));
}

function MemberCli({ member, onClose }) {
  const { data } = useWorkspace();
  const [selectedId, setSelectedId] = useState('');
  const sessions = memberSessions(data, member.id);
  const session = sessions.find(item => item.id === selectedId) || sessions[0];
  return <Dialog title={`${member.name}의 CLI`} subtitle={providerLabel(member)} onClose={onClose} className="member-cli-dialog">
    {session ? <>
      <label className="member-cli-selector">실행 기록<select aria-label={`${member.name} CLI 실행 기록`} value={session.id} onChange={event => setSelectedId(event.target.value)}>
        {sessions.map(item => <option key={item.id} value={item.id}>{isLive(item.status) ? '진행 중 · ' : ''}{time(item.startedAt)} · {sessionTitle(item, data)}</option>)}
      </select></label>
      <SessionTerminal key={session.id} session={session} />
    </> : <Empty title="아직 CLI 실행 기록이 없습니다" description="팀원이 대화하거나 작업을 시작하면 이곳에서 실행 출력을 볼 수 있습니다." />}
  </Dialog>;
}

export function TeamStatus({ leader }) {
  const { data } = useWorkspace();
  const [selectedId, setSelectedId] = useState('');
  const department = data.departments.find(item => item.id === leader.departmentId);
  const members = data.members.filter(member => leader.departmentId && member.departmentId === leader.departmentId && member.role === 'member')
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  const selected = members.find(member => member.id === selectedId);
  return <aside className="team-status panel" aria-label="팀원 상태">
    <header><h2><Users size={17} />팀원 상태</h2><span>{members.length}명</span></header>
    <p>{department?.name || '소속 팀'} · 팀원을 누르면 CLI를 크게 볼 수 있습니다.</p>
    <div className="team-status-list">{members.map(member => {
      const session = memberSessions(data, member.id)[0];
      return <button key={member.id} type="button" className="team-status-member" aria-label={`${member.name} CLI 크게 보기`} onClick={() => setSelectedId(member.id)}>
        <span className="team-status-identity"><Avatar member={member} /><strong>{member.name}</strong><Badge status={member.status} /></span>
        <span className="team-status-progress">{session && isLive(session.status) ? session.currentActivity || session.progress || '실행 중' : member.specialty || providerLabel(member)}</span>
        <span className="team-status-action"><Terminal size={13} />{session ? isLive(session.status) ? '실행 중인 CLI 보기' : '최근 CLI 기록 보기' : 'CLI 기록 없음'}</span>
      </button>;
    })}</div>
    {!members.length && <p className="team-status-empty">이 팀에 등록된 팀원이 없습니다.</p>}
    {selected && <MemberCli key={selected.id} member={selected} onClose={() => setSelectedId('')} />}
  </aside>;
}
