import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, ChevronDown, ChevronRight, Command, Crown, Minus, Network, Plus, RotateCcw, Settings2, Users } from 'lucide-react';
import { useWorkspace } from './App';
import { Avatar, Badge } from './ui';

const MIN_ZOOM = 40;
const MAX_ZOOM = 160;
const clampZoom = value => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));

function AiNode({ member, executive = false }) {
  const { data, open } = useWorkspace();
  const running = member.status === 'running';
  const session = data.sessions.find(item => item.id === member.currentSessionId) || data.sessions.find(item => item.memberId === member.id);
  return <article className={`org-node org-ai ${executive ? 'org-executive' : member.role === 'leader' ? 'org-lead' : ''}`} aria-label={`${member.name} · ${executive ? 'CEO' : member.role === 'leader' ? '팀장' : '팀원'}`}>
    <div className="org-node-top"><span className="org-rank">{executive ? <Command size={13} /> : member.role === 'leader' ? <Crown size={13} /> : <Users size={13} />}<span className="org-rank-label">{executive ? 'CEO' : member.role === 'leader' ? '팀장' : '팀원'}<span className="org-rank-description"> · {executive ? '전체 조직 총괄' : member.role === 'leader' ? '설계와 위임' : '작업 수행'}</span></span></span><Badge status={member.status} /></div>
    <div className="org-identity"><Avatar member={member} large /><div><h3 title={member.name}>{member.name}</h3><p>{executive ? '모든 부서와 프로젝트를 관리합니다.' : member.specialty || '전문 분야 미설정'}</p></div></div>
    <dl className="org-model">{member.provider === 'codex' && <div><dt>계정</dt><dd className="org-account">{member.codexAccount || 'codex'}</dd></div>}<div><dt>모델</dt><dd><span>{member.provider === 'codex' ? 'Codex' : 'Claude'}</span><strong>{member.model || 'CLI 기본 모델'}</strong></dd></div><div><dt>추론</dt><dd>{!member.reasoning || member.reasoning === 'default' ? '기본 설정' : member.reasoning}</dd></div></dl>
    <footer>
      <button type="button" disabled={running} title={running ? '진행 중인 실행을 중지한 뒤 설정을 변경하세요.' : undefined} onClick={() => open(executive ? 'ceoSettings' : 'member', executive ? {} : member)}><Settings2 size={13} />{executive ? 'TARS 설정' : '프로필 · 소속 설정'}</button>
      <Link to={executive ? '/ceo' : `/sessions?member=${member.id}`}>대화하기<ArrowUpRight size={13} /></Link>
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
  const project = data.projects.find(item => item.id === department.projectId);
  const peopleId = `org-people-${department.id}`;
  return <li className={`org-branch${workers.length ? ' org-two-columns' : ''}`}>
    <section aria-label={`${department.name} 부서`}>
      <article className="org-node org-department">
        <div className="org-department-info"><h2><button type="button" className="org-collapse" title={department.name} aria-label={`${department.name} ${collapsed ? '펼치기' : '접기'}`} aria-expanded={!collapsed} aria-controls={peopleId} onClick={() => setCollapsed(value => !value)}>{collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}<span>{department.name}</span></button></h2><p className="org-department-project" title={project?.path}>{project?.name || '소스 프로젝트 없음'}</p></div>
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
  const [zoom, setZoom] = useState(100);
  const canvas = useRef(null);
  const stage = useRef(null);
  const tree = useRef(null);
  const layout = useRef(null);
  const detail = zoom < 60 ? 'overview' : zoom < 85 ? 'compact' : 'full';
  const detailLabel = detail === 'overview' ? '이름 보기' : detail === 'compact' ? '요약 보기' : '상세 보기';
  useLayoutEffect(() => {
    const element = canvas.current;
    const space = stage.current;
    const content = tree.current;
    function updateLayout() {
      const previous = layout.current;
      const keepPosition = previous?.departmentId === departmentId;
      const center = keepPosition ? (element.scrollLeft + previous.viewportWidth / 2) / previous.width : .5;
      const top = keepPosition ? element.scrollTop / previous.height : 0;
      space.style.width = `${Math.ceil(content.offsetWidth * zoom / 100)}px`;
      space.style.height = `${Math.ceil(content.offsetHeight * zoom / 100)}px`;
      const width = space.offsetWidth;
      const height = space.offsetHeight;
      element.scrollLeft = width * center - element.clientWidth / 2;
      element.scrollTop = height * top;
      layout.current = { departmentId, width, height, viewportWidth: element.clientWidth };
    }
    updateLayout();
    const observer = new ResizeObserver(updateLayout);
    observer.observe(content);
    observer.observe(element);
    return () => observer.disconnect();
  }, [departmentId, zoom]);
  useEffect(() => {
    const element = canvas.current;
    const onWheel = event => {
      if ((!event.ctrlKey && !event.metaKey) || !event.deltaY) return;
      event.preventDefault();
      setZoom(value => clampZoom(value + (event.deltaY < 0 ? 5 : -5)));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);
  function resetZoom() {
    layout.current = null;
    setZoom(100);
    canvas.current.scrollLeft = (stage.current.offsetWidth - canvas.current.clientWidth) / 2;
    canvas.current.scrollTop = 0;
  }
  function onCanvasKeyDown(event) {
    if (event.target !== event.currentTarget) return;
    if (['+', '=', '-'].includes(event.key)) {
      event.preventDefault();
      setZoom(value => clampZoom(value + (event.key === '-' ? -10 : 10)));
    } else if (event.key === '0') {
      event.preventDefault();
      resetZoom();
    }
  }
  function addDepartment() {
    setDepartmentId('all');
    open('department');
  }
  const ceo = data.members.find(member => member.role === 'ceo');
  const departments = data.departments.filter(department => departmentId === 'all' || department.id === departmentId);
  useEffect(() => {
    if (departmentId !== 'all' && !data.departments.some(department => department.id === departmentId)) setDepartmentId('all');
  }, [data.departments, departmentId]);
  const people = data.members.filter(member => member.role !== 'ceo');
  return <div className="page organization-page">
    <div className="page-heading"><div><p className="eyebrow">ORGANIZATION / COMMAND STRUCTURE</p><h1>AI 조직도</h1><p>TARS 아래에 부서를 만들고, 팀장과 팀원을 연결하세요.</p></div><button className="button primary" onClick={addDepartment}><Plus size={16} />부서 추가</button></div>
    <div className="org-toolbar"><div className="org-summary"><Network size={17} /><span>CEO <b>1</b></span><span>부서 <b>{data.departments.length}</b></span><span>팀장 <b>{people.filter(member => member.role === 'leader').length}</b></span><span>팀원 <b>{people.filter(member => member.role === 'member').length}</b></span></div><div className="org-view-controls">
      <select className="compact-select" aria-label="조직도 부서 필터" value={departmentId} onChange={event => setDepartmentId(event.target.value)}><option value="all">전체 조직</option>{data.departments.map(department => <option key={department.id} value={department.id}>{department.name}</option>)}</select>
      <div className="org-zoom-controls" role="group" aria-label="조직도 확대·축소">
        <button type="button" className="icon-button" aria-label="조직도 축소" title="축소" disabled={zoom <= MIN_ZOOM} onClick={() => setZoom(value => clampZoom(value - 10))}><Minus size={16} /></button>
        <input type="range" aria-label="조직도 배율" aria-valuetext={`${zoom}% · ${detailLabel}`} min={MIN_ZOOM} max={MAX_ZOOM} step={5} value={zoom} onChange={event => setZoom(Number(event.target.value))} />
        <button type="button" className="icon-button" aria-label="조직도 확대" title="확대" disabled={zoom >= MAX_ZOOM} onClick={() => setZoom(value => clampZoom(value + 10))}><Plus size={16} /></button>
        <output className="org-zoom-value" aria-live="polite">{zoom}%</output>
        <button type="button" className="icon-button" aria-label="조직도 배율 초기화" title="100%로 초기화" onClick={resetZoom}><RotateCcw size={14} /></button>
      </div>
      <span className="org-detail-label" role="status">{detailLabel}</span>
    </div></div>
    <p className="org-instructions" id="org-instructions">축소하면 이름 중심의 도식으로, 확대하면 모델·추론·설정까지 표시됩니다. Ctrl/⌘ + 휠로 배율을 조절하고, 스크롤로 조직도를 이동하세요.</p>
    <div className="org-canvas" ref={canvas} role="region" aria-label="TARS AI 조직도" aria-describedby="org-instructions" tabIndex={0} onKeyDown={onCanvasKeyDown}>
      <div className="org-stage" ref={stage}>
        <div className={`org-tree${departments.length ? '' : ' org-empty'}`} ref={tree} data-detail={detail} style={{ '--org-scale': zoom / 100 }}>
          <div className="org-root">{ceo ? <AiNode member={ceo} executive /> : <div className="org-node">TARS를 준비하고 있습니다.</div>}</div>
          <ul className="org-departments" aria-label="TARS 산하 부서">
            {departments.map(department => <DepartmentBranch key={department.id} department={department} />)}
          </ul>
        </div>
      </div>
    </div>
  </div>;
}
