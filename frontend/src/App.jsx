import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Route, Routes, useLocation, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Bell, Check, CircleHelp, Menu, Moon, Settings, Sun, X } from 'lucide-react';
import { api } from './api';
import { Dashboard, Organization, Tasks, Sessions, Consultation, Library, Usage, Preferences } from './pages.jsx';
import { EntityForm, TaskDetail, SessionDetail } from './forms.jsx';
import { CeoOffice, CeoSettings } from './Ceo.jsx';
import { Projects } from './Projects.jsx';
import { RequestFlow } from './RequestFlow.jsx';
import { FloatingUsage } from './FloatingUsage.jsx';
import { navigation, orderedNavigation } from './navigation';
import { Inbox } from './Inbox';
import { inboxItems, inboxStorageKey, isInboxDismissed, readInboxDismissals } from './inbox-items';
import { RunHistory } from './RunHistory';

const Workspace = createContext(null);
export const useWorkspace = () => useContext(Workspace);

function WorkspaceNavigation({ data, inboxCount, onNavigate }) {
  return <nav aria-label="주 메뉴" onClick={event => { if (event.target.closest('a')) onNavigate?.(); }}>
    {orderedNavigation(data?.settings.menuOrder).map(([path, label, Icon]) => {
      const inboxLabel = path === '/inbox' && inboxCount ? `${label} ${inboxCount}건` : label;
      return <NavLink end={path === '/'} to={path} key={path} aria-label={inboxLabel} title={inboxLabel} className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
        <Icon size={18} strokeWidth={1.7} /><span>{label}</span>
        {path === '/inbox' && inboxCount > 0 && <small className="inbox-count">{inboxCount}</small>}
        {path === '/tasks' && data?.tasks.length > 0 && <small>{data.tasks.filter(t => !['done', 'cancelled'].includes(t.status)).length}</small>}
      </NavLink>;
    })}
    <NavLink to="/settings" aria-label="설정 및 연결" title="설정 및 연결" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}><Settings size={18} strokeWidth={1.7} /><span>설정 및 연결</span></NavLink>
  </nav>;
}

export default function App() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['workspace'], queryFn: () => api('/state'), refetchInterval: 15000, refetchIntervalInBackground: false });
  const [connected, setConnected] = useState(false);
  const [modal, setModal] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [inboxDismissals, setInboxDismissals] = useState(readInboxDismissals);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const navigationDialog = useRef(null);
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  const location = useLocation();
  useEffect(() => {
    const syncInbox = event => {
      if (event.key === inboxStorageKey || event.key === null) setInboxDismissals(readInboxDismissals(event.newValue));
    };
    window.addEventListener('storage', syncInbox);
    return () => window.removeEventListener('storage', syncInbox);
  }, []);
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
    stream.addEventListener('session-progress', event => {
      const session = JSON.parse(event.data);
      client.setQueryData(['workspace'], current => current ? { ...current, sessions: current.sessions.map(item => item.id === session.id ? { ...item, ...session } : item) } : current);
      client.invalidateQueries({ queryKey: ['record', 'sessions', session.id] });
    });
    return () => stream.close();
  }, [client]);
  useEffect(() => { setNavigationOpen(false); }, [location.pathname]);
  useEffect(() => {
    if (!navigationOpen) return;
    const dialog = navigationDialog.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    const media = window.matchMedia('(max-width: 767px)');
    const closeOnDesktop = () => { if (!media.matches) setNavigationOpen(false); };
    media.addEventListener('change', closeOnDesktop);
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      media.removeEventListener('change', closeOnDesktop);
    };
  }, [navigationOpen]);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const resize = () => {
      if (viewport.scale === 1) document.documentElement.style.setProperty('--viewport-height', `${viewport.height}px`);
    };
    resize();
    viewport.addEventListener('resize', resize);
    return () => { viewport.removeEventListener('resize', resize); document.documentElement.style.removeProperty('--viewport-height'); };
  }, []);
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
  const open = async (type, initial = {}) => {
    try {
      const kind = type === 'document' ? 'documents' : type === 'sessionDetail' ? 'sessions' : null;
      const record = kind && initial.id ? await api(`/records/${kind}/${initial.id}`) : initial;
      setModal({ type, initial: record });
    } catch (error) { setNotice({ error: true, message: error.message }); }
  };
  const fire = (...args) => perform(...args).catch(() => {});
  const data = query.data;
  const entries = useMemo(() => inboxItems(data), [data]);
  const inboxCount = entries.filter(item => item.category === 'action' && !isInboxDismissed(item, inboxDismissals)).length;
  function changeInboxDismissal(item, dismissed) {
    const next = { ...inboxDismissals };
    if (dismissed) next[item.id] = item.revision;
    else delete next[item.id];
    setInboxDismissals(next);
    const message = dismissed ? '확인 목록에서 삭제했습니다.' : '확인 목록으로 복원했습니다.';
    try {
      localStorage.setItem(inboxStorageKey, JSON.stringify(next));
      setNotice({ message });
    } catch {
      setNotice({ error: true, message: '브라우저에 알림 변경을 저장하지 못했습니다.' });
    }
  }
  const inbox = <Inbox items={entries} dismissals={inboxDismissals} changeDismissal={changeInboxDismissal} />;
  const currentTitle = navigation.find(([path]) => path === location.pathname)?.[1]
    || ({ '/': '확인할 일', '/runs': '실행 기록', '/usage': '사용량' }[location.pathname] || '설정');
  return <Workspace.Provider value={{ data, open, perform, fire, busy, notice, close: () => setModal(null) }}>
    <div className="app-shell">
      <aside className="sidebar">
        <NavLink to="/ceo" className="brand" aria-label="TARS 홈"><strong className="brand-wordmark">TARS</strong></NavLink>
        <p className="nav-label">WORKSPACE</p>
        <WorkspaceNavigation data={data} inboxCount={inboxCount} />
      </aside>
      <div className="main-shell">
        <header className="topbar"><div className="topbar-location"><button className="icon-button mobile-menu-toggle" type="button" aria-label="전체 메뉴 열기" aria-haspopup="dialog" aria-controls="mobile-navigation" aria-expanded={navigationOpen} onClick={() => setNavigationOpen(true)}><Menu size={22} /></button><div className="breadcrumb"><span className="breadcrumb-parent">Workspace <span>/</span></span><strong>{currentTitle}</strong></div></div><div className="topbar-actions">
          {data && <NavLink className="inbox-alert" to="/inbox" aria-label={inboxCount ? `확인할 일 ${inboxCount}건` : '확인할 일'}>
            <Bell size={16} /><span>확인할 일</span>{inboxCount > 0 && <strong className="inbox-count">{inboxCount}</strong>}
          </NavLink>}
          <span className={`connection ${connected && !query.isError ? 'online' : ''}`}><span className="status-dot" />{connected && !query.isError ? '실시간 연결' : '연결 확인 중'}</span>
          <button className="icon-button theme-toggle" type="button" title={theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환'} aria-label={theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환'} onClick={() => setTheme(current => current === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}</button>
        </div></header>
        {query.isError && data && <div className="connection-warning">서버에 연결하지 못했습니다. 마지막으로 받은 정보를 표시합니다.</div>}
        <main>{!data ? <div className="loading-state"><Activity size={32} /><h2>{query.isError ? '서버에 연결할 수 없습니다' : '작업 공간을 준비하고 있습니다'}</h2><p>{query.isError ? '백엔드 실행 상태를 확인한 뒤 다시 연결하세요.' : '팀과 작업 현황을 불러오는 중입니다.'}</p>{query.isError && <button className="button primary" onClick={() => query.refetch()}>다시 연결</button>}</div> : <Routes>
          <Route path="/ceo" element={<CeoOffice />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/requests" element={<WorkHub />} />
          <Route path="/inbox" element={inbox} />
          <Route path="/runs" element={<RunHistory />} />
          <Route path="/" element={inbox} /><Route path="/workspace" element={<Dashboard />} /><Route path="/organization" element={<OrganizationHub />} /><Route path="/tasks" element={<Tasks />} /><Route path="/sessions" element={<Sessions />} /><Route path="/consult" element={<Consultation />} /><Route path="/library" element={<Library />} /><Route path="/usage" element={<Usage />} /><Route path="/settings" element={<Preferences />} /><Route path="*" element={inbox} />
        </Routes>}</main>
      </div>
    </div>
    <dialog id="mobile-navigation" className="mobile-navigation" ref={navigationDialog} aria-label="전체 메뉴" onCancel={event => { event.preventDefault(); setNavigationOpen(false); }} onClick={event => { if (event.target === event.currentTarget) setNavigationOpen(false); }}>
      <header className="mobile-navigation-head"><NavLink to="/ceo" className="brand" aria-label="TARS 홈" onClick={() => setNavigationOpen(false)}><strong className="brand-wordmark">TARS</strong></NavLink><button className="icon-button" type="button" aria-label="메뉴 닫기" onClick={() => setNavigationOpen(false)}><X size={22} /></button></header>
      <WorkspaceNavigation data={data} inboxCount={inboxCount} onNavigate={() => setNavigationOpen(false)} />
    </dialog>
    <FloatingUsage disabled={!data} />
    {notice && <div className={`toast ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.error ? <CircleHelp size={19} /> : <Check size={19} />}<span>{notice.message}</span><button aria-label="알림 닫기" onClick={() => setNotice(null)}><X size={16} /></button></div>}
    {modal && data && (modal.type === 'ceoSettings' ? <CeoSettings /> : modal.type === 'taskDetail' ? <TaskDetail taskId={modal.initial.id} /> : modal.type === 'sessionDetail' ? <SessionDetail sessionId={modal.initial.id} /> : <EntityForm key={`${modal.type}-${modal.initial.id || 'new'}`} type={modal.type} initial={modal.initial} />)}
  </Workspace.Provider>;
}

function WorkHub() {
  const [params, setParams] = useSearchParams();
  const tasks = params.get('view') === 'tasks' && !params.has('request');
  function showTasks(show) {
    const next = new URLSearchParams(params);
    if (show) { next.set('view', 'tasks'); next.delete('request'); }
    else next.delete('view');
    setParams(next);
  }
  return <><div className="work-hub-tabs" role="group" aria-label="업무 보기">
    <button type="button" aria-pressed={!tasks} onClick={() => { if (tasks) showTasks(false); }}>업무 목록</button>
    <button type="button" aria-pressed={tasks} onClick={() => { if (!tasks) showTasks(true); }}>작업 기록</button>
  </div>{tasks ? <Tasks /> : <RequestFlow />}</>;
}
function OrganizationHub() {
  const [tab, setTab] = useState('members');
  return <><div className="editor-tabs" aria-label="조직과 프로젝트"><button type="button" onClick={() => setTab('members')}>AI 조직</button><button type="button" onClick={() => setTab('projects')}>소스 프로젝트</button><NavLink to="/workspace">워크스페이스 현황</NavLink></div>{tab === 'members' ? <Organization /> : <Projects />}</>;
}
