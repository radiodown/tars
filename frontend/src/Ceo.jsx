import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Command, Settings2, ShieldCheck } from 'lucide-react';
import { useWorkspace } from './App';
import { number, providerLabel } from './api';
import { Badge, Dialog, Field, Submit } from './ui';
import { ModelFields } from './ModelFields';
import { CeoChat } from './CeoChat';
import { TeamConsole } from './SessionTerminal';

const CONSOLE_VIEW_KEY = 'tars:ceo-console-view';
const CONSOLE_VIEWS = [['normal', '기본'], ['compact', '축소'], ['collapsed', '접기']];

export function CeoCard({ office = false }) {
  const { data, open } = useWorkspace();
  const ceo = data.members.find(member => member.role === 'ceo');
  if (!ceo) return null;
  return <section className="ceo-card" aria-label="전체 부서의 상위 CEO TARS">
    <div className="ceo-identity"><span className="ceo-emblem"><Command size={28} /></span><div><p className="ceo-kicker">CHIEF EXECUTIVE AI</p><div className="ceo-name"><h2>TARS</h2><Badge status={ceo.status} /></div><p className="ceo-description">전체 프로젝트의 진행과 부서 간 업무를 총괄합니다.</p><span className="ceo-model">{providerLabel(ceo)} · {ceo.model || 'CLI 기본 모델'} · {ceo.reasoning === 'default' ? '기본' : ceo.reasoning} 추론</span></div></div>
    <div className="ceo-scope"><div><small>관할 부서</small><strong>{number(data.departments.length)}</strong></div><div><small>프로젝트</small><strong>{number(data.projects.length)}</strong></div></div>
    <div className="ceo-actions">{!office && <Link to="/ceo" className="button primary">TARS 상황실<ArrowUpRight size={15} /></Link>}{ceo.currentSessionId && <button className="button secondary" onClick={() => open('sessionDetail', { id: ceo.currentSessionId })}>현재 세션<ArrowUpRight size={14} /></button>}<button className="button secondary" disabled={ceo.status === 'running'} onClick={() => open('ceoSettings')}><Settings2 size={14} />TARS 설정</button></div>
  </section>;
}

export function CeoOffice() {
  const [consoleView, setConsoleView] = useState(() => {
    try {
      const saved = localStorage.getItem(CONSOLE_VIEW_KEY);
      if (CONSOLE_VIEWS.some(([value]) => value === saved)) return saved;
    } catch { /* The view can still be changed without browser storage. */ }
    return 'normal';
  });
  function changeConsoleView(value) {
    setConsoleView(value);
    try { localStorage.setItem(CONSOLE_VIEW_KEY, value); } catch { /* Optional persistence. */ }
  }
  const collapsed = consoleView === 'collapsed';
  return <div className="page ceo-office">
    <div className="page-heading"><div><p className="eyebrow">EXECUTIVE CONTROL</p><h1>TARS 상황실</h1><p>TARS와 대화하고, 팀이 수행 중인 작업을 CLI로 확인하세요.</p></div>
      <div className="ceo-console-controls"><span id="ceo-console-view-label">팀원 CLI</span><div className="segmented" role="group" aria-labelledby="ceo-console-view-label">
        {CONSOLE_VIEWS.map(([value, label]) => <button key={value} type="button" className={consoleView === value ? 'selected' : ''} aria-pressed={consoleView === value} aria-controls="ceo-team-console" onClick={() => changeConsoleView(value)}>{label}</button>)}
      </div></div>
    </div>
    <div className="ceo-command-grid" data-console-view={consoleView}><CeoChat /><div className="ceo-console-panel" id="ceo-team-console" hidden={collapsed}><TeamConsole compact visible={!collapsed} /></div></div>
  </div>;
}

export function CeoSettings() {
  const { data, close, perform, busy } = useWorkspace();
  const ceo = data.members.find(member => member.role === 'ceo');
  const [error, setError] = useState('');
  if (!ceo) return null;
  async function save(event) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try { await perform('/ceo', 'PATCH', values, 'TARS 설정을 저장했습니다.'); close(); }
    catch (issue) { setError(issue.message); }
  }
  return <Dialog title="TARS 설정" subtitle="이름과 CEO 역할은 고정이며, 사용할 AI와 업무 지침을 설정할 수 있습니다." onClose={close}>
    <div className="ceo-fixed-identity"><ShieldCheck size={21} /><strong>TARS</strong><span>CEO · 전체 부서 상위</span></div>
    <form onSubmit={save}><ModelFields initial={ceo} />
      <Field label="CEO 업무 지침"><textarea name="instructions" rows={6} maxLength={20000} defaultValue={ceo.instructions} placeholder="보고 주안점, 프로젝트 우선순위와 판단 기준을 적어주세요." /></Field>
      {error && <p className="form-error" role="alert">{error}</p>}<div className="form-footer"><button type="button" className="button secondary" onClick={close}>닫기</button><Submit busy={busy || ceo.status === 'running'} /></div>
    </form>
  </Dialog>;
}
