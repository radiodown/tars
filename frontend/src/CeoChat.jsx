import { useEffect, useRef, useState } from 'react';
import { Command, Send, Settings2, Square, Terminal } from 'lucide-react';
import { useWorkspace } from './App';
import { canSteer, isLive, providerLabel, time } from './api';
import { Badge, Markdown } from './ui';

const commands = [
  { name: '/clear', description: '이전 기록을 보관하고 새 대화 시작' },
  { name: '/stop', description: '현재 대화의 응답 중지' },
  { name: '/help', description: '대화 명령어 도움말' },
];
const commandName = message => /^\/[^/\s]*(?=\s|$)/.exec(message)?.[0]?.toLowerCase();

export function CeoChat() {
  const { data, open, perform, busy } = useWorkspace();
  const [projectId, setProjectId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState('');
  const [limit, setLimit] = useState(20);
  const [follow, setFollow] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [commandIndex, setCommandIndex] = useState(0);
  const [commandsDismissed, setCommandsDismissed] = useState(false);
  const sending = useRef(false);
  const viewport = useRef(null);
  const composer = useRef(null);
  const ceo = data.members.find(member => member.role === 'ceo');
  const conversationId = ceo?.chatConversationIds?.[projectId || 'all'] || null;
  const scopedConversations = data.sessions.filter(session => session.memberId === ceo?.id && session.kind === 'ceo_chat' && (session.projectId || '') === projectId);
  const hasArchived = scopedConversations.some(session => (session.conversationId || null) !== conversationId);
  const conversations = scopedConversations.filter(session => showArchived || (session.conversationId || null) === conversationId);
  const messages = conversations.slice(0, limit).reverse();
  const latest = messages.at(-1);
  const current = data.sessions.find(session => session.id === ceo?.currentSessionId);
  const atCapacity = data.sessions.filter(session => isLive(session.status)).length >= data.settings.maxConcurrent;
  const currentChat = current?.kind === 'ceo_chat' && (current.projectId || '') === projectId && (current.conversationId || null) === conversationId;
  const steering = currentChat && canSteer(current);
  const unavailable = busy || (!steering && (ceo?.status === 'running' || atCapacity));
  const commandQuery = prompt.trimStart().toLowerCase();
  const matchingCommands = /^\/\S*$/.test(commandQuery) ? commands.filter(command => command.name.startsWith(commandQuery)) : [];
  const commandsOpen = !commandsDismissed && matchingCommands.length > 0;
  const selectedCommand = matchingCommands[Math.min(commandIndex, matchingCommands.length - 1)];
  const pendingCommand = commandName(commandsOpen ? selectedCommand.name : prompt.trim());
  const submitUnavailable = pendingCommand ? busy && ['/clear', '/stop'].includes(pendingCommand) : unavailable;
  useEffect(() => {
    if (follow && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [latest?.id, latest?.output, latest?.status, latest?.steering?.length, follow, conversationId]);
  function changePrompt(value) {
    setPrompt(value); setCommandIndex(0); setCommandsDismissed(false);
  }
  function handleKeyDown(event) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (commandsOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        setCommandIndex(value => (value + direction + matchingCommands.length) % matchingCommands.length);
        return;
      }
      if (event.key === 'Escape') { event.preventDefault(); setCommandsDismissed(true); return; }
      if (event.key === 'Tab' && !event.shiftKey) {
        event.preventDefault(); setPrompt(selectedCommand.name); setCommandsDismissed(true); return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault(); event.currentTarget.form.requestSubmit();
    }
  }
  async function send(event, input, consumeDraft = true) {
    event.preventDefault();
    const draft = prompt;
    const message = (input ?? (commandsOpen ? selectedCommand.name : prompt)).trim();
    const command = commandName(message);
    if (!message || sending.current || (!command && unavailable) || (busy && ['/clear', '/stop'].includes(command))) return;
    sending.current = true;
    setError('');
    setFeedback('');
    try {
      if (command) {
        if (!commands.some(item => item.name === command)) throw new Error(`지원하지 않는 명령어입니다: ${command}. /help로 목록을 확인하세요.`);
        if (message.toLowerCase() !== command) throw new Error(`${command}는 추가 내용 없이 입력하세요.`);
        if (command === '/help') setShowHelp(true);
        else if (command === '/clear') {
          await perform('/ceo/chat/clear', 'POST', { projectId: projectId || null }, '이전 기록을 보관하고 새 대화를 시작했습니다.');
          setShowArchived(false); setShowHelp(false); setLimit(20);
          setFeedback('새 대화를 시작했습니다. 이전 대화는 기록으로 보관됩니다.');
        } else {
          if (!currentChat || !isLive(current.status)) throw new Error('현재 대화에서 응답 중인 세션이 없습니다.');
          if (current.status === 'stopping') throw new Error('이미 응답을 중지하고 있습니다.');
          await perform(`/sessions/${current.id}/stop`, 'POST', {}, 'TARS 응답 중지를 요청했습니다.');
          setFeedback('응답 중지를 요청했습니다.');
        }
      } else if (steering) await perform(`/sessions/${current.id}/steer`, 'POST', { prompt: message }, 'TARS에게 추가 지시를 보냈습니다.');
      else await perform('/ceo/chat', 'POST', { projectId: projectId || null, prompt: message }, 'TARS에게 메시지를 보냈습니다.');
      if (consumeDraft) setPrompt(value => value === draft ? '' : value);
      setFollow(true);
    } catch (issue) { setError(issue.status === 404 ? '대화 기능을 적용하려면 백엔드를 재시작해주세요.' : issue.message); }
    finally { sending.current = false; }
  }
  if (!ceo) return null;
  return <section className="ceo-chat" aria-label="TARS와 대화">
    <header className="ceo-chat-header"><Command size={23} /><div><h2>TARS <Badge status={ceo.status} /></h2><p>{providerLabel(ceo)} · {ceo.model || 'CLI 기본 모델'}</p></div><button className="icon-button" type="button" aria-label="TARS 모델 및 지침 설정" disabled={ceo.status === 'running'} onClick={() => open('ceoSettings')}><Settings2 size={17} /></button></header>
    <div className="ceo-chat-scope"><label>대화 범위<select value={projectId} onChange={event => { setProjectId(event.target.value); setLimit(20); setFollow(true); setError(''); setFeedback(''); setShowHelp(false); setShowArchived(false); }}><option value="">전체 프로젝트</option>{data.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>{hasArchived && <button type="button" className="text-button" aria-pressed={showArchived} onClick={() => { setShowArchived(value => !value); setLimit(20); setFollow(true); }}>{showArchived ? '현재 대화만 보기' : '이전 대화 보기'}</button>}<span>CEO · 프로젝트와 팀 운영</span></div>
    <div className="ceo-chat-messages" ref={viewport} tabIndex={0} aria-label="TARS 대화 기록" onScroll={event => { const node = event.currentTarget; setFollow(node.scrollHeight - node.scrollTop - node.clientHeight < 48); }}>
      {conversations.length > limit && <button className="text-button ceo-chat-older" onClick={() => { setFollow(false); setLimit(value => value + 20); }}>이전 대화 더 보기</button>}
      {!messages.length && <div className="ceo-chat-welcome"><Command size={32} /><h3>TARS와 이야기하세요.</h3><p>프로젝트 진행 상황부터 팀 구성과 다음 할 일까지 함께 정리합니다.</p>{['지금 팀원들은 어떤 작업을 하고 있어?', '현재 막힌 프로젝트와 다음 우선순위를 정리해줘.'].map(text => <button type="button" key={text} onClick={() => { setPrompt(text); composer.current?.focus(); }}>{text}</button>)}</div>}
      {messages.map(session => <div className="ceo-chat-turn" key={session.id}>
        <article className="ceo-chat-message user"><header><strong>나</strong>{(session.conversationId || null) !== conversationId && <span className="ceo-chat-archived">이전 대화</span>}<time>{time(session.startedAt)}</time></header><p>{session.prompt}</p></article>
        {(session.steering || []).map(input => <article className="ceo-chat-message user follow-up" key={input.id}><header><strong>나 · 추가 지시</strong><time>{time(input.createdAt)}</time></header><p>{input.prompt}</p></article>)}
        <article className="ceo-chat-message assistant"><header><strong>TARS</strong><Badge status={session.status} /><button type="button" title="이 응답의 CLI 세션 보기" onClick={() => open('sessionDetail', session)}><Terminal size={13} />CLI</button></header>
          {session.output && <Markdown>{session.output}</Markdown>}
          {isLive(session.status) && <p className="ceo-chat-progress" role="status">{session.progress}</p>}
          {!isLive(session.status) && session.status !== 'completed' && <p className="form-error">{session.progress}</p>}
        </article>
      </div>)}
    </div>
    {!follow && <button className="ceo-chat-follow" type="button" onClick={() => setFollow(true)}>최신 대화로 이동 ↓</button>}
    {current && !currentChat && <button className="ceo-chat-current" type="button" onClick={() => open('sessionDetail', current)}><Terminal size={14} />TARS가 다른 작업을 진행 중입니다 · CLI 보기</button>}
    <form className="ceo-chat-composer" onSubmit={send}>
      {commandsOpen && <div className="ceo-chat-commands" id="ceo-chat-commands" role="listbox" aria-label="대화 명령어">{matchingCommands.map((command, index) => <button type="button" key={command.name} id={`ceo-chat-command-${index}`} role="option" aria-selected={selectedCommand === command} onMouseEnter={() => setCommandIndex(index)} onMouseDown={event => event.preventDefault()} onClick={event => send(event, command.name)}><code>{command.name}</code><span>{command.description}</span></button>)}<p>↑↓ 선택 · Enter 실행 · Tab 완성 · Esc 닫기</p></div>}
      <textarea ref={composer} aria-label="TARS에게 보낼 메시지" aria-describedby="ceo-chat-input-hint" aria-autocomplete="list" aria-haspopup="listbox" aria-controls={commandsOpen ? 'ceo-chat-commands' : undefined} aria-activedescendant={commandsOpen ? `ceo-chat-command-${matchingCommands.indexOf(selectedCommand)}` : undefined} rows={3} maxLength={16000} value={prompt} onChange={event => changePrompt(event.target.value)} placeholder="TARS에게 메시지 보내기… (/ 명령어)" onKeyDown={handleKeyDown} />
      {showHelp && <div className="ceo-chat-help" role="region" aria-label="대화 명령어 도움말"><header><strong>대화 명령어</strong><button type="button" className="text-button" onClick={() => setShowHelp(false)}>닫기</button></header>{commands.map(command => <p key={command.name}><code>{command.name}</code><span>{command.description}</span></p>)}<small>/clear는 선택한 대화 범위에 적용됩니다. 응답 중에는 /stop으로 중지한 뒤 실행하세요.</small></div>}
      {feedback && <p className="ceo-chat-feedback" role="status">{feedback}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer><span id="ceo-chat-input-hint">{pendingCommand ? '명령어는 AI 호출 없이 처리합니다.' : steering ? '응답 중에도 추가 지시를 보낼 수 있습니다.' : ceo.status === 'running' ? 'TARS가 응답 중입니다.' : atCapacity ? '동시 실행 한도에 도달했습니다.' : 'Enter 전송 · Shift+Enter 줄바꿈 · / 명령어'}</span><div className="ceo-chat-send-actions">
        {currentChat && isLive(current.status) && <button type="button" className="button secondary" disabled={busy || current.status === 'stopping'} onClick={event => send(event, '/stop', false)}><Square size={13} />중지</button>}
        <button className="button primary" type="submit" disabled={submitUnavailable || !prompt.trim()}><Send size={15} />{pendingCommand ? '명령 실행' : steering ? '추가 지시' : '보내기'}</button>
      </div></footer>
    </form>
  </section>;
}
