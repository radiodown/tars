import { createContext, useContext, useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, ArrowUpRight, Boxes, Check, ChevronDown, CircleHelp, Command, FileText, Gauge, LayoutDashboard, ListTodo, MessageSquare, Plus, Radio, RefreshCw, Settings, Users, X } from 'lucide-react';
import { api } from './api';
import { Dashboard, Organization, Tasks, Sessions, Consultation, Library, Usage, Preferences } from './pages.jsx';
import { EntityForm, TaskDetail, SessionDetail } from './forms.jsx';

const Workspace = createContext(null);
export const useWorkspace = () => useContext(Workspace);
const navigation = [
  ['/', '워크스페이스', LayoutDashboard], ['/organization', 'AI 조직', Users], ['/consult', '팀장과 협의', MessageSquare],
  ['/tasks', '작업 보드', ListTodo], ['/sessions', '실행 세션', Radio], ['/library', '문서 & 스킬', FileText], ['/usage', '사용량', Gauge],
];

export default function App() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['workspace'], queryFn: () => api('/state'), refetchInterval: 15000, refetchIntervalInBackground: false });
  const [connected, setConnected] = useState(false);
  const [modal, setModal] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const location = useLocation();
  useEffect(() => {
    const stream = new EventSource('/api/events');
    stream.onopen = () => setConnected(true);
    stream.onerror = () => setConnected(false);
    stream.onmessage = () => client.invalidateQueries({ queryKey: ['workspace'] });
    return () => stream.close();
  }, [client]);
  useEffect(() => { setMenu(false); }, [location.pathname]);
  useEffect(() => {
    if (!notice || notice.error) return;
    const timer = setTimeout(() => setNotice(null), 4500);
    return () => clearTimeout(timer);
  }, [notice]);
  async function perform(path, method, body, message = '저장했습니다.') {
    setBusy(true);
    try {
      const result = await api(path, method, body);
      await client.invalidateQueries({ queryKey: ['workspace'] });
      setNotice({ message });
      return result;
    } catch (error) {
      setNotice({ error: true, message: error.message });
      throw error;
    } finally { setBusy(false); }
  }
  const open = (type, initial = {}) => { setMenu(false); setModal({ type, initial }); };
  const fire = (...args) => perform(...args).catch(() => {});
  const data = query.data;
  const active = data?.members.filter(m => m.status === 'running').length || 0;
  const currentTitle = navigation.find(([path]) => path === location.pathname)?.[1] || '설정';
  return <Workspace.Provider value={{ data, open, perform, fire, busy, notice, close: () => setModal(null) }}>
    <div className="app-shell">
      <aside className="sidebar">
        <NavLink to="/" className="brand"><span className="brand-mark"><span /></span><strong>Tars<span className="brand-dot">.</span></strong></NavLink>
        <div className="workspace-switch"><span className="workspace-icon"><Boxes size={17} /></span><div><strong>My workspace</strong><small>Personal AI team</small></div><ChevronDown size={14} /></div>
        <p className="nav-label">WORKSPACE</p>
        <nav aria-label="주 메뉴">{navigation.map(([path, label, Icon]) => <NavLink end={path === '/'} to={path} key={path} className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}><Icon size={18} strokeWidth={1.7} /><span>{label}</span>{path === '/tasks' && data?.tasks.length > 0 && <small>{data.tasks.filter(t => !['done', 'cancelled'].includes(t.status)).length}</small>}</NavLink>)}</nav>
        <div className="sidebar-bottom"><div className="team-pulse"><span className={`status-dot ${active ? 'live' : ''}`} /><strong>{active ? `${active}개의 AI가 작업 중` : '새로운 작업을 기다리는 중'}</strong><p>함께 생각하고, 나누어 실행하세요.</p></div>
          <NavLink to="/settings" className="nav-link"><Settings size={18} />설정 및 연결</NavLink>
          <div className="owner"><span>H</span><div><strong>My workspace</strong><small>개인 작업 공간</small></div><span className="local-tag">LOCAL</span></div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar"><div className="breadcrumb">Workspace <span>/</span> <strong>{currentTitle}</strong></div><div className="topbar-actions">
          <span className={`connection ${connected && !query.isError ? 'online' : ''}`}><span className="status-dot" />{connected && !query.isError ? '실시간 연결' : '연결 확인 중'}</span>
          <button className="icon-button" title="새로고침" aria-label="새로고침" onClick={() => query.refetch()}><RefreshCw size={16} className={query.isFetching ? 'spin' : ''} /></button>
          <div className="create-menu"><button className="button dark" aria-expanded={menu} onClick={() => setMenu(!menu)}><Plus size={17} />새로 만들기<ChevronDown size={13} /></button>{menu && <><button className="menu-scrim" aria-label="메뉴 닫기" onClick={() => setMenu(false)} /><div className="dropdown">{[['department', '부서 만들기', Users], ['member', 'AI 팀원 추가', Command], ['task', '작업 만들기', ListTodo], ['document', '문서 작성', FileText], ['project', '프로젝트 등록', Boxes]].map(([type, label, Icon]) => <button key={type} onClick={() => open(type)}><Icon size={16} />{label}</button>)}</div></>}</div>
        </div></header>
        {query.isError && data && <div className="connection-warning">서버에 연결하지 못했습니다. 마지막으로 받은 정보를 표시합니다.</div>}
        <main>{!data ? <div className="loading-state"><Activity size={32} /><h2>{query.isError ? '서버에 연결할 수 없습니다' : '작업 공간을 준비하고 있습니다'}</h2><p>{query.isError ? '백엔드 실행 상태를 확인한 뒤 다시 연결하세요.' : '팀과 작업 현황을 불러오는 중입니다.'}</p>{query.isError && <button className="button primary" onClick={() => query.refetch()}>다시 연결</button>}</div> : <Routes>
          <Route path="/" element={<Dashboard />} /><Route path="/organization" element={<Organization />} /><Route path="/tasks" element={<Tasks />} /><Route path="/sessions" element={<Sessions />} /><Route path="/consult" element={<Consultation />} /><Route path="/library" element={<Library />} /><Route path="/usage" element={<Usage />} /><Route path="/settings" element={<Preferences />} /><Route path="*" element={<Dashboard />} />
        </Routes>}</main>
        <footer className="app-footer"><span><span className="brand-mini">T</span> Tars · Your team, amplified.</span><span>개인 작업 공간 <span className="footer-dot">·</span> v0.1</span></footer>
      </div>
    </div>
    {notice && <div className={`toast ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.error ? <CircleHelp size={19} /> : <Check size={19} />}<span>{notice.message}</span><button aria-label="알림 닫기" onClick={() => setNotice(null)}><X size={16} /></button></div>}
    {modal && data && (modal.type === 'taskDetail' ? <TaskDetail taskId={modal.initial.id} /> : modal.type === 'sessionDetail' ? <SessionDetail sessionId={modal.initial.id} /> : <EntityForm key={`${modal.type}-${modal.initial.id || 'new'}`} type={modal.type} initial={modal.initial} />)}
  </Workspace.Provider>;
}
