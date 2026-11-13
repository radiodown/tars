import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, ChevronDown, ChevronRight, Command, Crown, Network, Plus, Settings2, Users } from 'lucide-react';
import { useWorkspace } from './App';
import { Avatar, Badge } from './ui';

function AiNode({ member, executive = false }) {
  const { data, open } = useWorkspace();
  const running = member.status === 'running';
  const session = data.sessions.find(item => item.id === member.currentSessionId) || data.sessions.find(item => item.memberId === member.id);
  return <article className={`org-node org-ai ${executive ? 'org-executive' : member.role === 'leader' ? 'org-lead' : ''}`} aria-label={`${member.name} · ${executive ? 'CEO' : member.role === 'leader' ? '팀장' : '팀원'}`}>
    <div className="org-node-top"><span className="org-rank">{executive ? <Command size={13} /> : member.role === 'leader' ? <Crown size={13} /> : <Users size={13} />}{executive ? 'CEO · 전체 조직 총괄' : member.role === 'leader' ? '팀장 · 설계와 위임' : '팀원 · 작업 수행'}</span><Badge status={member.status} /></div>
    <div className="org-identity"><Avatar member={member} large /><div><h3>{member.name}</h3><p>{executive ? '모든 부서와 프로젝트를 관리합니다.' : member.specialty || '전문 분야 미설정'}</p></div></div>
    <dl className="org-model">{member.provider === 'codex' && <div><dt>계정</dt><dd className="org-account">{member.codexAccount || 'codex'}</dd></div>}<div><dt>모델</dt><dd><span>{member.provider === 'codex' ? 'Codex' : 'Claude'}</span><strong>{member.model || 'CLI 기본 모델'}</strong></dd></div><div><dt>추론</dt><dd>{!member.reasoning || member.reasoning === 'default' ? '기본 설정' : member.reasoning}</dd></div></dl>
    <footer>
      <button type="button" disabled={running} title={running ? '진행 중인 세션을 중지한 뒤 설정을 변경하세요.' : undefined} onClick={() => open(executive ? 'ceoSettings' : 'member', executive ? {} : member)}><Settings2 size={13} />{executive ? 'TARS 설정' : '프로필 · 소속 설정'}</button>
      {session ? <button type="button" onClick={() => open('sessionDetail', session)}>CLI 보기<ArrowUpRight size={13} /></button> : executive ? <Link to="/ceo">상황실<ArrowUpRight size={13} /></Link> : null}
    </footer>
  </article>;
}

function AddNode({ label, description, onClick, kind = '' }) {
  return <button type="button" className={`org-add-node ${kind}`} onClick={onClick}><span className="org-add-icon"><Plus size={17} /></span><span><strong>{label}</strong>{description && <small>{description}</small>}</span></button>;
}

function DepartmentBranch({ department }) {
  const { data, open } = useWorkspace();
  const [collapsed, setCollapsed] = useState(false);
  const members = data.members.filter(member => member.departmentId === department.id && member.role !== 'ceo');
  const leader = members.find(member => member.role === 'leader');
  const workers = members.filter(member => member.role === 'member');
  const peopleId = `org-people-${department.id}`;
  return <li className="org-branch">
    <section aria-label={`${department.name} 부서`}>
      <article className="org-node org-department">
        <h2><button type="button" className="org-collapse" title={department.name} aria-label={`${department.name} ${collapsed ? '펼치기' : '접기'}`} aria-expanded={!collapsed} aria-controls={peopleId} onClick={() => setCollapsed(value => !value)}>{collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}<span>{department.name}</span></button></h2>
        <button type="button" className="icon-button" aria-label={`${department.name} 부서 설정`} onClick={() => open('department', department)}><Settings2 size={15} /></button>
      </article>
      <div className="org-team" id={peopleId} hidden={collapsed}>
        <ul className="org-leader-list" aria-label={`${department.name} 팀장`}><li>
          {leader ? <AiNode member={leader} /> : <AddNode label="팀장 추가" description="설계와 업무 배정을 맡을 AI" kind="org-add-leader" onClick={() => open('member', { departmentId: department.id, role: 'leader' })} />}
          <ul className="org-member-list" aria-label={`${department.name} 팀원`}>
            {workers.map(member => <li key={member.id}><AiNode member={member} /></li>)}
            <li><AddNode label="팀원 추가" description="이 부서에서 일할 AI" onClick={() => open('member', { departmentId: department.id, role: 'member' })} /></li>
          </ul>
        </li></ul>
      </div>
    </section>
  </li>;
}

export function Organization() {
  const { data, open } = useWorkspace();
  const [departmentId, setDepartmentId] = useState('all');
  const canvas = useRef(null);
  useEffect(() => {
    const element = canvas.current;
    if (element) element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2;
  }, [departmentId]);
  function addDepartment() {
    setDepartmentId('all');
    open('department');
  }
  const ceo = data.members.find(member => member.role === 'ceo');
  const departments = data.departments.filter(department => departmentId === 'all' || department.id === departmentId);
  const people = data.members.filter(member => member.role !== 'ceo');
  return <div className="page organization-page">
    <div className="page-heading"><div><p className="eyebrow">ORGANIZATION / COMMAND STRUCTURE</p><h1>AI 조직도</h1><p>TARS 아래에 부서를 만들고, 팀장과 팀원을 연결하세요.</p></div><button className="button primary" onClick={addDepartment}><Plus size={16} />부서 추가</button></div>
    <div className="org-toolbar"><div className="org-summary"><Network size={17} /><span>CEO <b>1</b></span><span>부서 <b>{data.departments.length}</b></span><span>팀장 <b>{people.filter(member => member.role === 'leader').length}</b></span><span>팀원 <b>{people.filter(member => member.role === 'member').length}</b></span></div><select className="compact-select" aria-label="조직도 부서 필터" value={departmentId} onChange={event => setDepartmentId(event.target.value)}><option value="all">전체 조직</option>{data.departments.map(department => <option key={department.id} value={department.id}>{department.name}</option>)}</select></div>
    <p className="org-instructions" id="org-instructions">추가 버튼으로 조직을 확장하고, 프로필 설정에서 모델·추론 깊이·소속을 변경하세요. 조직도가 넓으면 좌우로 스크롤할 수 있습니다.</p>
    <div className="org-canvas" ref={canvas} role="region" aria-label="TARS AI 조직도" aria-describedby="org-instructions" tabIndex={0}>
      <div className="org-tree">
        <div className="org-root">{ceo ? <AiNode member={ceo} executive /> : <div className="org-node">TARS를 준비하고 있습니다.</div>}</div>
        <ul className="org-departments" aria-label="TARS 산하 부서">
          {departments.map(department => <DepartmentBranch key={department.id} department={department} />)}
          <li className="org-branch org-new-department"><AddNode label={data.departments.length ? '새 부서 추가' : '첫 부서 만들기'} description="부서 → 팀장 → 팀원 순서로 구성" kind="org-add-department" onClick={addDepartment} /></li>
        </ul>
      </div>
    </div>
  </div>;
}
