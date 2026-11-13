import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, FileText, GitBranch, MessageSquare, Search, Terminal } from 'lucide-react';
import { useWorkspace } from './App';
import { labels, time } from './api';
import { Badge, Empty, Markdown } from './ui';
import { requestFlows } from './request-flow';
import { WorkApprovals } from './WorkApprovals';
import './request-flow.css';

const executionNames = { plan: '팀장 협의·설계', ceo_chat: 'CEO 협의', member_chat: '업무 협의', work: '작업 수행', task_review: '결과 검토', request_report: '최종 보고', request_escalation: '차단 보고', user_followup: '승인·의견 후속 처리' };

function Stage({ title, status, detail }) {
  return <div className={`request-stage ${status}`}><span className="request-stage-marker" /><div><strong>{title}</strong><small>{detail}</small></div></div>;
}

export function RequestFlow() {
  const { data, open } = useWorkspace();
  const [search, setSearch] = useState('');
  const [showCompleted, setShowCompleted] = useState(true);
  const term = search.trim().toLocaleLowerCase();
  const flows = requestFlows(data).filter(flow => (showCompleted || !flow.complete)
    && (!term || [flow.request.instruction, flow.request.title,
      ...flow.tasks.map(task => task.title)].filter(Boolean).join(' ').toLocaleLowerCase().includes(term)));
  const projectName = id => data.projects.find(project => project.id === id)?.name || '소스 미지정';
  const memberName = id => data.members.find(member => member.id === id)?.name || '담당 AI 미지정';
  return <div className="page request-flow-page">
    <div className="page-heading"><div><p className="eyebrow">AI WORKFLOW</p><h1>업무 흐름</h1><p>팀장·CEO가 등록한 업무별로 누가 무엇을 했는지와 결과 보고를 확인하세요.</p></div><Link className="button primary" to="/ceo"><MessageSquare size={16} />TARS에게 지시하기</Link></div>
    <div className="toolbar request-flow-toolbar"><label className="search-input"><Search size={16} /><input type="search" aria-label="업무와 작업 검색" placeholder="업무 · 담당 작업 검색" value={search} onChange={event => setSearch(event.target.value)} /></label><label className="checkbox-label"><input type="checkbox" checked={showCompleted} onChange={event => setShowCompleted(event.target.checked)} />보고 완료 포함</label><span className="toolbar-count">{flows.length}건</span></div>
    {flows.length ? <div className="request-flow-list">{flows.map(flow => {
      const { request, tasks, sessions, documents, reviews, reports, jobs } = flow;
      const submitted = tasks.filter(task => ['review', 'done'].includes(task.status)).length;
      const reviewed = tasks.filter(task => task.status === 'done').length;
      const finalReport = documents.find(doc => doc.id === request.reportDocumentId);
      return <article className="panel request-flow-card" key={request.id}>
        <header><div><span className="request-flow-kicker">{request.registeredAt ? '업무 등록' : '이전 업무'} · {time(request.registeredAt || request.createdAt || request.updatedAt)} · {request.registeredAt ? memberName(request.createdBy) : '등록 주체 미확인'} · {projectName(request.projectId)}</span><h2>{request.title || request.instruction}</h2><p>{request.instruction}</p></div><Badge status={flow.waiting ? request.status : flow.complete ? 'done' : flow.blocked ? 'blocked' : flow.active ? 'running' : 'planned'}>{flow.waiting ? labels[request.status] : flow.complete ? '사용자 확인 완료' : request.status === 'revision_requested' ? '의견 반영 중' : flow.blocked ? '확인 필요' : flow.active ? '진행 중' : request.paused ? '일시 중지' : '등록됨'}</Badge></header>
        <div className="request-stages" aria-label="업무 진행 단계">
          <Stage title="업무 등록" status="done" detail={request.registeredAt ? "목표와 범위 등록됨" : "기존 작업 기록 보존"} />
          <Stage title="요구사항 · 설계" status={flow.hasDesign ? 'done' : sessions.some(session => ['plan', 'ceo_chat'].includes(session.kind) && ['preparing', 'running'].includes(session.status)) ? 'current' : 'pending'} detail={flow.hasDesign ? '협의 문서와 설계 사양 저장됨' : '문서 기록 대기'} />
          <Stage title="사용자 협의 승인" status={request.approvedPlanId && request.status !== 'awaiting_approval' && request.status !== 'revision_requested' ? 'done' : request.status === 'awaiting_approval' ? 'current' : 'pending'} detail={request.status === 'awaiting_approval' ? '협의안을 보고 승인 또는 의견 전달' : request.approvedPlanId ? '승인한 범위에 따라 진행' : '협의안 제출 대기'} />
          <Stage title="하위 AI 작업" status={tasks.length ? tasks.every(task => task.status === 'done') ? 'done' : 'current' : 'pending'} detail={tasks.length ? `${tasks.length}건 · 완료 ${reviewed}건` : '생성된 작업 없음'} />
          <Stage title="결과 검토" status={tasks.length && reviewed === tasks.length ? 'done' : submitted ? 'current' : 'pending'} detail={tasks.length ? `${reviews.length}건 검토 · ${submitted}건 결과 제출` : '검토 대상 없음'} />
          <Stage title="결과 보고 · 사용자 확인" status={finalReport && flow.complete ? 'done' : request.status === 'awaiting_acceptance' || jobs.some(job => ['request_report', 'request_escalation'].includes(job.kind) && ['queued', 'running'].includes(job.status)) ? 'current' : 'pending'} detail={finalReport ? flow.complete ? '사용자 확인 완료' : '보고서 확인 후 승인 또는 의견 전달' : '보고 대기'} />
        </div>
        <WorkApprovals requestId={request.id} />
        {finalReport && !(data.workApprovals || []).some(item => item.requestId === request.id && item.kind === 'report') && <section className="request-final-report"><h3>{request.status === 'reported' ? '최종 결과 보고' : '진행·차단 보고'}</h3><Markdown>{finalReport.content}</Markdown><button type="button" className="text-button" onClick={() => open('document', finalReport)}>보고서 열기<ArrowUpRight size={13} /></button></section>}
        {(documents.length > 0 || tasks.length > 0 || sessions.length > 0) && <div className="request-flow-details">
          {documents.length > 0 && <div><h3><FileText size={15} />문서</h3>{documents.map(doc => <button key={doc.id} type="button" className="text-button" onClick={() => open('document', doc)}>{doc.title}<ArrowUpRight size={13} /></button>)}</div>}
          {tasks.length > 0 && <div><h3><GitBranch size={15} />AI 작업</h3>{tasks.map(task => <button key={task.id} type="button" className="request-task-link" onClick={() => open('taskDetail', task)}><span>{task.title}<small>{memberName(task.assigneeId)} · {labels[task.status] || task.status}{task.dependsOn?.length ? ` · 선행 ${task.dependsOn.length}건` : ''}</small></span><Badge status={task.status} /></button>)}</div>}
          {sessions.length > 0 && <div><h3><Terminal size={15} />업무 수행 흐름 · {sessions.length}건</h3>{sessions.map(session => <button key={session.id} type="button" className="text-button" onClick={() => open('sessionDetail', session)}>{memberName(session.memberId)} · {executionNames[session.kind] || '실행'} · {labels[session.status] || session.status} · {time(session.startedAt)}<ArrowUpRight size={13} /></button>)}</div>}
          {reports.length > 0 && <p className="request-flow-note">작업 결과 {reports.length}건과 검토 {reviews.length}건이 기록되어 있습니다.</p>}
        </div>}
      </article>;
    })}</div> : <div className="panel"><Empty title={term ? '일치하는 업무가 없습니다' : '등록된 업무가 없습니다'} description={term ? '검색어 또는 완료 포함 설정을 바꿔보세요.' : '팀장 또는 CEO와 목표와 범위를 정리하면 AI가 업무를 등록합니다. 등록된 업무의 작업 과정과 결과가 여기에 모입니다.'} /></div>}
  </div>;
}
