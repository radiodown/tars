import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, Command, FileText, FolderGit2, Layers3, Plus, Send, Square } from 'lucide-react';
import { useWorkspace } from './App';
import { isLive, number, time } from './api';
import { Badge, Empty, Field, Markdown } from './ui';

export function Projects() {
  const { data, open, perform, fire, busy } = useWorkspace();
  const [projectId, setProjectId] = useState('');
  const [prompt, setPrompt] = useState('');
  const ceo = data.members.find(member => member.role === 'ceo');
  const overview = data.ceoOverview;
  const reports = data.sessions.filter(session => session.memberId === ceo?.id && session.kind === 'oversight' && (!projectId || session.projectId === projectId));
  const atCapacity = data.sessions.filter(session => isLive(session.status)).length >= data.settings.maxConcurrent;
  async function requestReport(event) {
    event.preventDefault();
    try {
      await perform('/ceo/report', 'POST', { projectId: projectId || null,
        prompt: prompt.trim() || '현재 프로젝트들의 진행 상황, 차단 사항과 다음 우선순위를 정리해주세요.' }, 'TARS에 프로젝트 현황 분석을 요청했습니다.');
      setPrompt('');
    } catch { /* The workspace displays request errors. */ }
  }
  if (!ceo || !overview) return <div className="page"><Empty title="프로젝트 현황을 준비하고 있습니다" description="프로젝트와 분석 보고 정보를 불러오는 중입니다." /></div>;
  const metrics = [
    ['진행 중인 프로젝트', overview.totals.runningProjects, ''],
    ['차단된 작업이 있는 프로젝트', overview.totals.blockedProjects, 'critical'],
    ['검토 대기 프로젝트', overview.totals.reviewProjects, ''],
    ['등록 작업이 완료된 프로젝트', overview.totals.doneProjects, ''],
  ];
  return <div className="page projects-page">
    <div className="page-heading"><div><p className="eyebrow">PROJECTS</p><h1>프로젝트 관리</h1><p>소스 프로젝트를 등록하고 진행 현황과 분석 보고서를 확인하세요.</p></div><button className="button secondary" onClick={() => open('project')}><Plus size={15} />프로젝트 등록</button></div>
    <div className="ceo-metrics">{metrics.map(([label, value, tone]) => <div className={`ceo-metric ${value ? tone : ''}`} key={label}><span>{label}</span><strong>{number(value)}</strong></div>)}</div>
    {overview.unscoped.counts.total > 0 && <Link to="/tasks?project=none" className="ceo-unscoped"><Layers3 size={16} /><span>프로젝트 미지정 작업 {overview.unscoped.counts.total}개 · 차단 {overview.unscoped.counts.blocked}개</span><ArrowRight size={15} /></Link>}
    <section className="section"><div className="section-heading"><h2>프로젝트 현황 <span>{overview.projects.length}</span></h2><span className="muted">등록된 작업 기준 · 취소 작업은 완료율에서 제외</span></div>
      {overview.projects.length ? <div className="ceo-project-grid">{overview.projects.map(project => <article className="panel ceo-project" key={project.id}>
        <header><FolderGit2 size={20} /><div><h3>{project.name}</h3><p>{project.description || '프로젝트 설명이 없습니다.'}</p></div><Badge status={project.status}>{project.status === 'done' ? '등록 작업 완료' : undefined}</Badge></header>
        <code className="project-source-path">{data.projects.find(item => item.id === project.id)?.path || '소스 경로 미제공'}</code>
        <div className="ceo-project-departments">{project.departments.length ? project.departments.map(department => <span key={department.id}>{department.name} <small>· {department.leaderName || '팀장 미지정'}</small></span>) : <span>아직 작업을 배정한 부서가 없습니다.</span>}</div>
        <div className="ceo-project-counts"><span>전체 <b>{project.counts.total}</b></span><span>진행 <b>{project.counts.running}</b></span><span>검토 <b>{project.counts.review}</b></span><span className={project.counts.blocked ? 'critical' : ''}>차단 <b>{project.counts.blocked}</b></span><span>미배정 <b>{project.counts.unassigned}</b></span></div>
        <div className="ceo-progress-label"><span>완료 {project.counts.done} / {project.counts.total - project.counts.cancelled}</span><strong>{project.progress == null ? '—' : `${project.progress}%`}</strong></div>
        <div className="progress-track" role="progressbar" aria-label={`${project.name} 등록 작업 완료율`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={project.progress ?? undefined} aria-valuetext={project.progress == null ? '대상 작업 없음' : `${project.progress}% 완료`}><span style={{ width: `${project.progress || 0}%` }} /></div>
        <footer><span>최근 변경 {time(project.updatedAt)}</span><Link to={`/tasks?project=${encodeURIComponent(project.id)}`}>작업 보기<ArrowUpRight size={14} /></Link></footer>
      </article>)}</div> : <div className="panel"><Empty title="TARS가 관리할 프로젝트를 등록하세요" description="프로젝트에 연결된 작업의 진행과 결과가 이곳에 모입니다." action={() => open('project')} label="프로젝트 등록" /></div>}
    </section>
    <section className="panel ceo-report-request"><div className="section-heading"><h2><Command size={17} />TARS에게 현황 분석 요청</h2><span className="muted">요청할 때 AI 실행</span></div>
      <form onSubmit={requestReport}><div className="ceo-report-fields"><Field label="분석 범위"><select value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">전체 프로젝트</option>{data.projects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}</select></Field><Field label="요청 사항" hint="비워두면 진행 상황, 차단 사항, 다음 우선순위를 보고합니다."><textarea rows={3} maxLength={16000} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="어떤 프로젝트가 막혀 있고, 어느 부서가 먼저 대응해야 할까?" /></Field></div><div className="ceo-request-footer"><p>{ceo.status === 'running' ? 'TARS가 현황을 분석하고 있습니다.' : atCapacity ? '동시 실행 한도에 도달했습니다. 진행 중인 작업이 끝난 뒤 요청하세요.' : '현황 조회는 자동 갱신되며, AI 분석은 이 버튼을 눌렀을 때 시작됩니다.'}</p><button type="submit" className="button primary" disabled={busy || ceo.status === 'running' || atCapacity}><Send size={15} />현황 분석 요청</button></div></form>
    </section>
    <section className="section ceo-reports"><div className="section-heading"><h2>TARS 보고 기록</h2><Link to="/sessions">실행 세션 보기<ArrowUpRight size={14} /></Link></div>
      {reports.length ? reports.slice(0, 3).map(session => { const doc = data.documents.find(item => item.sessionId === session.id && item.kind === 'report'); return <article className="panel ceo-report" key={session.id}>
        <header><div><strong>{data.projects.find(project => project.id === session.projectId)?.name || '전체 프로젝트'} 현황 보고</strong><span>{time(session.startedAt)}</span></div><Badge status={session.status} /></header>
        {session.prompt && <p className="ceo-report-prompt">{session.prompt}</p>}
        {isLive(session.status) ? <p className="session-progress" role="status">{session.progress}</p> : session.status !== 'completed' ? <p className="error-box">{session.progress}</p> : null}
        {session.output && <div className="ceo-report-body"><Markdown>{session.output}</Markdown></div>}
        <footer><button className="text-button" onClick={() => open('sessionDetail', session)}>실행 기록<ArrowUpRight size={14} /></button>{doc && <button className="text-button" onClick={() => open('document', doc)}><FileText size={14} />보고서 열기</button>}{isLive(session.status) && <button className="button secondary" disabled={busy} onClick={() => fire(`/sessions/${session.id}/stop`, 'POST', {}, 'TARS 분석 중지를 요청했습니다.')}><Square size={13} />분석 중지</button>}</footer>
      </article>; }) : <div className="panel"><Empty compact title="아직 TARS 보고가 없습니다" description="현황 분석을 요청하면 프로젝트별 상태와 다음 조치가 보고서로 저장됩니다." /></div>}
    </section>
  </div>;
}
