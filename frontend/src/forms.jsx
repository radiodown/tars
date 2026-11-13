import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Check, Code, Download, FileText, GitMerge, Pencil, Play, Square, User } from 'lucide-react';
import { useWorkspace } from './App';
import { api, isLive, kindLabels, labels, providerLabel, time } from './api';
import { Avatar, Badge, Dialog, Empty, Field, Markdown, Submit } from './ui';
import { ModelFields } from './ModelFields';
import { SessionTerminal } from './SessionTerminal';
import { ExecutionRecord, HistoryTimeline, TaskExecutionHistory } from './WorkHistory';

const templates = {
  agreement: '# 협의 문서\n\n## 목적과 배경\n\n## 요구사항과 범위\n\n## 합의된 결정\n\n## 제약 및 제외 범위\n\n## 미결 사항\n\n## 완료 기준\n',
  specification: '# 설계 사양\n\n## 구성 요소와 책임\n\n## 작업 흐름\n\n## 인터페이스와 데이터\n\n## 오류와 재개\n\n## 작업 분할\n\n## 검증 계획\n',
  report: '# 결과 보고\n\n## 전체 결과\n\n## 작업별 완료 여부\n\n## 산출물과 통합\n\n## 검증 및 미검증 사항\n\n## 남은 문제\n',
  instruction: '# 공통 작업 지침\n\n', skill: '# 스킬\n\n## 목적\n\n## 적용 조건\n\n## 수행 절차\n', note: '',
};

export function EntityForm({ type, initial }) {
  const { data, close, open, perform, busy } = useWorkspace();
  const editing = Boolean(initial.id);
  const [department, setDepartment] = useState(initial.departmentId || data.departments[0]?.id || '');
  const [role, setRole] = useState(initial.role || 'member');
  const [project, setProject] = useState(initial.projectId || '');
  const [kind, setKind] = useState(initial.kind || 'note');
  const [instructionMode, setInstructionMode] = useState(initial.instructionMode || (editing ? 'always' : 'on_demand'));
  const [content, setContent] = useState(initial.content ?? templates[initial.kind || 'note']);
  const [preview, setPreview] = useState(type === 'document' && editing);
  const [error, setError] = useState('');
  const titles = { department: '부서', member: role === 'leader' ? 'AI 팀장' : 'AI 팀원', project: '프로젝트', document: '문서', task: '작업' };
  const collection = { department: 'departments', member: 'members', project: 'projects', document: 'documents', task: 'tasks' }[type];
  const needsDepartment = ['member', 'task'].includes(type) && !data.departments.length;
  const leaderExists = data.members.some(member => member.departmentId === department && member.role === 'leader' && member.id !== initial.id);
  async function submit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const values = Object.fromEntries(form);
    if (type === 'document') Object.assign(values, { kind, content, instructionMode, readWhen: values.readWhen || '', projectId: values.projectId || null, departmentId: values.departmentId || null, ...(editing ? { version: initial.version } : {}) });
    if (type === 'task') Object.assign(values, { projectId: project || null, departmentId: department, assigneeId: values.assigneeId || null,
      dependsOn: form.getAll('dependsOn'), documentIds: form.getAll('documentIds'), isolation: project ? values.isolation : 'personal' });
    if (type === 'member') values.departmentId = department;
    try { await perform(`/${collection}${editing ? `/${initial.id}` : ''}`, editing ? 'PATCH' : 'POST', values); close(); }
    catch (issue) { setError(issue.message); }
  }
  return <Dialog title={type === 'document' && editing ? initial.title : `${titles[type]} ${editing ? '수정' : '만들기'}`} subtitle={type === 'member' ? '이름과 역할을 정하고, 함께 일할 모델을 연결하세요.' : type === 'document' ? '하나의 원본을 모든 AI와 공유합니다.' : '작업에 필요한 정보를 입력하세요.'} onClose={close} wide={['document', 'task'].includes(type)}>
    {needsDepartment ? <Empty title="먼저 부서를 만들어주세요" description="AI와 작업은 부서에 속합니다." action={() => open('department')} label="부서 만들기" /> : <form onSubmit={submit}>
      {type === 'document' && <div className="editor-tabs"><button type="button" className={!preview ? 'selected' : ''} onClick={() => setPreview(false)}><Pencil size={14} />편집</button><button type="button" className={preview ? 'selected' : ''} onClick={() => setPreview(true)}><FileText size={14} />미리보기</button>{editing && <span>v{initial.version} · {time(initial.updatedAt)}</span>}</div>}
      <div className={preview ? 'visually-hidden' : ''}>
        <Field label={type === 'task' || type === 'document' ? '제목' : '이름'}><input name={type === 'task' || type === 'document' ? 'title' : 'name'} required maxLength={200} defaultValue={initial.title || initial.name || ''} placeholder={type === 'member' ? '예: Atlas' : type === 'department' ? '예: 플랫폼 개발팀' : '이름을 입력하세요'} /></Field>
        {['department', 'project', 'task'].includes(type) && <Field label={type === 'task' ? '작업 설명' : '설명'}><textarea name="description" rows={3} defaultValue={initial.description || ''} placeholder="목적과 수행할 내용을 적어주세요." /></Field>}
        {['member', 'task'].includes(type) && <Field label="소속 부서" hint={type === 'member' && editing ? '부서를 변경하면 조직도에서 이동합니다. 진행 중인 담당 작업이 있으면 먼저 정리하세요.' : undefined}><select value={department} onChange={event => setDepartment(event.target.value)} required>{data.departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>}
        {type === 'member' && <>
          <Field label="역할" hint={leaderExists ? '이 부서에는 팀장이 있습니다. 팀원을 추가하거나 다른 부서를 선택하세요.' : '부서마다 팀장 한 명과 여러 팀원을 구성할 수 있습니다.'}><select name="role" value={role} onChange={event => setRole(event.target.value)} aria-invalid={role === 'leader' && leaderExists || undefined} ref={element => { element?.setCustomValidity(role === 'leader' && leaderExists ? '이 부서에는 이미 팀장이 있습니다.' : ''); }}><option value="leader" disabled={leaderExists}>팀장 · 설계 및 위임</option><option value="member">팀원 · 작업 수행</option></select></Field>
          <ModelFields initial={initial} />
          <Field label="전문 분야"><input name="specialty" maxLength={500} defaultValue={initial.specialty || ''} placeholder="예: UI 구현, 아키텍처 설계, 코드 검토" /></Field>
          <Field label="개인 작업 지침" hint="공통 규칙은 반복하지 않고 이 AI의 차이만 적으세요. 긴 절차는 문서에서 ‘필요할 때 읽기’로 등록하세요."><textarea name="instructions" rows={5} maxLength={20000} defaultValue={initial.instructions || ''} placeholder="공통 지침에 추가할 역할과 작업 방식을 입력하세요." /></Field>
        </>}
        {type === 'project' && <Field label="소스코드 디렉토리" hint="이 서버에 있는 절대 경로를 입력하세요. 작업 시 별도 디렉토리를 만듭니다."><input name="path" required defaultValue={initial.path || ''} placeholder="/home/hjjin/my-project" /></Field>}
        {type === 'task' && <>
          <div className="form-grid"><Field label="담당 팀원"><select name="assigneeId" defaultValue={initial.assigneeId || ''} key={department}><option value="">나중에 배정</option>{data.members.filter(m => m.departmentId === department && m.role === 'member').map(m => <option value={m.id} key={m.id}>{m.name} · {providerLabel(m)}</option>)}</select></Field><Field label="우선순위"><select name="priority" defaultValue={initial.priority || 'normal'}><option value="low">낮음</option><option value="normal">보통</option><option value="high">높음</option></select></Field></div>
          <div className="form-grid"><Field label="프로젝트"><select value={project} onChange={event => setProject(event.target.value)}><option value="">프로젝트 없이 작업</option>{data.projects.map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select></Field>{project && <Field label="소스 분리 방식"><select name="isolation" defaultValue={initial.isolation === 'copy' ? 'copy' : 'worktree'}><option value="worktree">Git worktree</option><option value="copy">디렉토리 복사</option></select></Field>}</div>
          <Field label="완료 기준"><textarea name="acceptance" rows={3} defaultValue={initial.acceptance || ''} placeholder="어떤 결과가 나오면 완료인가요?" /></Field>
          <Field label="선행 작업" hint="선택한 작업이 완료된 뒤 실행됩니다. Ctrl / ⌘로 여러 개를 선택할 수 있습니다."><select name="dependsOn" multiple defaultValue={initial.dependsOn || []} key={`${department}-${project}`}>{data.tasks.filter(t => t.id !== initial.id && t.departmentId === department && (t.projectId || '') === project).map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select></Field>
          <Field label="참고 문서"><select name="documentIds" multiple defaultValue={initial.documentIds || []}>{data.documents.map(d => <option key={d.id} value={d.id}>{d.title}</option>)}</select></Field>
        </>}
        {type === 'document' && <>
          <div className="form-grid"><Field label="문서 종류"><select value={kind} disabled={editing} onChange={event => { setKind(event.target.value); if (!content || Object.values(templates).includes(content)) setContent(templates[event.target.value]); }}>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label="프로젝트"><select name="projectId" defaultValue={initial.projectId || ''}><option value="">공통</option>{data.projects.map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select></Field></div>
          <input type="hidden" name="departmentId" value={initial.departmentId || ''} />
          {kind === 'instruction' && <>
            <Field label="지침 적용 방식" hint="항상 필요한 짧은 규칙만 자동 적용하고 상세 절차는 해당 작업에서 읽도록 하세요."><select value={instructionMode} onChange={event => setInstructionMode(event.target.value)}><option value="on_demand">필요할 때 읽기</option><option value="always">항상 적용</option></select></Field>
            <Field label="읽는 조건" hint={instructionMode === 'on_demand' ? 'AI에는 제목·조건·원문 경로만 전달됩니다. 예: 패턴 업데이트 오류를 조사할 때.' : '항상 적용하는 지침에는 조건이 필요하지 않습니다.'}><input name="readWhen" required={instructionMode === 'on_demand'} maxLength={500} defaultValue={initial.readWhen || ''} placeholder="어떤 작업에서 이 문서를 읽어야 하나요?" /></Field>
            <p className="muted">본문 {new TextEncoder().encode(content).length.toLocaleString()} bytes · {instructionMode === 'always' ? '자동 적용 지침은 합계 32 KiB 이내로 유지하세요.' : '본문은 시작 시 자동 포함되지 않습니다.'}</p>
          </>}
          <Field label="내용 · Markdown"><textarea className="code-editor" value={content} onChange={event => setContent(event.target.value)} rows={18} maxLength={100000} /></Field>
        </>}
      </div>
      {preview && <Markdown>{content || '*내용이 없습니다.*'}</Markdown>}
      {type === 'document' && editing && initial.revisions?.length > 0 && <details className="revision-history"><summary>이전 버전 {initial.revisions.length}개</summary>{initial.revisions.slice().reverse().map(revision => <details key={revision.version}><summary>v{revision.version} · {time(revision.savedAt)}</summary>{kind === 'instruction' && <p className="muted">{revision.instructionMode === 'on_demand' ? `필요할 때 읽기 · ${revision.readWhen}` : '항상 적용'}</p>}<Markdown>{revision.content}</Markdown></details>)}</details>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-footer"><button className="button secondary" type="button" onClick={close}>닫기</button><Submit busy={busy} /></div>
    </form>}
  </Dialog>;
}

export function TaskDetail({ taskId }) {
  const { data, close, open, fire, busy, notice } = useWorkspace();
  const [showPatch, setShowPatch] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const task = data.tasks.find(t => t.id === taskId);
  const member = data.members.find(m => m.id === task?.assigneeId);
  const patch = useQuery({ queryKey: ['patch', taskId, task?.updatedAt], enabled: showPatch, queryFn: async () => {
    const response = await fetch(`/api/tasks/${taskId}/patch`);
    if (!response.ok) throw new Error((await response.json()).error);
    return response.text();
  } });
  if (!task) return null;
  return <Dialog title={task.title} subtitle={`TASK · ${task.id.slice(0, 8)}`} onClose={close} drawer>
    {notice?.error && <div className="error-box" role="alert">{notice.message}</div>}
    <div className="detail-badges"><Badge status={task.status} /><span className={`priority ${task.priority}`}>{task.priority === 'high' ? '높은 우선순위' : task.priority === 'low' ? '낮은 우선순위' : '보통 우선순위'}</span></div>
    <div className="detail-owner"><Avatar member={member} /><div><strong>{member?.name || '담당자 미지정'}</strong><small>{data.departments.find(d => d.id === task.departmentId)?.name}</small></div></div>
    <div className="action-row">
      {['draft', 'assigned', 'blocked', 'review'].includes(task.status) && <><button className="button primary" disabled={busy || !task.assigneeId} onClick={() => fire(`/tasks/${task.id}/run`, 'POST', {}, '실행 대기열에 추가했습니다.')}><Play size={15} />{task.status === 'review' ? '다시 실행' : '작업 실행'}</button><button className="button secondary" onClick={() => open('task', task)}><Pencil size={15} />수정</button></>}
      {task.status === 'review' && <button className="button dark" disabled={busy} onClick={() => fire(`/tasks/${task.id}/complete`, 'POST', {}, '검토 완료로 표시했습니다.')}><Check size={15} />검토 완료</button>}
      {!['done', 'cancelled'].includes(task.status) && <button className="button ghost" disabled={busy} onClick={() => fire(`/tasks/${task.id}/cancel`, 'POST', {}, '작업을 취소했습니다.')}><Square size={13} />취소</button>}
    </div>
    {task.error && <div className="error-box">{task.error}</div>}
    <section className="detail-section"><h3>작업 설명</h3><Markdown>{task.description || '설명이 없습니다.'}</Markdown></section>
    <section className="detail-section"><h3>완료 기준</h3><Markdown>{task.acceptance || '등록된 완료 기준이 없습니다.'}</Markdown></section>
    {task.dependsOn.length > 0 && <section className="detail-section"><h3>선행 작업</h3>{task.dependsOn.map(key => { const dep = data.tasks.find(t => t.id === key); return <div className="dependency" key={key}><span>{dep?.title}</span><Badge status={dep?.status} /></div>; })}</section>}
    <section className="detail-section"><h3>작업 공간</h3><p className="mono path">{task.workspace || '첫 실행 시 작업 디렉토리를 만듭니다.'}</p><small className="muted">{task.isolation === 'worktree' ? 'Git worktree · 기준 커밋에서 작업' : task.isolation === 'copy' ? '디렉토리 복사 · 변경 사항은 수동 통합' : '개인 작업 디렉토리'}</small></section>
    {task.report && <section className="detail-section"><h3>팀원 결과 보고</h3><Markdown>{task.report}</Markdown></section>}
    <TaskExecutionHistory key={task.id} task={task} />
    {['review', 'done'].includes(task.status) && task.isolation === 'worktree' && <section className="detail-section"><h3>변경 사항 통합</h3><div className="action-row"><button className="button secondary" onClick={() => setShowPatch(!showPatch)}><Code size={15} />패치 {showPatch ? '접기' : '보기'}</button>{task.status === 'done' && !task.integratedAt && <button className="button secondary" onClick={() => { setShowPatch(true); setConfirm(true); }}><GitMerge size={15} />원본에 적용</button>}</div>
      {showPatch && <pre className="patch-preview">{patch.isError ? patch.error.message : patch.isPending ? '변경 내용을 불러오는 중…' : patch.data || '변경 사항이 없습니다.'}</pre>}
      {confirm && !task.integratedAt && <div className="confirm-box"><p>아래 원본 디렉토리에 변경 사항을 적용합니다. 커밋은 만들지 않습니다.</p><code>{data.projects.find(p => p.id === task.projectId)?.path}</code><button className="button primary" disabled={busy || patch.isPending || patch.isError || !patch.data} onClick={() => { fire(`/tasks/${task.id}/integrate`, 'POST', {}, '변경 사항을 원본에 적용했습니다.'); setConfirm(false); }}>변경 사항 적용</button></div>}
      {task.integratedAt && <p className="success-text"><Check size={15} />{time(task.integratedAt)} 원본에 적용됨</p>}
    </section>}
  </Dialog>;
}

export function SessionDetail({ sessionId }) {
  const { data, close, notice } = useWorkspace();
  const session = data.sessions.find(s => s.id === sessionId);
  const member = data.members.find(m => m.id === session?.memberId);
  if (!session) return null;
  return <Dialog title={`${member?.name || 'AI'}의 CLI 세션`} subtitle={`${providerLabel(session)} · ${session.model}`} onClose={close} drawer>
    {notice?.error && <div className="error-box" role="alert">{notice.message}</div>}
    <ExecutionRecord session={session} />
    <SessionTerminal key={session.id} session={session} />
    {session.output && <section className="detail-section"><h3>응답</h3><Markdown>{session.output}</Markdown></section>}
    {session.providerSessionId && <p className="muted mono">Provider session: {session.providerSessionId}</p>}
    <HistoryTimeline key={session.id} kind="sessions" id={session.id} revision={`${session.status}:${session.steering?.length || 0}`} live={isLive(session.status)} />
  </Dialog>;
}
