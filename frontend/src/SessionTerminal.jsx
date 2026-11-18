import { useRecord } from './record-details';
import { SessionQuestions } from './SessionQuestions';
import { SessionInteractions } from './SessionInteractions';
import { DiffView } from './ChangeReview';
import { useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowDownToLine, ArrowUpRight, Copy, RefreshCw, Send, Square, Terminal } from 'lucide-react';
import { useWorkspace } from './App';
import { api, canSteer, isLive, labels, providerLabel, time } from './api';
import { Badge, Empty } from './ui';
import { MemberChat } from './MemberChat';
import { sessionTitle } from './session-list';
import { ChatInput } from './ChatInput';
import { chatCommands } from './chat-completions';

export { sessionTitle } from './session-list';
export { Sessions } from './Sessions';

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

export function SessionTerminal({ session: summarySession, visible = true }) {
  const { record: session } = useRecord('sessions', summarySession, visible);
  const { data, fire, perform, busy, open } = useWorkspace();
  const viewport = useRef(null);
  const [log, setLog] = useState(null);
  const [handoff, setHandoff] = useState('');
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
    refetchInterval: false, refetchIntervalInBackground: false, staleTime: 1000,
  });
  const member = data.members.find(item => item.id === session.memberId);
  useEffect(() => { if (query.data) setLog(query.data); }, [query.data]);
  useEffect(() => {
    if (!visible || !live || !query.data) return;
    const stream = new EventSource(`/api/sessions/${session.id}/terminal/stream?offset=${query.data.nextOffset || 0}`);
    stream.onmessage = event => { const chunk = JSON.parse(event.data); setLog(current => {
      if (current && chunk.nextOffset <= current.nextOffset) return current;
      return { ...chunk, start: current?.start ?? chunk.start, content: (current?.content || '') + chunk.content };
    }); };
    return () => stream.close();
  }, [visible, live, session.id, query.data]);
  const content = (log?.content || '') + (query.data?.legacy && session.output ? `\n[AI RESULT]\n${session.output}` : '');
  useEffect(() => {
    if (visible && follow && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [content, follow, visible]);
  async function steer(event) {
    event.preventDefault();
    const message = prompt.trim();
    if (!message || busy || sending.current || (!canSteer(session) && live)) return;
    sending.current = true;
    setInputError('');
    try {
      if (message === '/stop') {
        if (!live || session.status === 'stopping') throw new Error('중지할 응답이 없습니다.');
        await perform(`/sessions/${session.id}/stop`, 'POST', {}, '실행 중지를 요청했습니다.');
        setPrompt(''); return;
      }
      if (/^\/[a-z][a-z-]*(?:\s|$)/i.test(message)) throw new Error('이 실행 기록에서는 /stop과 $ 스킬 선택을 사용할 수 있습니다. 다른 대화 명령은 AI 대화창에서 사용하세요.');
      const next = await perform(`/sessions/${session.id}/${live ? 'steer' : 'continue'}`, 'POST', { prompt: message }, live ? '추가 지시를 보냈습니다.' : '같은 세션에서 새 실행을 시작합니다.');
      if (!live) open('sessionDetail', next);
      setPrompt(value => value.trim() === message ? '' : value);
      setFollow(true);
    } catch (error) { setInputError(error.message); }
    finally { sending.current = false; }
  }
  return <section className="session-terminal" aria-label={`${member?.name || 'AI'} 실행 기록`}>
    <header className="terminal-title"><Terminal size={16} /><strong>{member?.name || 'AI'}</strong><span>{providerLabel(session)} / {session.model === 'default' ? '기본 모델' : session.model} · {session.transport === 'app-server' ? 'App Server' : 'CLI'}</span><Badge status={session.interactionState || session.status} /></header>
    <div className="terminal-context"><strong>{sessionTitle(session, data)}</strong><span>{session.workspace || '작업 디렉토리 준비 중'}</span></div>
    <div className="terminal-actions"><span className={live ? 'terminal-live' : ''}>{live ? 'LIVE' : 'HISTORY'} · {time(session.startedAt)}</span><div>
      <button type="button" aria-pressed={follow} title="최신 출력 따라가기" onClick={() => setFollow(value => !value)}><ArrowDownToLine size={14} />{follow ? '자동 스크롤' : '최신 출력'}</button>
      <button type="button" aria-label="CLI 출력 새로고침" onClick={() => query.refetch()} disabled={query.isFetching}><RefreshCw size={14} /></button>
      <button type="button" disabled={!content} title="표시된 출력 복사" onClick={async () => { try { await copyText(content); setCopyStatus('복사했습니다.'); } catch (error) { setCopyStatus(error.message); } }}><Copy size={14} /></button>
      {live && <button type="button" className="terminal-stop" disabled={busy || session.status === 'stopping'} onClick={() => fire(`/sessions/${session.id}/stop`, 'POST', {}, '실행 중지를 요청했습니다.')}><Square size={12} />중지</button>}
    </div></div>
    {query.isError && <p className="terminal-error" role="alert">{query.error.status === 404 ? 'CLI 출력 기능을 적용하려면 백엔드를 재시작해주세요.' : query.error.message}</p>}
    {query.data?.legacy && <p className="terminal-note">이전 실행에는 요약 로그만 남아 있습니다. 상세 출력은 변경 적용 후 시작한 실행부터 기록됩니다.</p>}
    {log?.start > 0 && <button className="text-button" type="button" onClick={async () => {
      try { const previous = await api(`/sessions/${session.id}/terminal?before=${log.start}`); setFollow(false); setLog(current => ({ ...current, start: previous.start, content: previous.content + current.content })); }
      catch (error) { setInputError(error.message); }
    }}>이전 출력 더 보기</button>}
    {!live && session.providerSessionId && <div className="terminal-handoff"><button type="button" className="button secondary" disabled={busy} onClick={async () => {
      try { const result = await perform(`/sessions/${session.id}/handoff`, 'POST', { locked: !session.handoffAt }, session.handoffAt ? 'CLI 인계를 종료했습니다.' : 'CLI에 인계했습니다. TARS의 실행을 잠갔습니다.'); setHandoff(result.locked ? result.command : ''); }
      catch (error) { setInputError(error.message); }
    }}>{session.handoffAt ? 'CLI 인계 종료' : '터미널로 인계'}</button>{handoff && <><pre>{handoff}</pre><button type="button" onClick={() => copyText(handoff).catch(error => setInputError(error.message))}>명령 복사</button></>}</div>}
    <SessionQuestions sessionId={session.id} />
    <pre ref={viewport} className="terminal-output" tabIndex={0} aria-label="CLI 실행 출력" onScroll={event => { if (!visible) return; const node = event.currentTarget; setFollow(node.scrollHeight - node.scrollTop - node.clientHeight < 40); }}>{content || (query.isPending ? 'CLI 기록을 불러오는 중…' : live ? 'CLI 출력을 기다리고 있습니다…' : '남아 있는 CLI 출력이 없습니다.')}</pre>
    <SessionInteractions session={session} />
    {session.diff && <details><summary>현재 응답의 파일 변경{session.diffTruncated ? " (일부 표시)" : ""}</summary><DiffView patch={session.diff} /></details>}
    {(canSteer(session) || (!live && session.providerSessionId && !member?.handoffSessionId)) && <form className="terminal-composer" onSubmit={steer}>
      <label htmlFor={inputId}>{!live ? '같은 세션에서 이어서 실행' : session.inputMode === 'queued' ? '현재 응답 후 이어서 처리할 추가 지시' : '진행 중인 작업에 추가 지시'}</label>
      <div><ChatInput member={{ ...member, id: session.memberId, provider: session.provider, codexAccount: session.codexAccount }} projectId={session.projectId} sessionId={session.id} commands={chatCommands({ terminal: true, current: live ? session : null })}
        id={inputId} rows={2} maxLength={16000} value={prompt} onChange={setPrompt} placeholder="현재 작업에 반영할 내용… / 명령 · $ 스킬" /><button type="submit" disabled={busy || !prompt.trim()}><Send size={14} />보내기</button></div>
    </form>}
    {inputError && <p className="terminal-error" role="alert">{inputError}</p>}
    <footer className="terminal-footer"><span>{session.progress}</span><small role="status">{copyStatus || 'CLI 출력 보기'}</small></footer>
  </section>;
}

export function TeamConsole({ compact = false, initialSessionId = '', initialMemberId = '', role, visible = true, sidebar }) {
  const { data } = useWorkspace();
  const initial = data.sessions.find(session => session.id === initialSessionId);
  const [memberId, setMemberId] = useState(initialMemberId || initial?.memberId || '');
  const members = data.members.filter(member => (!compact || member.role !== 'ceo') && (!role || member.role === role))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  const member = members.find(item => item.id === memberId) || members[0];
  const console = <section className={`team-console ${compact ? 'compact' : ''}`}>
    <div className="console-heading"><h2><Terminal size={17} />AI와 대화</h2>{compact && <Link to="/sessions" aria-label="전체 AI 대화"><ArrowUpRight size={16} /></Link>}</div>
    <div className="console-members" aria-label="대화할 AI 이름">{members.map(item => <button key={item.id} type="button" aria-pressed={member?.id === item.id} onClick={() => setMemberId(item.id)}><i className={item.status === 'running' ? 'active' : ''} /><span>{item.name}</span><small>{item.role === 'ceo' ? 'CEO' : item.role === 'leader' ? '팀장' : '팀원'}</small></button>)}</div>
    {member && visible ? <MemberChat key={member.id} member={member} /> : <div className="console-empty"><Empty compact title="대화할 AI가 없습니다" description="조직 관리에서 팀장이나 팀원을 추가하세요." /></div>}
  </section>;
  return sidebar ? <div className="consultation-layout">{console}{member && sidebar(member)}</div> : console;
}
