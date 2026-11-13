import { useId, useLayoutEffect, useRef, useState } from 'react';
import { MessageSquare, Send, Settings2, Square, Terminal } from 'lucide-react';
import { useWorkspace } from './App';
import { canSteer, isLive, providerLabel, time } from './api';
import { Badge } from './ui';
import { StreamingMarkdown, useConversationScroll } from './StreamingMarkdown';
import { SessionActivity } from './SessionActivity';
import { PendingApprovals } from './WorkApprovals';

export function MemberChat({ member }) {
  const { data, open, perform, busy } = useWorkspace();
  const [projectId, setProjectId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState('');
  const [help, setHelp] = useState(false);
  const [limit, setLimit] = useState(30);
  const sending = useRef(false);
  const viewport = useRef(null);
  const content = useRef(null);
  const anchor = useRef(null);
  const hintId = useId();
  const conversations = data.sessions.filter(session => session.memberId === member.id && !session.superseded);
  const messages = conversations.slice(0, limit).reverse();
  const current = conversations.find(session => isLive(session.status));
  const steering = canSteer(current);
  const atCapacity = data.sessions.filter(session => isLive(session.status)).length >= data.settings.maxConcurrent;
  const unavailable = busy || (!steering && (Boolean(current) || member.status === 'running' || atCapacity));
  const { follow, setFollow, scrollHandlers } = useConversationScroll(viewport, content, member.id);
  const department = data.departments.find(item => item.id === member.departmentId);
  const sourceProject = data.projects.find(item => item.id === department?.projectId);
  function older() {
    if (anchor.current || conversations.length <= limit || !viewport.current) return;
    setFollow(false);
    anchor.current = { height: viewport.current.scrollHeight, top: viewport.current.scrollTop };
    setLimit(value => value + 30);
  }
  useLayoutEffect(() => {
    if (!anchor.current || !viewport.current) return;
    viewport.current.scrollTop = anchor.current.top + viewport.current.scrollHeight - anchor.current.height;
    anchor.current = null;
  }, [limit]);
  async function send(event, input) {
    event.preventDefault();
    const message = (input ?? prompt).trim();
    if (!message || sending.current || busy) return;
    if (message === '/help') { setHelp(value => !value); if (input == null) setPrompt(''); return; }
    if (message !== '/stop' && message !== '/clear' && unavailable) return;
    sending.current = true;
    setError('');
    try {
      if (message === '/clear') {
        if (current || member.status === 'running') throw new Error('진행 중인 응답이나 작업을 중지하거나 끝난 뒤 새 대화를 시작하세요.');
        await perform(`/members/${member.id}/chat/clear`, 'POST', {}, `${member.name}의 대화 문맥을 초기화했습니다. 이전 기록은 보존됩니다.`);
        setHelp(false);
      } else if (message === '/stop') {
        if (!current) throw new Error('진행 중인 응답이 없습니다.');
        await perform(`/sessions/${current.id}/stop`, 'POST', {}, `${member.name}의 응답 중지를 요청했습니다.`);
      } else if (steering) {
        await perform(`/sessions/${current.id}/steer`, 'POST', { prompt: message }, `${member.name}에게 추가 지시를 보냈습니다.`);
      } else {
        await perform(`/members/${member.id}/chat`, 'POST', { prompt: message, projectId: member.role === 'ceo' ? projectId || null : undefined }, `${member.name}에게 메시지를 보냈습니다.`);
      }
      if (input == null) setPrompt(value => value.trim() === message ? '' : value);
      setFollow(true);
    } catch (issue) { setError(issue.message); }
    finally { sending.current = false; }
  }
  return <section className="ceo-chat member-chat" aria-label={`${member.name}와 대화`}>
    <header className="ceo-chat-header"><MessageSquare size={21} /><div><h2>{member.name} <Badge status={member.status} /></h2><p>{providerLabel(member)} · {member.model || 'CLI 기본 모델'}</p></div><button className="icon-button" type="button" aria-label={`${member.name} 모델 및 지침 설정`} disabled={member.status === 'running'} onClick={() => member.role === 'ceo' ? open('ceoSettings') : open('member', member)}><Settings2 size={17} /></button></header>
    <div className="ceo-chat-scope">{member.role === 'ceo' ? <label>소스 범위<select aria-label={`${member.name} 소스 범위`} value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">지정하지 않음</option>{data.projects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label> : <span>{department?.name} · {member.role === 'leader' ? '팀장' : '팀원'}{sourceProject ? ` · ${sourceProject.name}` : ''}</span>}<button type="button" className="text-button" disabled={busy || Boolean(current) || member.status === 'running'} title="이전 기록을 보존하고 대화 문맥을 초기화합니다. 진행 중인 응답이나 작업이 끝난 뒤 사용할 수 있습니다." onClick={event => send(event, '/clear')}>새 대화</button></div>
    <div className="ceo-chat-history">
      <div className="ceo-chat-messages" ref={viewport} tabIndex={0} aria-label={`${member.name} 대화 기록`} {...scrollHandlers} onScroll={event => { scrollHandlers.onScroll(event); if (!follow && event.target === event.currentTarget && event.currentTarget.scrollTop < 60) older(); }}>
        <div className="ceo-chat-message-list" ref={content}>
          {conversations.length > limit && <button type="button" className="text-button ceo-chat-older" onClick={older}>이전 대화 더 보기</button>}
          {!messages.length && <div className="ceo-chat-welcome"><MessageSquare size={30} /><h3>{member.name}에게 말을 걸어보세요.</h3><p>이 창에서 대화를 이어가고 이전 대화와 작업 결과를 확인할 수 있습니다.</p></div>}
          {messages.map(session => {
            const chat = ['ceo_chat', 'member_chat'].includes(session.kind);
            const task = data.tasks.find(item => item.id === session.taskId);
            const request = session.prompt || session.request?.task?.description || task?.description;
            return <div className="ceo-chat-turn" key={session.id}>
              {request && <article className="ceo-chat-message user"><header><strong>{chat ? '나' : task ? `작업 · ${task.title}` : '업무 · 협의 및 보고'}</strong><time>{time(session.startedAt)}</time></header><p>{request}</p></article>}
              {(session.steering || []).map(input => <article className="ceo-chat-message user follow-up" key={input.id}><header><strong>나 · 추가 지시</strong><time>{time(input.createdAt)}</time></header><p>{input.prompt}</p></article>)}
              <article className="ceo-chat-message assistant"><header><strong>{member.name}</strong>{session.status !== 'completed' && <Badge status={session.status} />}<button type="button" title="이 응답의 실행 기록" onClick={() => open('sessionDetail', session)}><Terminal size={13} />실행 기록</button></header>
                <StreamingMarkdown active={isLive(session.status)}>{session.output}</StreamingMarkdown>
                <SessionActivity session={session} />
                {!isLive(session.status) && session.status !== 'completed' && <p className="form-error">{session.progress}</p>}
              </article>
            </div>;
          })}
          <PendingApprovals memberId={member.id} />
        </div>
      </div>
      {!follow && <button className="ceo-chat-follow" type="button" onClick={() => setFollow(true)}>최신 대화로 이동 ↓</button>}
    </div>
    <form className="ceo-chat-composer" onSubmit={send}>
      <textarea aria-label={`${member.name}에게 보낼 메시지`} aria-describedby={hintId} rows={3} maxLength={16000} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={`${member.name}에게 메시지 보내기…`} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); event.currentTarget.form.requestSubmit(); } }} />
      {help && <p className="ceo-chat-feedback">Enter 전송 · Shift+Enter 줄바꿈 · /clear 새 대화(이전 기록 보존) · /stop 응답 중지 · /help 도움말. 위로 스크롤하면 이전 대화가 이어서 표시됩니다.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer><span id={hintId}>{steering ? '응답 중에도 추가 지시를 보낼 수 있습니다.' : current ? `${member.name}의 응답을 기다리고 있습니다.` : atCapacity ? '동시 실행 한도에 도달했습니다.' : 'Enter 전송 · Shift+Enter 줄바꿈'}</span><div className="ceo-chat-send-actions">
        {current && <button type="button" className="button secondary" disabled={busy || current.status === 'stopping'} onClick={event => send(event, '/stop')}><Square size={13} />중지</button>}
        <button className="button primary" type="submit" disabled={(['/help', '/stop', '/clear'].includes(prompt.trim()) ? busy : unavailable) || !prompt.trim()}><Send size={15} />{steering ? '추가 지시' : '보내기'}</button>
      </div></footer>
    </form>
  </section>;
}
