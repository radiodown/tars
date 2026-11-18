import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { completionContext, completionItems, insertCompletion } from './chat-completions';
import './chat-input.css';

export function ChatInput({ member, projectId = null, sessionId, commands = [], value, onChange, inputRef, enterToSend = true, ...props }) {
  const ownRef = useRef(null);
  const field = inputRef || ownRef;
  const listId = useId();
  const [selection, setSelection] = useState({ start: value.length, end: value.length });
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(null);
  const [active, setActive] = useState(0);
  const pendingCaret = useRef(null);
  const list = useRef(null);
  const context = completionContext(value, selection.start, selection.end);
  const contextKey = JSON.stringify([value, selection.start, selection.end]);
  const visible = focused && context && dismissed !== contextKey;
  const query = useQuery({
    queryKey: ['chat-skills', member.id, member.provider, member.codexAccount, projectId, sessionId],
    queryFn: ({ signal }) => api(`/members/${member.id}/chat/skills`, 'POST', { projectId: projectId || null, ...(sessionId ? { sessionId } : {}) }, { signal }),
    enabled: Boolean(visible && context.kind === 'skill' && member.provider === 'codex'),
    staleTime: 30000, retry: false,
  });
  const items = completionItems(context, commands, query.data?.skills || []);
  const selected = Math.min(active, Math.max(0, items.length - 1));
  const open = Boolean(visible && (context.kind === 'skill' || commands.length));
  useEffect(() => { setActive(0); }, [contextKey, query.data]);
  useEffect(() => {
    if (open) list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, selected, contextKey]);
  useLayoutEffect(() => {
    if (pendingCaret.current == null) return;
    const caret = pendingCaret.current;
    pendingCaret.current = null;
    field.current?.setSelectionRange(caret, caret);
    setSelection({ start: caret, end: caret });
  }, [value]);
  function selectionChanged(event) {
    const { selectionStart: start, selectionEnd: end } = event.currentTarget;
    setSelection(previous => previous.start === start && previous.end === end ? previous : { start, end });
  }
  function choose(item) {
    if (!item || item.disabledReason || !context) return;
    const next = insertCompletion(value, context, item.name, props.maxLength ?? 16000);
    if (!next) return;
    pendingCaret.current = next.caret;
    setDismissed(JSON.stringify([next.text, next.caret, next.caret]));
    onChange(next.text);
    field.current?.focus();
  }
  function keyDown(event) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (open && event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); setDismissed(contextKey); return;
    }
    if (open && items.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      setActive((selected + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
      return;
    }
    if (open && !event.shiftKey && !event.ctrlKey && !event.metaKey && ['Tab', 'Enter'].includes(event.key)) {
      // Selection only fills the draft. A second Enter submits the command.
      if (items.length) { event.preventDefault(); choose(items[selected]); return; }
    }
    if (enterToSend && event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault(); event.currentTarget.form?.requestSubmit();
    }
  }
  const message = context?.kind !== 'skill' ? '일치하는 명령이 없습니다.'
    : member.provider !== 'codex' ? '$ 스킬 선택은 Codex 대화에서 사용할 수 있습니다.'
      : query.isPending || query.isFetching ? '스킬 목록을 불러오는 중…'
        : query.isError ? query.error.message : query.data?.message || '일치하는 스킬이 없습니다.';
  return <div className="chat-input" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    {open && <section className="chat-completions" aria-label={context.kind === 'skill' ? '스킬 자동완성' : '명령 자동완성'}>
      <header><strong>{context.kind === 'skill' ? '스킬' : '대화 명령'}</strong><span>↑↓ 이동 · Tab / Enter 선택 · Esc 닫기</span></header>
      <div id={listId} ref={list} role="listbox" aria-label={context.kind === 'skill' ? '사용 가능한 스킬' : '사용 가능한 명령'}>
        {items.map((item, index) => <button id={`${listId}-${index}`} key={`${item.name}:${item.path || ''}`} type="button" role="option" tabIndex={-1}
          aria-selected={index === selected} aria-disabled={Boolean(item.disabledReason)} title={item.disabledReason || item.path || item.description}
          onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => choose(item)}>
          <span className="chat-completion-name">{item.name}{item.label && item.label !== item.name.slice(1) && <small>{item.label}</small>}</span>
          <span className="chat-completion-description">{item.disabledReason || item.description}</span>
        </button>)}
      </div>
      {!items.length && <p role="status">{message}</p>}
      {context.kind === 'skill' && member.provider === 'codex' && (query.isError || query.data?.status === 'unavailable' || query.data?.warnings?.length > 0) && <div className="chat-completion-retry">
        {query.data?.warnings?.length > 0 && <span>일부 스킬을 읽지 못했습니다.</span>}
        <button type="button" disabled={query.isFetching} onMouseDown={event => event.preventDefault()} onClick={() => query.refetch()}>다시 조회</button>
      </div>}
    </section>}
    <textarea {...props} ref={field} value={value} role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={open}
      aria-controls={open ? listId : undefined} aria-activedescendant={open && items.length ? `${listId}-${selected}` : undefined}
      onChange={event => { onChange(event.target.value); selectionChanged(event); setDismissed(null); }} onSelect={selectionChanged}
      onFocus={event => { setFocused(true); selectionChanged(event); }} onKeyDown={keyDown} />
  </div>;
}
