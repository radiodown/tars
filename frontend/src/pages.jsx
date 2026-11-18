import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowUpRight, Command, FileText, GitBranch, Plus, Search, Settings2, ShieldCheck, Sparkles, Trash2, Zap } from 'lucide-react';
import { useWorkspace } from './App';
import { isLive, kindLabels, time } from './api';
export { Usage } from './Usage';
import { Avatar, Badge, Dialog, Empty, Field, Submit } from './ui';
import { MenuOrderSettings } from './MenuOrderSettings';
import { KnowledgeExplorer } from './KnowledgeExplorer';
export { Organization } from './Organization';
export { Sessions } from './SessionTerminal';
import { TeamConsole } from './SessionTerminal';
import { TeamStatus } from './TeamStatus';
export { Dashboard } from './WorkspaceMonitor';

function Heading({ eyebrow, title, description, action }) {
  return <div className="page-heading"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div>;
}

function DeleteTask({ task, running, onClose }) {
  const { perform } = useWorkspace();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  function close() { if (!inFlight.current) onClose(); }
  async function submit(event) {
    event.preventDefault();
    if (inFlight.current || running) return;
    inFlight.current = true;
    setDeleting(true);
    setError('');
    try {
      await perform(`/tasks/${task.id}`, 'DELETE', undefined, '작업 기록을 삭제했습니다.');
      onClose();
    } catch (issue) {
      setError(issue.message);
      inFlight.current = false;
      setDeleting(false);
    }
  }
  const unfinished = !['done', 'cancelled'].includes(task.status);
  return <Dialog title="작업 기록 삭제" subtitle={task.title} onClose={close}>
    <form onSubmit={submit}>
      {running ? <p className="work-delete-copy">관련 실행이 끝나거나 중지되면 삭제할 수 있습니다.</p>
        : <p className="work-delete-copy">칸반에서 이 작업을 삭제합니다. {unfinished && '미완료 작업과 대기 중인 검토는 취소됩니다. '}저장된 실행 기록과 결과는 보관됩니다.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-footer">
        <button className="button secondary" type="button" disabled={deleting} onClick={close}>취소</button>
        <button className="button secondary work-delete" type="submit" disabled={deleting || running}>{deleting ? '삭제 중' : '삭제'}</button>
      </div>
    </form>
  </Dialog>;
}

export function Tasks() {
  const { data, open, busy } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const project = params.get('project') || 'all';
  const [search, setSearch] = useState('');
  const [department, setDepartment] = useState('all');
  const [cancelled, setCancelled] = useState(false);
  const [deleteId, setDeleteId] = useState(null);
  const deleteTask = data.tasks.find(task => task.id === deleteId && !task.deletedAt);
  const running = deleteTask && (deleteTask.status === 'running'
    || data.sessions.some(session => session.taskId === deleteTask.id && isLive(session.status)));
  const filtered = data.tasks.filter(task => !task.deletedAt && (cancelled || task.status !== 'cancelled')
    && (department === 'all' || task.departmentId === department)
    && (project === 'all' || (project === 'none' ? !task.projectId : task.projectId === project))
    && task.title.toLowerCase().includes(search.toLowerCase()));
  const columns = [['예정된 작업', ['draft', 'assigned', 'queued'], 'planned'], ['진행 중', ['running'], 'running'], ['검토 대기', ['review'], 'review'], ['완료', ['done'], 'done'], ['차단됨', ['blocked'], 'blocked']];
  if (cancelled) columns.push(['취소됨', ['cancelled'], 'cancelled']);
  function changeProject(event) {
    const next = new URLSearchParams(params);
    if (event.target.value === 'all') next.delete('project');
    else next.set('project', event.target.value);
    setParams(next, { replace: true });
  }
  return <div className="page"><Heading title="작업 기록" />
    <div className="toolbar">
      <div className="search-input"><Search size={17} /><input type="search" aria-label="작업 검색" placeholder="작업 검색…" value={search} onChange={event => setSearch(event.target.value)} /></div>
      <select className="compact-select" aria-label="부서 필터" value={department} onChange={event => setDepartment(event.target.value)}>
        <option value="all">모든 부서</option>{data.departments.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
      <select className="compact-select" aria-label="프로젝트 필터" value={project} onChange={changeProject}>
        <option value="all">모든 프로젝트</option><option value="none">프로젝트 미지정</option>
        {data.projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
      <label className="checkbox-label"><input type="checkbox" checked={cancelled} onChange={event => setCancelled(event.target.checked)} />취소 작업 포함</label>
      <span className="toolbar-count">{filtered.length}건</span>
    </div>
    <div className="kanban">{columns.map(([title, states, status]) => {
      const tasks = filtered.filter(task => states.includes(task.status));
      return <section className="kanban-column" key={status}>
        <header><span className={`column-dot ${status}`} /><h2>{title}</h2><span>{tasks.length}</span></header>
        <div className="kanban-items">{tasks.map(task => {
          const member = data.members.find(item => item.id === task.assigneeId);
          return <article className="kanban-card" key={task.id}>
            <button className="task-card" type="button" onClick={() => open('taskDetail', task)}>
              <div className="task-card-top"><span className="task-id">TSK-{task.id.slice(0, 4).toUpperCase()}</span><span className={`priority ${task.priority}`}>{task.priority === 'high' ? '높음' : task.priority === 'low' ? '낮음' : '보통'}</span></div>
              <h3>{task.title}</h3>
              {task.description && <p>{task.description}</p>}
              {task.error && <span className="task-error">{task.error}</span>}
              <div className="task-card-meta"><span><GitBranch size={13} />{task.dependsOn?.length ? `선행 작업 ${task.dependsOn.length}` : '독립 작업'}</span>{task.status === 'queued' && <Badge status="queued" />}</div>
              <footer><span>{data.departments.find(item => item.id === task.departmentId)?.name}</span><span className="task-assignee"><Avatar member={member} />{member?.name || '미배정'}</span></footer>
            </button>
            <button className="icon-button task-card-delete" type="button" title="작업 기록 삭제" aria-label={`${task.title} 작업 기록 삭제`} disabled={busy} onClick={() => setDeleteId(task.id)}><Trash2 size={15} /></button>
          </article>;
        })}{!tasks.length && <div className="kanban-empty"><span />이 단계의 작업이 없습니다.</div>}</div>
      </section>;
    })}</div>
    {deleteTask && <DeleteTask key={deleteTask.id} task={deleteTask} running={running} onClose={() => setDeleteId(null)} />}
  </div>;
}

export function Consultation() {
  return <div className="page consultation-page"><Heading title="팀장과 협의" description="팀장 이름을 선택해 이전 협의와 작업 결과를 확인하고 대화를 이어가세요." /><TeamConsole role="leader" sidebar={leader => <TeamStatus key={leader.id} leader={leader} />} /></div>;
}

export function Library() {
  const { data, open } = useWorkspace();
  const [view, setView] = useState('explorer');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const documents = data.documents.filter(doc => (filter === 'all' || doc.kind === filter) && doc.title.toLowerCase().includes(search.toLowerCase()));
  return <div className="page"><Heading eyebrow="SHARED KNOWLEDGE" title="지침 · 문서 · 스킬" description="개인 지침과 공용 자료를 트리에서 탐색하고 내용을 확인하세요." action={<button className="button primary" onClick={() => open('document')}><Plus size={16} />문서 작성</button>} />
    <div className="library-views" role="group" aria-label="자료 보기 방식"><button type="button" aria-pressed={view === 'explorer'} onClick={() => setView('explorer')}>지침 탐색</button><button type="button" aria-pressed={view === 'documents'} onClick={() => setView('documents')}>문서 목록</button></div>
    {view === 'explorer' ? <KnowledgeExplorer /> : <><div className="toolbar library-toolbar"><div className="segmented">{[['all', '전체'], ['agreement', '협의'], ['specification', '설계'], ['report', '보고'], ['instruction', '지침'], ['skill', '스킬'], ['note', '노트']].map(([value, label]) => <button key={value} className={filter === value ? 'selected' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div><div className="search-input"><Search size={16} /><input value={search} aria-label="문서 검색" onChange={event => setSearch(event.target.value)} placeholder="문서 검색…" /></div></div>
    {documents.length ? <div className="documents-grid">{documents.map(doc => <button className="document-card" key={doc.id} onClick={() => open('document', doc)}><div className="document-top"><span className={`document-icon ${doc.kind}`}>{doc.kind === 'skill' ? <Zap size={22} /> : doc.kind === 'instruction' ? <Command size={22} /> : <FileText size={22} />}</span><span>{kindLabels[doc.kind]}</span><ArrowUpRight size={15} /></div><h3>{doc.title}</h3><p>{(doc.preview || doc.content || '').replace(/[#*`>]/g, '').slice(0, 140) || '아직 내용이 없습니다.'}</p><footer><span>{time(doc.updatedAt)}</span><strong>v{doc.version}</strong></footer></button>)}</div> : <div className="panel"><Empty title="아직 문서가 없습니다" description="직접 작성하거나 팀장과의 협의에서 문서를 만들어보세요." action={() => open('document', { kind: filter === 'all' ? 'note' : filter })} label="문서 작성" /></div>}</>}
  </div>;
}

export function Preferences() {
  const { data, perform, busy } = useWorkspace();
  async function save(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try { await perform('/settings', 'PATCH', { agentPermissionMode: form.get('agentPermissionMode'), maxConcurrent: Number(form.get('maxConcurrent')), maxSessionMinutes: Number(form.get('maxSessionMinutes')), maxReworkAttempts: Number(form.get('maxReworkAttempts')) }); } catch { /* Error toast is displayed by perform. */ }
  }
  return <div className="page"><Heading eyebrow="WORKSPACE SETTINGS" title="팀을 위한 작업 환경" description="AI 실행 도구와 동시 실행 수, 실행 시간 제한을 관리하세요." /><div className="settings-grid"><section className="panel settings-card"><div className="section-heading"><h2>AI 실행 도구</h2><Command size={18} /></div><p className="muted">서버에 설치된 CLI와 기존 인증 설정을 사용합니다.</p>{data.providers.flatMap(provider => (provider.accounts || [{ id: provider.name, installed: provider.installed }]).map(account => <div className="provider-row" key={account.id}><span className={`provider-logo ${provider.name}`}>{provider.name === 'codex' ? <Command size={21} /> : <Sparkles size={21} />}</span><div><strong>{provider.name === 'codex' ? `Codex · ${account.id}` : 'Claude Code'}</strong><small>인증 상태는 실행 시 확인</small></div><Badge status={account.installed ? 'done' : 'blocked'}>{account.installed ? '설치됨' : '설치 필요'}</Badge></div>))}<p className="settings-hint">실행 계정, 모델과 추론 수준은 각 AI 프로필에서 설정합니다.</p></section><section className="panel settings-card"><div className="section-heading"><h2>실행과 비용 제어</h2><Settings2 size={18} /></div><form onSubmit={save}><div className="form-grid"><Field label="AI 실행 승인"><select name="agentPermissionMode" defaultValue={data.settings.agentPermissionMode || 'automatic'}><option value="automatic">자동 실행 · 허용된 권한 범위</option><option value="review">검토 모드 · 필요한 실행 승인 요청</option></select></Field><Field label="최대 동시 실행"><input name="maxConcurrent" type="number" min="1" max="8" required defaultValue={data.settings.maxConcurrent} /></Field><Field label="실행 시간 제한 · 분"><input name="maxSessionMinutes" type="number" min="1" max="180" required defaultValue={data.settings.maxSessionMinutes} /></Field><Field label="자동 보완 최대 횟수"><input name="maxReworkAttempts" type="number" min="0" max="5" required defaultValue={data.settings.maxReworkAttempts ?? 2} /></Field></div><p className="muted">질문은 두 모드 모두 답변할 수 있으며 응답 대기 시간은 실행 제한에서 제외합니다. 승인 모드는 새 실행부터 적용됩니다. 동시 실행 수 변경은 다음 실행부터, 시간 제한은 새 실행부터 적용됩니다. 팀장 보완 요청은 설정한 횟수까지 자동 실행합니다. 실행 오류와 중단은 수동으로 재개합니다.</p><div className="form-footer"><Submit busy={busy} /></div></form></section></div>
    <MenuOrderSettings />
    <div className="local-environment"><ShieldCheck size={20} /><div><strong>나만의 로컬 작업 공간</strong><p>데이터와 프로필은 이 서버에 보관됩니다. 로그인 없이 사용하며 AI 요청은 선택한 CLI를 통해 전송됩니다.</p></div></div>
  </div>;
}
