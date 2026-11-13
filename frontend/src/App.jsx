import { createContext, useContext, useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Check, CircleHelp, Moon, Settings, Sun, X } from 'lucide-react';
import { api } from './api';
import { Dashboard, Organization, Tasks, Sessions, Consultation, Library, Usage, Preferences } from './pages.jsx';
import { EntityForm, TaskDetail, SessionDetail } from './forms.jsx';
import { CeoOffice, CeoSettings } from './Ceo.jsx';
import { Projects } from './Projects.jsx';
import { FloatingCreate } from './FloatingCreate.jsx';
import { navigation, orderedNavigation } from './navigation';

const Workspace = createContext(null);
export const useWorkspace = () => useContext(Workspace);

export default function App() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['workspace'], queryFn: () => api('/state'), refetchInterval: 15000, refetchIntervalInBackground: false });
  const [connected, setConnected] = useState(false);
  const [modal, setModal] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  const location = useLocation();
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'dark' ? '#080808' : '#f7f7f7';
    try { localStorage.setItem('tars:theme', theme); } catch { /* Switching still works without storage. */ }
  }, [theme]);
  useEffect(() => {
    const syncTheme = event => {
      if (event.key === 'tars:theme' || event.key === null) setTheme(event.newValue === 'light' ? 'light' : 'dark');
    };
    window.addEventListener('storage', syncTheme);
    return () => window.removeEventListener('storage', syncTheme);
  }, []);
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
  const currentTitle = navigation.find(([path]) => path === location.pathname)?.[1] || '설정';
  return <Workspace.Provider value={{ data, open, perform, fire, busy, notice, close: () => setModal(null) }}>
    <div className="app-shell">
      <aside className="sidebar">
        <NavLink to="/" className="brand" aria-label="TARS 홈"><strong className="brand-wordmark">TARS</strong></NavLink>
        <p className="nav-label">WORKSPACE</p>
        <nav aria-label="주 메뉴">
          {orderedNavigation(data?.settings.menuOrder).map(([path, label, Icon]) => <NavLink end={path === '/'} to={path} key={path} className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}><Icon size={18} strokeWidth={1.7} /><span>{label}</span>{path === '/tasks' && data?.tasks.length > 0 && <small>{data.tasks.filter(t => !['done', 'cancelled'].includes(t.status)).length}</small>}</NavLink>)}
          <NavLink to="/settings" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}><Settings size={18} strokeWidth={1.7} /><span>설정 및 연결</span></NavLink>
        </nav>
      </aside>
      <div className="main-shell">
        <header className="topbar"><div className="breadcrumb">Workspace <span>/</span> <strong>{currentTitle}</strong></div><div className="topbar-actions">
          <span className={`connection ${connected && !query.isError ? 'online' : ''}`}><span className="status-dot" />{connected && !query.isError ? '실시간 연결' : '연결 확인 중'}</span>
          <button className="icon-button theme-toggle" type="button" title={theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환'} aria-label={theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환'} onClick={() => setTheme(current => current === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}</button>
        </div></header>
        {query.isError && data && <div className="connection-warning">서버에 연결하지 못했습니다. 마지막으로 받은 정보를 표시합니다.</div>}
        <main>{!data ? <div className="loading-state"><Activity size={32} /><h2>{query.isError ? '서버에 연결할 수 없습니다' : '작업 공간을 준비하고 있습니다'}</h2><p>{query.isError ? '백엔드 실행 상태를 확인한 뒤 다시 연결하세요.' : '팀과 작업 현황을 불러오는 중입니다.'}</p>{query.isError && <button className="button primary" onClick={() => query.refetch()}>다시 연결</button>}</div> : <Routes>
          <Route path="/ceo" element={<CeoOffice />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/" element={<Dashboard />} /><Route path="/organization" element={<Organization />} /><Route path="/tasks" element={<Tasks />} /><Route path="/sessions" element={<Sessions />} /><Route path="/consult" element={<Consultation />} /><Route path="/library" element={<Library />} /><Route path="/usage" element={<Usage />} /><Route path="/settings" element={<Preferences />} /><Route path="*" element={<Dashboard />} />
        </Routes>}</main>
      </div>
    </div>
    <FloatingCreate expanded={menu} onOpenChange={setMenu} onCreate={open} disabled={!data} />
    {notice && <div className={`toast ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.error ? <CircleHelp size={19} /> : <Check size={19} />}<span>{notice.message}</span><button aria-label="알림 닫기" onClick={() => setNotice(null)}><X size={16} /></button></div>}
    {modal && data && (modal.type === 'ceoSettings' ? <CeoSettings /> : modal.type === 'taskDetail' ? <TaskDetail taskId={modal.initial.id} /> : modal.type === 'sessionDetail' ? <SessionDetail sessionId={modal.initial.id} /> : <EntityForm key={`${modal.type}-${modal.initial.id || 'new'}`} type={modal.type} initial={modal.initial} />)}
  </Workspace.Provider>;
}
