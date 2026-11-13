import { useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowDownToLine, ArrowUpRight, Copy, RefreshCw, Send, Square, Terminal } from 'lucide-react';
import { useWorkspace } from './App';
import { api, canSteer, isLive, labels, providerLabel, time } from './api';
import { Badge, Empty } from './ui';

export const sessionTitle = (session, data) => session.kind === 'ceo_chat' ? 'TARS와 대화'
  : session.kind === 'oversight' ? '프로젝트 총괄 보고' : session.kind === 'plan' ? '협의 및 작업 설계'
    : session.kind === 'review' ? '결과 보고' : session.request?.task?.title || data.tasks.find(task => task.id === session.taskId)?.title || '작업 수행';

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* LAN HTTP uses the fallback below. */ }
  }
  const previous = document.activeElement;
  const field = document.createElement('textarea');
  field.value = text;
  field.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
  (document.querySelector('dialog[open]') || document.body).append(field);
  field.select();
  try { if (!document.execCommand('copy')) throw new Error('출력을 선택해 직접 복사해주세요.'); }
  finally { field.remove(); previous?.focus(); }
}

export function SessionTerminal({ session, visible = true }) {
  const { data, fire, perform, busy } = useWorkspace();
  const viewport = useRef(null);
  const [follow, setFollow] = useState(true);
  const [copyStatus, setCopyStatus] = useState('');
  const [prompt, setPrompt] = useState('');
  const [inputError, setInputError] = useState('');
  const sending = useRef(false);
  const inputId = useId();
  const live = isLive(session.status);
  const query = useQuery({
    queryKey: ['session-terminal', session.id, session.status],
    queryFn: ({ signal }) => api(`/sessions/${session.id}/terminal`, 'GET', undefined, { signal }),
    enabled: visible,
    refetchInterval: visible && live ? 1500 : false, refetchIntervalInBackground: false, staleTime: 1000,
  });
  const member = data.members.find(item => item.id === session.memberId);
  const content = (query.data?.content || '') + (query.data?.legacy && session.output ? `\n[AI RESULT]\n${session.output}` : '');
  useEffect(() => {
    if (visible && follow && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [content, follow, visible]);
  async function steer(event) {
    event.preventDefault();
    const message = prompt.trim();
    if (!message || busy || sending.current || !canSteer(session)) return;
    sending.current = true;
    setInputError('');
    try {
      await perform(`/sessions/${session.id}/steer`, 'POST', { prompt: message }, '추가 지시를 보냈습니다.');
      setPrompt(value => value.trim() === message ? '' : value);
      setFollow(true);
    } catch (error) { setInputError(error.message); }
    finally { sending.current = false; }
  }
  return <section className="session-terminal" aria-label={`${member?.name || 'AI'} CLI 세션`}>
    <header className="terminal-title"><Terminal size={16} /><strong>{member?.name || 'AI'}</strong><span>{providerLabel(session)} / {session.model === 'default' ? '기본 모델' : session.model} · {session.transport === 'app-server' ? 'App Server' : 'CLI'}</span><Badge status={session.status} /></header>
    <div className="terminal-context"><strong>{sessionTitle(session, data)}</strong><span>{session.workspace || '작업 디렉토리 준비 중'}</span></div>
    <div className="terminal-actions"><span className={live ? 'terminal-live' : ''}>{live ? 'LIVE' : 'HISTORY'} · {time(session.startedAt)}</span><div>
      <button type="button" aria-pressed={follow} title="최신 출력 따라가기" onClick={() => setFollow(value => !value)}><ArrowDownToLine size={14} />{follow ? '자동 스크롤' : '최신 출력'}</button>
      <button type="button" aria-label="CLI 출력 새로고침" onClick={() => query.refetch()} disabled={query.isFetching}><RefreshCw size={14} /></button>
      <button type="button" disabled={!content} title="표시된 출력 복사" onClick={async () => { try { await copyText(content); setCopyStatus('복사했습니다.'); } catch (error) { setCopyStatus(error.message); } }}><Copy size={14} /></button>
      {live && <button type="button" className="terminal-stop" disabled={busy || session.status === 'stopping'} onClick={() => fire(`/sessions/${session.id}/stop`, 'POST', {}, '세션 중지를 요청했습니다.')}><Square size={12} />중지</button>}
    </div></div>
    {query.isError && <p className="terminal-error" role="alert">{query.error.status === 404 ? 'CLI 출력 기능을 적용하려면 백엔드를 재시작해주세요.' : query.error.message}</p>}
    {query.data?.legacy && <p className="terminal-note">이전 세션에는 요약 로그만 남아 있습니다. 상세 출력은 변경 적용 후 시작한 세션부터 기록됩니다.</p>}
    {query.data?.truncated && <p className="terminal-note">최근 출력 48 KiB를 표시합니다.</p>}
    <pre ref={viewport} className="terminal-output" tabIndex={0} aria-label="CLI 실행 출력" onScroll={event => { if (!visible) return; const node = event.currentTarget; setFollow(node.scrollHeight - node.scrollTop - node.clientHeight < 40); }}>{content || (query.isPending ? 'CLI 기록을 불러오는 중…' : live ? 'CLI 출력을 기다리고 있습니다…' : '남아 있는 CLI 출력이 없습니다.')}</pre>
    {canSteer(session) && <form className="terminal-composer" onSubmit={steer}>
      <label htmlFor={inputId}>진행 중인 작업에 추가 지시</label>
      <div><textarea id={inputId} rows={2} maxLength={16000} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="현재 작업에 반영할 내용을 입력하세요." /><button type="submit" disabled={busy || !prompt.trim()}><Send size={14} />보내기</button></div>
    </form>}
    {inputError && <p className="terminal-error" role="alert">{inputError}</p>}
    <footer className="terminal-footer"><span>{session.progress}</span><small role="status">{copyStatus || 'CLI 출력 보기'}</small></footer>
  </section>;
}

export function TeamConsole({ compact = false, initialSessionId = '', visible = true }) {
  const { data, open } = useWorkspace();
  const initial = data.sessions.find(session => session.id === initialSessionId);
  const [memberId, setMemberId] = useState(initial?.memberId || '');
  const [sessionId, setSessionId] = useState(initial?.id || 'latest');
  const [liveOnly, setLiveOnly] = useState(false);
  const members = data.members.filter(member => (!compact || member.role !== 'ceo')
    && (!liveOnly || data.sessions.some(session => session.memberId === member.id && isLive(session.status))))
    .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || a.name.localeCompare(b.name));
  const member = members.find(item => item.id === memberId) || members[0];
  const sessions = data.sessions.filter(session => session.memberId === member?.id && (!liveOnly || isLive(session.status)));
  const session = sessions.find(item => item.id === sessionId)
    || sessions.find(item => item.id === member?.currentSessionId) || sessions[0];
  return <section className={`team-console ${compact ? 'compact' : ''}`}>
    <div className="console-heading"><h2><Terminal size={17} />{compact ? '팀원 CLI' : 'AI 세션 콘솔'}</h2><label><input type="checkbox" checked={liveOnly} onChange={event => setLiveOnly(event.target.checked)} />실행 중만</label>{compact && <Link to="/sessions" aria-label="전체 세션 콘솔"><ArrowUpRight size={16} /></Link>}</div>
    <div className="console-members" aria-label="세션을 볼 AI 선택">{members.map(item => <button key={item.id} type="button" aria-pressed={member?.id === item.id} onClick={() => { setMemberId(item.id); setSessionId('latest'); }}><i className={item.status === 'running' ? 'active' : ''} /><span>{item.name}</span><small>{providerLabel(item)} · {item.role === 'ceo' ? 'CEO' : item.role === 'leader' ? '팀장' : '팀원'}</small></button>)}</div>
    {member && <div className="console-session-select"><label>실행 기록<select aria-label={`${member.name} 실행 세션 선택`} value={sessionId === 'latest' || !sessions.some(item => item.id === sessionId) ? 'latest' : sessionId} onChange={event => setSessionId(event.target.value)}><option value="latest">현재 / 최근 세션</option>{sessions.map(item => <option key={item.id} value={item.id}>{time(item.startedAt)} · {providerLabel(item)} · {sessionTitle(item, data)} · {labels[item.status] || item.status}</option>)}</select></label>{session && <Link to={`/sessions?session=${session.id}`} title="이 세션 전체 화면"><ArrowUpRight size={15} /></Link>}</div>}
    {session && <div className="console-record-link"><button type="button" className="text-button" onClick={() => open('sessionDetail', session)}>지시 · 결과 · 상태 이력<ArrowUpRight size={13} /></button></div>}
    {session ? <SessionTerminal key={session.id} session={session} visible={visible} /> : <div className="console-empty"><Empty compact title={members.length ? `${member?.name}의 실행 기록이 없습니다` : liveOnly ? '실행 중인 AI가 없습니다' : '등록된 팀원이 없습니다'} description="팀장이 협의하거나 팀원이 작업을 시작하면 CLI 출력을 확인할 수 있습니다." /></div>}
  </section>;
}

export function Sessions() {
  const [params] = useSearchParams();
  const selected = params.get('session') || '';
  return <div className="page sessions-page"><div className="page-heading"><div><p className="eyebrow">LIVE EXECUTION</p><h1>실행 세션</h1><p>AI를 선택해 실행 명령, 도구 작업과 응답을 CLI 창에서 확인하세요.</p></div></div><TeamConsole key={selected} initialSessionId={selected} /></div>;
}
