import { SessionQuestions } from './SessionQuestions';
import { SessionInteractions } from './SessionInteractions';
import { useRecord } from './record-details';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { MessageSquare, Send, Settings2, Square, Terminal } from 'lucide-react';
import { useWorkspace } from './App';
import { canSteer, isLive, providerLabel, time } from './api';
import { Badge } from './ui';
import { StreamingMarkdown, useConversationScroll } from './StreamingMarkdown';
import { SessionActivity } from './SessionActivity';
import { PendingApprovals } from './WorkApprovals';
import { ChatInput } from './ChatInput';
import { chatCommands } from './chat-completions';
import './conversations.css';

export function MemberChat({ member, initialConversationId = '', memberPicker }) {
  const { data, open, perform, busy } = useWorkspace();
  const [projectId, setProjectId] = useState('');
  const [conversationId, setConversationId] = useState(initialConversationId);
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState('');
  const [help, setHelp] = useState(false);
  const [limit, setLimit] = useState(30);
  const sending = useRef(false);
  const composer = useRef(null);
  const viewport = useRef(null);
  const content = useRef(null);
  const anchor = useRef(null);
  const hintId = useId();
  const savedConversations = (data.conversations || []).filter(item => item.memberId === member.id);
  const selectedConversation = savedConversations.find(item => item.id === conversationId);
  const conversations = data.sessions.filter(session => session.memberId === member.id && session.conversationId === conversationId && !session.superseded);
  const messages = conversations.slice(0, limit).reverse();
  const current = conversations.find(session => isLive(session.status));
  const steering = canSteer(current) && ['ceo_chat', 'member_chat'].includes(current.kind);
  const atCapacity = data.sessions.filter(session => isLive(session.status)).length >= data.settings.maxConcurrent;
  const unavailable = busy || Boolean(member.handoffSessionId);
  const { follow, setFollow, scrollHandlers } = useConversationScroll(viewport, content, `${member.id}:${conversationId}`);
  const department = data.departments.find(item => item.id === member.departmentId);
  const sourceProject = data.projects.find(item => item.id === (selectedConversation ? selectedConversation.projectId : department?.projectId));
  const scope = [department?.name, !memberPicker && (member.role === 'leader' ? '팀장' : '팀원'), sourceProject?.name].filter(Boolean).join(' · ');
  const model = `${providerLabel(member)} · ${member.model || 'CLI 기본 모델'}`;
  const subtitle = memberPicker && scope ? `${scope} · ${model}` : model;
  const commands = chatCommands({ provider: member.provider, current, latest: conversations[0], locked: member.status === 'running' || Boolean(member.handoffSessionId) });
  function fillInput(value) {
    setPrompt(value);
    requestAnimationFrame(() => { composer.current?.focus(); composer.current?.setSelectionRange(value.length, value.length); });
  }
  async function selectConversation(value) {
    setError('');
    try {
      if (value) await perform(`/conversations/${value}/resume`, 'POST', {}, '세션을 열었습니다. 다음 메시지는 같은 문맥으로 이어집니다.');
      setConversationId(value); setLimit(30); setPrompt(''); setHelp(false); anchor.current = null;
    } catch (issue) { setError(issue.message); }
  }
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
    const command = commands.find(item => item.name === message.split(/\s/, 1)[0]);
    if (!command && unavailable) return;
    sending.current = true;
    setError('');
    try {
      if (/^\/[a-z][a-z-]*(?:\s|$)/i.test(message) && !command) throw new Error('지원하지 않는 대화 명령입니다. /help 또는 / 자동완성에서 사용할 수 있는 명령을 확인하세요.');
      if (command?.disabledReason) throw new Error(command.disabledReason);
      if (command && message !== command.name) throw new Error(`${command.name}은 인수 없이 입력하세요.`);
      if (command?.action === 'skills') { fillInput('$'); return; }
      if (command?.action === 'help') { setHelp(value => !value); }
      else if (command?.action === 'settings') { member.role === 'ceo' ? open('ceoSettings') : open('member', member); }
      else if (command?.action === 'status') { open('sessionDetail', conversations[0]); }
      else if (command?.action === 'clear') {
        if (current || member.status === 'running') throw new Error('진행 중인 응답이나 작업을 중지하거나 끝난 뒤 새 대화를 시작하세요.');
        const created = await perform(`/members/${member.id}/conversations`, 'POST', { projectId: member.role === 'ceo' ? selectedConversation?.projectId || projectId || null : undefined }, '새 세션을 만들었습니다.');
        setConversationId(created.id); setLimit(30); anchor.current = null;
        setHelp(false);
      } else if (command?.action === 'stop') {
        if (!current) throw new Error('진행 중인 응답이 없습니다.');
        await perform(`/sessions/${current.id}/stop`, 'POST', {}, `${member.name}의 응답 중지를 요청했습니다.`);
      } else if (steering) {
        await perform(`/sessions/${current.id}/steer`, 'POST', { prompt: message }, `${member.name}에게 추가 지시를 보냈습니다.`);
      } else {
        const result = await perform(`/members/${member.id}/chat`, 'POST', { prompt: message, conversationId: conversationId || undefined,
          projectId: selectedConversation ? selectedConversation.projectId : member.role === 'ceo' ? projectId || null : undefined }, `${member.name}에게 메시지를 보냈습니다.`);
        setConversationId(result.conversationId);
      }
      if (input == null) setPrompt(value => value.trim() === message ? '' : value);
      setFollow(true);
    } catch (issue) { setError(issue.message); }
    finally { sending.current = false; }
  }
  return <section className="ceo-chat member-chat" aria-label={`${member.name}와 대화`}>
    <div className="ceo-chat-top">
      <header className="ceo-chat-header">
        <MessageSquare size={21} />
        <div title={subtitle}><h2>{memberPicker || member.name} <Badge status={member.status} /></h2><p>{subtitle}</p></div>
        <button className="icon-button" type="button" aria-label={`${member.name} 모델 및 지침 설정`} disabled={member.status === 'running'} onClick={() => member.role === 'ceo' ? open('ceoSettings') : open('member', member)}><Settings2 size={17} /></button>
      </header>
      <div className="ceo-chat-controls">
        {(member.role === 'ceo' || !memberPicker) && <div className="ceo-chat-scope">
          {member.role === 'ceo' ? <label>소스 범위<select aria-label={`${member.name} 소스 범위`} disabled={Boolean(conversationId)} value={selectedConversation ? selectedConversation.projectId || '' : projectId} onChange={event => setProjectId(event.target.value)}><option value="">지정하지 않음</option>{data.projects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label> : <span>{scope}</span>}
        </div>}
        <div className="ceo-chat-scope conversation-picker">
          <label>세션<select aria-label={`${member.name} 세션 선택`} value={conversationId} disabled={busy} onChange={event => selectConversation(event.target.value)}><option value="">새 문맥으로 시작</option>{savedConversations.map(item => <option key={item.id} value={item.id}>{item.title} · {time(item.createdAt)}</option>)}</select></label>
          <button type="button" className="text-button" disabled={busy || Boolean(current) || member.status === 'running'} title="이전 세션을 보존하고 새로운 문맥으로 시작합니다." onClick={event => send(event, '/clear')}>새 세션</button>
          {conversationId && <button type="button" className="text-button" disabled={busy} title="세션 기록을 보존합니다. 진행 중인 실행은 계속됩니다." onClick={() => selectConversation('')}>세션 닫기</button>}
        </div>
      </div>
    </div>
    <div className="ceo-chat-history">
      <div className="ceo-chat-messages" ref={viewport} tabIndex={0} aria-label={`${member.name} 대화 기록`} {...scrollHandlers} onScroll={event => { scrollHandlers.onScroll(event); if (!follow && event.target === event.currentTarget && event.currentTarget.scrollTop < 60) older(); }}>
        <div className="ceo-chat-message-list" ref={content}>
          {conversations.length > limit && <button type="button" className="text-button ceo-chat-older" onClick={older}>이전 대화 더 보기</button>}
          {!messages.length && <p className="ceo-chat-welcome">아직 대화가 없습니다.</p>}
          {messages.map(session => {
            const chat = ['ceo_chat', 'member_chat'].includes(session.kind);
            const task = data.tasks.find(item => item.id === session.taskId);
            const request = session.prompt || session.request?.task?.description || task?.description;
            return <div className="ceo-chat-turn" key={session.id}>
              {request && <article className="ceo-chat-message user"><header><strong>{chat ? '나' : task ? `작업 · ${task.title}` : '업무 · 협의 및 보고'}</strong><time>{time(session.startedAt)}</time></header><p>{request}</p></article>}
              {(session.steering || []).map(input => <article className="ceo-chat-message user follow-up" key={input.id}><header><strong>나 · 추가 지시</strong><time>{time(input.createdAt)}</time></header><p>{input.prompt}</p></article>)}
              <article className="ceo-chat-message assistant"><header><strong>{member.name}</strong>{session.status !== 'completed' && <Badge status={session.status} />}<button type="button" title="이 응답의 실행 기록" onClick={() => open('sessionDetail', session)}><Terminal size={13} />실행 기록</button></header>
                <ChatOutput session={session} />
                <SessionActivity session={session} /><SessionQuestions sessionId={session.id} />
                {!isLive(session.status) && session.status !== 'completed' && <p className="form-error">{session.progress}</p>}
              </article>
            </div>;
          })}
          {(data.chatQueue || []).filter(item => item.memberId === member.id && item.conversationId === conversationId && ['queued', 'failed'].includes(item.status)).map(item => <section className="panel" key={item.id}><p>{item.prompt}</p><small>{item.status === 'queued' ? '현재 작업이 끝난 뒤 이 세션에서 대화합니다.' : item.error}</small>{item.status === 'queued' && <button className="text-button" onClick={() => perform(`/chat-queue/${item.id}/cancel`, 'POST', {}, '대기 메시지를 취소했습니다.').catch(() => {})}>취소</button>}</section>)}{conversationId && <PendingApprovals memberId={member.id} conversationId={conversationId} />}
        </div>
      </div>
      {!follow && <button className="ceo-chat-follow" type="button" onClick={() => setFollow(true)}>최신 대화로 이동 ↓</button>}
    </div>
    <form className="ceo-chat-composer" onSubmit={send}>
      <ChatInput inputRef={composer} member={member} projectId={selectedConversation ? selectedConversation.projectId : member.role === 'ceo' ? projectId : department?.projectId} sessionId={current?.id} commands={commands}
        aria-label={`${member.name}에게 보낼 메시지`} aria-describedby={hintId} rows={3} maxLength={16000} value={prompt} onChange={setPrompt} placeholder={`${member.name}에게 메시지 보내기… / 명령${member.provider === 'codex' ? ' · $ 스킬' : ''}`} />
      {help && <div className="chat-command-help"><p>Enter 전송 · Shift+Enter 줄바꿈 · ↑↓ 탐색 · Tab/Enter 자동완성 · Esc 닫기. 명령 선택 후 Enter를 한 번 더 누르면 실행합니다. 세션 선택으로 이전 문맥을 재개합니다.</p>
        {commands.map(command => <button type="button" key={command.name} onClick={() => fillInput(`${command.name} `)}><code>{command.name}</code><span>{command.description}</span></button>)}
      </div>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer><span id={hintId} data-idle={!current && !atCapacity}>{steering ? current?.inputMode === 'queued' ? '추가 지시는 현재 응답이 끝난 뒤 이어서 처리합니다.' : '응답 중에도 추가 지시를 보낼 수 있습니다.' : current ? `${member.name}의 응답을 기다리고 있습니다.` : atCapacity ? '동시 실행 한도에 도달했습니다.' : 'Enter 전송 · Shift+Enter 줄바꿈'}</span><div className="ceo-chat-send-actions">
        {current && <button type="button" className="button secondary" disabled={busy || current.status === 'stopping'} onClick={event => send(event, '/stop')}><Square size={13} />중지</button>}
        <button className="button primary" type="submit" disabled={(commands.some(command => command.name === prompt.trim()) ? busy : unavailable) || !prompt.trim()}><Send size={15} />{steering ? '추가 지시' : '보내기'}</button>
      </div></footer>
    </form>
  </section>;
}

function ChatOutput({ session }) {
  const { record, isError, error } = useRecord('sessions', session);
  return <>{isError ? <p role="alert">{error.message}</p> : <StreamingMarkdown active={isLive(session.status)}>{record.output || record.outputPreview}</StreamingMarkdown>}<SessionInteractions session={record} /></>;
}
