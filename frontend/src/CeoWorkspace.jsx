import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Columns2, GripVertical, Maximize2, Minimize2, Plus, Rows2, Terminal, X } from 'lucide-react';
import { useWorkspace } from './App';
import { MemberChat } from './MemberChat';
import { LAYOUT_KEY, closePane, createPane, minimumSize, panes, restoreLayout, splitPane, swapPanes, updateNode } from './workspace-layout';
import './ceo-workspace.css';

function SessionPane({ pane, onSelect, occupied }) {
  const { data } = useWorkspace();
  const selected = data.members.find(member => member.id === pane.memberId);
  const members = data.members.filter(member => member.role !== 'ceo').sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  const pickerRef = useRef(null);
  const restorePickerFocus = useRef(false);
  useLayoutEffect(() => {
    if (!restorePickerFocus.current) return;
    restorePickerFocus.current = false;
    pickerRef.current?.focus({ preventScroll: true });
  }, [selected?.id]);
  const picker = <select ref={pickerRef} className="office-member-picker" aria-label="대화할 AI 선택" value={selected?.id || ''} onChange={event => {
    restorePickerFocus.current = event.currentTarget === document.activeElement;
    onSelect(event.target.value);
  }}>
    <option value="">AI 이름 선택</option>
    {members.map(member => <option key={member.id} value={member.id} disabled={occupied.includes(member.id)}>{member.name} · {member.role === 'leader' ? '팀장' : '팀원'}{occupied.includes(member.id) ? ' · 열려 있음' : ''}</option>)}
  </select>;
  return <div className="office-session-pane">
    {selected ? <MemberChat key={selected.id} member={selected} memberPicker={picker} /> : <>
      <div className="office-session-picker">{picker}</div>
      <div className="office-pane-empty"><Terminal size={26} strokeWidth={1.3} /><p>대화할 AI의 이름을 선택하세요.</p></div>
    </>}
  </div>;
}

function Split({ node, narrow, expanded, onResize, children }) {
  const ref = useRef(null);
  const drag = useRef(null);
  const row = !narrow && node.direction === 'row';
  const dimension = row ? 'width' : 'height';
  const sizes = node.children.map(child => minimumSize(child, narrow)[dimension]);
  const [extent, setExtent] = useState(0);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setExtent(entry.contentRect[dimension] - 7));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [dimension]);
  const lower = extent > 0 ? Math.min(0.95, Math.max(0.05, sizes[0] / extent)) : 0.05;
  const upper = extent > 0 ? Math.max(lower, Math.min(0.95, 1 - sizes[1] / extent)) : 0.95;
  const ratio = Math.max(lower, Math.min(upper, node.ratio));
  const clamp = value => Math.max(lower, Math.min(upper, value));
  function start(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = ref.current.getBoundingClientRect();
    drag.current = { start: row ? bounds.left : bounds.top, size: bounds[dimension] - 7 };
  }
  function move(event) {
    if (!drag.current) return;
    onResize(clamp(((row ? event.clientX : event.clientY) - drag.current.start - 3.5) / drag.current.size));
  }
  function end(event) {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function keyDown(event) {
    const backwards = row ? 'ArrowLeft' : 'ArrowUp';
    const forwards = row ? 'ArrowRight' : 'ArrowDown';
    if (![backwards, forwards, 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    onResize(event.key === 'Home' ? lower : event.key === 'End' ? upper : clamp(ratio + (event.key === backwards ? -1 : 1) * (event.shiftKey ? 0.1 : 0.025)));
  }
  return <div className="office-split" data-axis={row ? 'row' : 'column'} ref={ref}>
    <div className="office-branch" style={expanded ? undefined : { flex: `${ratio} 1 0%`, [row ? 'minWidth' : 'minHeight']: sizes[0] }}>{children[0]}</div>
    <div className="office-resizer" role="separator" tabIndex={0} aria-label={row ? '패널 너비 조절' : '패널 높이 조절'} aria-orientation={row ? 'vertical' : 'horizontal'} aria-valuemin={Math.round(lower * 100)} aria-valuemax={Math.round(upper * 100)} aria-valuenow={Math.round(ratio * 100)} onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={() => { drag.current = null; }} onKeyDown={keyDown} onDoubleClick={() => onResize(clamp(0.5))} />
    <div className="office-branch" style={expanded ? undefined : { flex: `${1 - ratio} 1 0%`, [row ? 'minWidth' : 'minHeight']: sizes[1] }}>{children[1]}</div>
  </div>;
}

export function CeoWorkspace({ children }) {
  const { data } = useWorkspace();
  const [layout, setLayout] = useState(() => {
    let tree;
    try { tree = restoreLayout(localStorage.getItem(LAYOUT_KEY)); } catch { tree = restoreLayout(null); }
    const selected = new Set(data.members.filter(member => member.role === 'ceo').map(member => member.id));
    for (const pane of panes(tree).filter(item => item.type === 'terminal')) {
      const memberId = pane.memberId || data.sessions.find(session => session.id === pane.sessionId)?.memberId || '';
      const available = data.members.some(member => member.id === memberId) && !selected.has(memberId);
      tree = updateNode(tree, pane.id, ({ sessionId, ...rest }) => ({ ...rest, memberId: available ? memberId : '' }));
      if (available) selected.add(memberId);
    }
    return tree;
  });
  const [active, setActive] = useState('office-chat');
  const [dragging, setDragging] = useState('');
  const [dropTarget, setDropTarget] = useState('');
  const [narrow, setNarrow] = useState(false);
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  const [expandedId, setExpandedId] = useState('');
  const viewport = useRef(null);
  const hosts = useRef(new Map());
  const leaves = panes(layout);
  const expandedPane = !mobile && leaves.find(pane => pane.id === expandedId);
  const paneTitle = pane => pane.type === 'chat' ? 'TARS 대화' : data.members.find(member => member.id === pane.memberId)?.name || 'AI 대화';
  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const update = () => {
      setMobile(media.matches);
      if (media.matches) setExpandedId('');
    };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  function hostFor(id) {
    if (!hosts.current.has(id)) {
      const host = document.createElement('div');
      host.className = 'office-pane-host';
      hosts.current.set(id, host);
    }
    return hosts.current.get(id);
  }
  useLayoutEffect(() => {
    for (const id of hosts.current.keys()) if (!leaves.some(pane => pane.id === id)) hosts.current.delete(id);
  }, [layout]);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < 720));
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* Layout also works without storage. */ }
    }, 150);
    return () => clearTimeout(timer);
  }, [layout]);
  function add(id = active, direction = 'row') {
    const pane = createPane();
    setLayout(tree => {
      if (panes(tree).length >= 25) return tree;
      const target = panes(tree).some(item => item.id === id) ? id : panes(tree)[0].id;
      return splitPane(tree, target, direction, pane);
    });
    setActive(pane.id);
  }
  function remove(id) {
    setLayout(tree => closePane(tree, id));
    setActive(leaves.find(pane => pane.type === 'chat').id);
    if (expandedId === id) setExpandedId('');
  }
  function renderLayout(node) {
    if (node.type === 'split') return <Split key={node.id} node={node} narrow={narrow} expanded={Boolean(expandedPane)} onResize={ratio => setLayout(tree => updateNode(tree, node.id, split => ({ ...split, ratio })))}>{node.children.map(renderLayout)}</Split>;
    // Stable portal hosts preserve drafts and scroll positions when the split tree changes.
    return <div key={node.id} className="office-pane-slot" ref={slot => { const host = hostFor(node.id); if (slot && host.parentNode !== slot) slot.append(host); }} />;
  }
  function renderPane(node) {
    const chat = node.type === 'chat';
    const title = paneTitle(node);
    return <section key={node.id} className={`office-pane ${active === node.id ? 'active' : ''} ${dropTarget === node.id ? 'drop-target' : ''}`} data-pane-id={node.id} data-expanded={expandedPane?.id === node.id || undefined} aria-label={`${title} 패널`} onFocusCapture={() => setActive(node.id)} onPointerDownCapture={() => setActive(node.id)} onDragOver={event => { if (dragging && dragging !== node.id) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTarget(node.id); } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setDropTarget(''); }} onDrop={event => { event.preventDefault(); if (dragging) setLayout(tree => swapPanes(tree, dragging, node.id)); setDragging(''); setDropTarget(''); }}>
      <header className="office-pane-bar">
        <span className="office-pane-grip" draggable title="드래그해서 패널 위치 바꾸기" onDragStart={event => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', node.id); setDragging(node.id); }} onDragEnd={() => { setDragging(''); setDropTarget(''); }}><GripVertical size={14} /><span>{title}</span></span>
        <div className="office-pane-tools">
          {leaves.length > 1 && <button type="button" className="icon-button" aria-label={expandedPane ? '분할 보기로 돌아가기' : `${title} 대화창 확대`} title={expandedPane ? '분할 보기로 돌아가기' : '대화창 확대'} onClick={() => setExpandedId(expandedPane ? '' : node.id)}>{expandedPane ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>}
          {!expandedPane && <>
            {chat && <button type="button" className="office-add-cli" aria-label="AI 대화창 추가" title="AI 대화창 추가" disabled={leaves.length >= 25} onClick={() => add(node.id)}><Plus size={13} />AI 부르기</button>}
            <button type="button" className="icon-button" aria-label={`${title} 패널 오른쪽에 AI 대화창 추가`} title="오른쪽에 AI 대화창 추가" disabled={leaves.length >= 25} onClick={() => add(node.id, 'row')}><Columns2 size={14} /></button>
            <button type="button" className="icon-button" aria-label={`${title} 패널 아래에 AI 대화창 추가`} title="아래에 AI 대화창 추가" disabled={leaves.length >= 25} onClick={() => add(node.id, 'column')}><Rows2 size={14} /></button>
            {!chat && <button type="button" className="icon-button" aria-label="AI 대화창 닫기" title="패널 닫기" onClick={() => remove(node.id)}><X size={15} /></button>}
          </>}
        </div>
      </header>
      {chat ? children : <SessionPane pane={node} occupied={leaves.filter(pane => pane.id !== node.id).map(pane => pane.memberId).filter(Boolean)} onSelect={memberId => setLayout(tree => updateNode(tree, node.id, pane => ({ ...pane, memberId })))} />}
    </section>;
  }
  const minimum = minimumSize(expandedPane || layout, narrow);
  return <div className="page ceo-office">
    {mobile && <div className="office-mobile-switcher"><label htmlFor="office-mobile-pane">대화창</label><select id="office-mobile-pane" value={active} onChange={event => setActive(event.target.value)}>{leaves.map((pane, index) => <option key={pane.id} value={pane.id}>{paneTitle(pane)}{pane.type === 'terminal' ? ` · ${index + 1}` : ''}</option>)}</select><button className="icon-button" type="button" aria-label="AI 대화창 추가" disabled={leaves.length >= 25} onClick={() => add()}><Plus size={20} /></button>{leaves.find(pane => pane.id === active)?.type === 'terminal' && <button className="icon-button" type="button" aria-label="AI 대화창 닫기" onClick={() => remove(active)}><X size={20} /></button>}</div>}
    <div className="office-workspace" ref={viewport}><div className="office-layout" data-expanded={Boolean(expandedPane) || undefined} style={mobile ? undefined : { minWidth: minimum.width, minHeight: minimum.height }}>{mobile ? leaves.map(node => <div key={node.id} className="office-pane-slot" hidden={active !== node.id} ref={slot => { const host = hostFor(node.id); if (slot && host.parentNode !== slot) slot.append(host); }} />) : renderLayout(layout)}</div></div>
    {leaves.map(node => createPortal(renderPane(node), hostFor(node.id), node.id))}
  </div>;
}
