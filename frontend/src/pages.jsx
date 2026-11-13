import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, Command, FileText, FolderGit2, GitBranch, Plus, Search, Send, Settings2, ShieldCheck, Sparkles, Users, Workflow, Zap } from 'lucide-react';
import { useWorkspace } from './App';
import { isLive, kindLabels, providerLabel, time } from './api';
export { Usage } from './Usage';
import { Avatar, Badge, Empty, Field, Markdown, Submit } from './ui';
import { MenuOrderSettings } from './MenuOrderSettings';
import { KnowledgeExplorer } from './KnowledgeExplorer';
export { Organization } from './Organization';
export { Sessions } from './SessionTerminal';
export { Dashboard } from './WorkspaceMonitor';

function Heading({ eyebrow, title, description, action }) {
  return <div className="page-heading"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div>;
}

export function Tasks() {
  const { data, open } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const project = params.get('project') || 'all';
  const [search, setSearch] = useState('');
  const [department, setDepartment] = useState('all');
  const [cancelled, setCancelled] = useState(false);
  const createTask = () => open('task', {
    ...(data.projects.some(item => item.id === project) ? { projectId: project } : {}),
    ...(department !== 'all' ? { departmentId: department } : {}),
  });
  const filtered = data.tasks.filter(task => (department === 'all' || task.departmentId === department)
    && (project === 'all' || (project === 'none' ? !task.projectId : task.projectId === project))
    && task.title.toLowerCase().includes(search.toLowerCase()));
  const columns = [['예정된 작업', ['draft', 'assigned', 'queued'], 'planned'], ['진행 중', ['running'], 'running'], ['검토 대기', ['review'], 'review'], ['완료', ['done'], 'done'], ['차단됨', ['blocked'], 'blocked']];
  if (cancelled) columns.push(['취소됨', ['cancelled'], 'cancelled']);
  return <div className="page"><Heading eyebrow="FROM IDEA TO DONE" title="작업 보드" description="작업을 나누고, 담당자를 정하고, 결과를 함께 확인하세요." action={<button className="button primary" onClick={createTask}><Plus size={16} />작업 만들기</button>} />
    <div className="toolbar"><div className="search-input"><Search size={17} /><input aria-label="작업 검색" placeholder="작업 검색…" value={search} onChange={event => setSearch(event.target.value)} /></div><select className="compact-select" aria-label="부서 필터" value={department} onChange={event => setDepartment(event.target.value)}><option value="all">모든 부서</option>{data.departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select><select className="compact-select" aria-label="프로젝트 필터" value={project} onChange={event => { const next = new URLSearchParams(params); if (event.target.value === 'all') next.delete('project'); else next.set('project', event.target.value); setParams(next, { replace: true }); }}><option value="all">모든 프로젝트</option><option value="none">프로젝트 미지정</option>{data.projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><label className="checkbox-label"><input type="checkbox" checked={cancelled} onChange={event => setCancelled(event.target.checked)} />취소 작업 포함</label><span className="toolbar-count">{filtered.length} tasks</span></div>
    <div className="kanban">{columns.map(([title, states, status]) => { const tasks = filtered.filter(task => states.includes(task.status)); return <section className="kanban-column" key={status}><header><span className={`column-dot ${status}`} /><h2>{title}</h2><span>{tasks.length}</span>{status === 'planned' && <button className="icon-button" onClick={createTask} aria-label="작업 만들기"><Plus size={16} /></button>}</header><div className="kanban-items">{tasks.map(task => { const member = data.members.find(m => m.id === task.assigneeId); return <button className="task-card" key={task.id} onClick={() => open('taskDetail', task)}><div className="task-card-top"><span className="task-id">TSK-{task.id.slice(0, 4).toUpperCase()}</span><span className={`priority ${task.priority}`}>{task.priority === 'high' ? '높음' : task.priority === 'low' ? '낮음' : '보통'}</span></div><h3>{task.title}</h3><p>{task.description || '설명이 없습니다.'}</p>{task.error && <span className="task-error">{task.error}</span>}<div className="task-card-meta"><span><GitBranch size={13} />{task.dependsOn.length ? `선행 작업 ${task.dependsOn.length}` : '독립 작업'}</span>{task.status === 'queued' && <Badge status="queued" />}</div><footer><span>{data.departments.find(d => d.id === task.departmentId)?.name}</span><span className="task-assignee"><Avatar member={member} />{member?.name || '미배정'}</span></footer></button>; })}{!tasks.length && <div className="kanban-empty"><span />이 단계의 작업이 없습니다.</div>}</div></section>; })}</div>
  </div>;
}

export function Consultation() {
  const { data, open, perform, busy } = useWorkspace();
  const leaders = data.members.filter(m => m.role === 'leader');
  const [selected, setSelected] = useState('');
  const [project, setProject] = useState('');
  const [prompt, setPrompt] = useState('');
  const leader = leaders.find(m => m.id === selected) || leaders[0];
  const sessions = data.sessions.filter(session => ['plan', 'review'].includes(session.kind) && session.memberId === leader?.id && (session.projectId || '') === project).reverse();
  async function send(event, report = false) {
    event.preventDefault();
    try {
      await perform(report ? '/report' : '/consult', 'POST', { leaderId: leader.id, projectId: project || null, prompt: report ? prompt || '현재 작업 결과와 남은 문제를 정리해주세요.' : prompt }, report ? '팀장에게 결과 보고를 요청했습니다.' : '팀장이 요청을 검토하고 있습니다.');
      setPrompt('');
    } catch { /* The workspace displays request errors. */ }
  }
  return <div className="page consultation-page"><Heading eyebrow="THINK TOGETHER" title="팀장과 협의" description="아이디어를 설계로, 설계를 실행 가능한 작업으로 바꾸세요." />
    {!leaders.length ? <div className="panel"><Empty title="이야기를 나눌 팀장을 추가하세요" description="팀장은 요구사항을 정리하고, 적합한 팀원에게 작업을 제안합니다." action={() => open('member', { role: 'leader' })} label="팀장 추가" /></div> : <div className="consultation-layout"><section className="conversation"><header className="conversation-head"><Avatar member={leader} /><div><select aria-label="팀장 선택" value={leader.id} onChange={event => setSelected(event.target.value)}>{leaders.map(m => <option value={m.id} key={m.id}>{m.name} · {data.departments.find(d => d.id === m.departmentId)?.name}</option>)}</select><small>{providerLabel(leader)} · {leader.model || '기본 모델'}</small></div><Badge status={leader.status} /></header><div className="conversation-content">{sessions.length ? sessions.map(session => <div className="conversation-turn" key={session.id}>{session.prompt && <div className="user-message"><span>나의 요청</span><p>{session.prompt}</p></div>}<div className="assistant-message"><span className="message-label"><Sparkles size={15} />{leader.name}<time>{time(session.startedAt)}</time></span>{isLive(session.status) ? <div className="thinking"><span /><span /><span /><p>{session.progress}</p></div> : session.status === 'completed' ? <Markdown>{session.output}</Markdown> : <div className="error-box">{session.progress}</div>}{session.documentIds?.length > 0 && <div className="message-documents">{session.documentIds.map(key => { const doc = data.documents.find(d => d.id === key); return doc && <button key={key} onClick={() => open('document', doc)}><FileText size={16} /><span>{kindLabels[doc.kind]}</span><ArrowUpRight size={14} /></button>; })}</div>}{session.taskIds?.length > 0 && <Link className="task-proposal" to="/tasks"><ListIcon /><span>{session.taskIds.length}개의 작업이 제안되었습니다. 작업 보드에서 검토하고 실행하세요.</span><ArrowRight size={15} /></Link>}</div></div>) : <div className="conversation-empty"><span><Sparkles size={30} /></span><h2>어떤 일을 함께 해볼까요?</h2><p>목표와 기대하는 결과를 알려주세요.<br />팀장이 설계와 작업 분배를 제안합니다.</p><div className="prompt-starters">{['프로젝트 구조를 검토하고 개선 작업을 나눠줘.', '새 기능의 요구사항과 구현 계획을 정리해줘.'].map(text => <button key={text} onClick={() => setPrompt(text)}>{text}<ArrowUpRight size={14} /></button>)}</div></div>}</div><form className="composer" onSubmit={send}><textarea required value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={`${leader.name}에게 목표와 요구사항을 알려주세요…`} rows={3} maxLength={16000} /><div><span><ShieldCheck size={13} />협의 후 작업을 직접 실행합니다</span><button className="button dark" type="submit" disabled={busy || leader.status === 'running' || !prompt.trim()}><Send size={15} />보내기</button></div></form></section>
    <aside className="consultation-aside"><div className="panel aside-card"><h3><FolderGit2 size={17} />프로젝트 맥락</h3><Field label="대상 프로젝트"><select value={project} onChange={event => setProject(event.target.value)}><option value="">프로젝트 없이 협의</option>{data.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field><p>기존 협의 요약과 팀원 정보가 팀장에게 함께 전달됩니다.</p><button className="text-button" onClick={() => open('project')}><Plus size={14} />프로젝트 등록</button></div><div className="panel aside-card"><h3><Users size={17} />함께하는 팀원</h3>{data.members.filter(m => m.departmentId === leader.departmentId && m.role === 'member').map(member => <div className="roster-item" key={member.id}><Avatar member={member} /><div><strong>{member.name}</strong><small>{providerLabel(member)}{member.specialty ? ` · ${member.specialty}` : ''}</small></div><span className={`status-dot ${member.status === 'running' ? 'live' : ''}`} /></div>)}<button className="text-button" onClick={() => open('member', { departmentId: leader.departmentId })}><Plus size={14} />팀원 추가</button></div><div className="report-request"><FileText size={22} /><h3>진행 상황을 정리할까요?</h3><p>팀장이 작업 결과와 남은 문제를 하나의 보고서로 정리합니다.</p><button className="button secondary" disabled={busy || leader.status === 'running'} onClick={event => send(event, true)}>결과 보고 요청<ArrowUpRight size={14} /></button></div></aside></div>}
  </div>;
}

function ListIcon() { return <Workflow size={18} />; }

export function Library() {
  const { data, open } = useWorkspace();
  const [view, setView] = useState('explorer');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const documents = data.documents.filter(doc => (filter === 'all' || doc.kind === filter) && doc.title.toLowerCase().includes(search.toLowerCase()));
  return <div className="page"><Heading eyebrow="SHARED KNOWLEDGE" title="지침 · 문서 · 스킬" description="개인 지침과 공용 자료를 트리에서 탐색하고 내용을 확인하세요." action={<button className="button primary" onClick={() => open('document')}><Plus size={16} />문서 작성</button>} />
    <div className="library-views" role="group" aria-label="자료 보기 방식"><button type="button" aria-pressed={view === 'explorer'} onClick={() => setView('explorer')}>지침 탐색</button><button type="button" aria-pressed={view === 'documents'} onClick={() => setView('documents')}>문서 목록</button></div>
    {view === 'explorer' ? <KnowledgeExplorer /> : <><div className="toolbar library-toolbar"><div className="segmented">{[['all', '전체'], ['agreement', '협의'], ['specification', '설계'], ['report', '보고'], ['instruction', '지침'], ['skill', '스킬'], ['note', '노트']].map(([value, label]) => <button key={value} className={filter === value ? 'selected' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div><div className="search-input"><Search size={16} /><input value={search} aria-label="문서 검색" onChange={event => setSearch(event.target.value)} placeholder="문서 검색…" /></div></div>
    {documents.length ? <div className="documents-grid">{documents.map(doc => <button className="document-card" key={doc.id} onClick={() => open('document', doc)}><div className="document-top"><span className={`document-icon ${doc.kind}`}>{doc.kind === 'skill' ? <Zap size={22} /> : doc.kind === 'instruction' ? <Command size={22} /> : <FileText size={22} />}</span><span>{kindLabels[doc.kind]}</span><ArrowUpRight size={15} /></div><h3>{doc.title}</h3><p>{doc.content.replace(/[#*`>]/g, '').slice(0, 140) || '아직 내용이 없습니다.'}</p><footer><span>{time(doc.updatedAt)}</span><strong>v{doc.version}</strong></footer></button>)}</div> : <div className="panel"><Empty title="아직 문서가 없습니다" description="직접 작성하거나 팀장과의 협의에서 문서를 만들어보세요." action={() => open('document', { kind: filter === 'all' ? 'note' : filter })} label="문서 작성" /></div>}</>}
  </div>;
}

export function Preferences() {
  const { data, perform, busy } = useWorkspace();
  async function save(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try { await perform('/settings', 'PATCH', { maxConcurrent: Number(form.get('maxConcurrent')), maxSessionMinutes: Number(form.get('maxSessionMinutes')) }); } catch { /* Error toast is displayed by perform. */ }
  }
  return <div className="page"><Heading eyebrow="WORKSPACE SETTINGS" title="팀을 위한 작업 환경" description="AI 실행 도구와 동시 실행 수, 세션 시간 제한을 관리하세요." /><div className="settings-grid"><section className="panel settings-card"><div className="section-heading"><h2>AI 실행 도구</h2><Command size={18} /></div><p className="muted">서버에 설치된 CLI와 기존 인증 설정을 사용합니다.</p>{data.providers.flatMap(provider => (provider.accounts || [{ id: provider.name, installed: provider.installed }]).map(account => <div className="provider-row" key={account.id}><span className={`provider-logo ${provider.name}`}>{provider.name === 'codex' ? <Command size={21} /> : <Sparkles size={21} />}</span><div><strong>{provider.name === 'codex' ? `Codex · ${account.id}` : 'Claude Code'}</strong><small>인증 상태는 실행 시 확인</small></div><Badge status={account.installed ? 'done' : 'blocked'}>{account.installed ? '설치됨' : '설치 필요'}</Badge></div>))}<p className="settings-hint">실행 계정, 모델과 추론 수준은 각 AI 프로필에서 설정합니다.</p></section><section className="panel settings-card"><div className="section-heading"><h2>실행과 비용 제어</h2><Settings2 size={18} /></div><form onSubmit={save}><div className="form-grid"><Field label="최대 동시 실행"><input name="maxConcurrent" type="number" min="1" max="8" required defaultValue={data.settings.maxConcurrent} /></Field><Field label="세션 시간 제한 · 분"><input name="maxSessionMinutes" type="number" min="1" max="180" required defaultValue={data.settings.maxSessionMinutes} /></Field></div><p className="muted">동시 실행 수 변경은 다음 실행부터, 시간 제한은 새 세션부터 적용됩니다. 실패한 작업은 자동 재시도하지 않습니다.</p><div className="form-footer"><Submit busy={busy} /></div></form></section></div>
    <MenuOrderSettings />
    <div className="local-environment"><ShieldCheck size={20} /><div><strong>나만의 로컬 작업 공간</strong><p>데이터와 프로필은 이 서버에 보관됩니다. 로그인 없이 사용하며 AI 요청은 선택한 CLI를 통해 전송됩니다.</p></div></div>
  </div>;
}
