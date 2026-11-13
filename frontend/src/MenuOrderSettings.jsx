import { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, GripVertical, ListOrdered, RotateCcw, Save } from 'lucide-react';
import { useWorkspace } from './App';
import { defaultMenuOrder, navigation, normalizeMenuOrder, orderedNavigation } from './navigation';

export function MenuOrderSettings() {
  const { data, perform, busy } = useWorkspace();
  const [draft, setDraft] = useState(null);
  const [dragging, setDragging] = useState(null);
  const [target, setTarget] = useState(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const dragged = useRef(null);
  const saving = useRef(false);
  const saved = normalizeMenuOrder(data.settings.menuOrder);
  const order = draft ?? saved;
  const changed = order.some((path, index) => path !== saved[index]);
  const isDefault = order.every((path, index) => path === defaultMenuOrder[index]);

  function finishDrag() {
    dragged.current = null;
    setDragging(null);
    setTarget(null);
  }
  function updateOrder(next, path) {
    setDraft(next);
    setError('');
    const label = navigation.find(item => item[0] === path)?.[1];
    setMessage(label ? `${label} 메뉴를 ${next.indexOf(path) + 1}번째로 옮겼습니다.` : '기본 순서로 되돌렸습니다. 순서 저장을 눌러 적용하세요.');
  }
  function move(path, delta) {
    if (busy || saving.current) return;
    const index = order.indexOf(path);
    const destination = index + delta;
    if (index < 0 || destination < 0 || destination >= order.length) return;
    const next = [...order];
    next.splice(index, 1);
    next.splice(destination, 0, path);
    updateOrder(next, path);
  }
  function startDrag(event, path) {
    if (busy || saving.current) { event.preventDefault(); return; }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', path);
    event.dataTransfer.setDragImage(event.currentTarget.closest('li'), 24, 24);
    dragged.current = path;
    setDragging(path);
  }
  function position(event) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
  }
  function dragOver(event, path) {
    if (!dragged.current || busy || saving.current) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const edge = position(event);
    setTarget(current => current?.path === path && current.edge === edge ? current : { path, edge });
  }
  function drop(event, path) {
    const source = dragged.current;
    if (!source || busy || saving.current) { finishDrag(); return; }
    event.preventDefault();
    if (source !== path) {
      const next = order.filter(item => item !== source);
      const index = next.indexOf(path) + (position(event) === 'after' ? 1 : 0);
      next.splice(index, 0, source);
      updateOrder(next, source);
    }
    finishDrag();
  }
  async function save(event) {
    event.preventDefault();
    if (!changed || busy || dragging || saving.current) return;
    saving.current = true;
    setError('');
    try {
      await perform('/settings', 'PATCH', { menuOrder: order }, '좌측 메뉴 순서를 저장했습니다.');
      setDraft(null);
      setMessage('저장한 순서를 좌측 메뉴에 적용했습니다.');
    } catch (issue) {
      setError(issue.message);
    } finally { saving.current = false; }
  }

  return <section className="panel settings-card menu-order-settings" aria-labelledby="menu-order-heading">
    <div className="section-heading"><h2 id="menu-order-heading">좌측 메뉴 순서</h2><ListOrdered size={18} /></div>
    <p id="menu-order-help" className="muted">손잡이를 드래그하거나 위·아래 버튼으로 순서를 바꾼 뒤 저장하세요. 설정 및 연결은 하단에 고정됩니다.</p>
    <form onSubmit={save}>
      <ol className="menu-order-list" aria-label="좌측 메뉴 순서 편집" onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setTarget(null); }}>
        {orderedNavigation(order).map(([path, label, Icon], index) => <li key={path} className={`menu-order-row${dragging === path ? ' dragging' : ''}${dragging !== path && target?.path === path ? ` drop-${target.edge}` : ''}`} onDragOver={event => dragOver(event, path)} onDrop={event => drop(event, path)}>
          <button type="button" className="menu-order-grip" draggable={!busy} disabled={busy} aria-label={`${label} 순서 이동`} aria-describedby="menu-order-help" title="드래그 또는 위·아래 방향키로 이동" onDragStart={event => startDrag(event, path)} onDragEnd={finishDrag} onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); move(path, event.key === 'ArrowUp' ? -1 : 1); } }}><GripVertical size={18} /></button>
          <span className="menu-order-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
          <Icon className="menu-order-icon" size={17} aria-hidden="true" /><span className="menu-order-label">{label}</span>
          <div className="menu-order-arrows"><button className="icon-button" type="button" disabled={busy || !!dragging || index === 0} aria-label={`${label} 위로 이동`} title="위로 이동" onClick={() => move(path, -1)}><ArrowUp size={16} /></button><button className="icon-button" type="button" disabled={busy || !!dragging || index === order.length - 1} aria-label={`${label} 아래로 이동`} title="아래로 이동" onClick={() => move(path, 1)}><ArrowDown size={16} /></button></div>
        </li>)}
      </ol>
      <p className="menu-order-status" role="status" aria-live="polite">{message || '저장한 순서는 새로고침하거나 다른 브라우저로 접속해도 유지됩니다.'}</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-footer menu-order-footer">
        <button className="button secondary menu-order-reset" type="button" disabled={busy || !!dragging || isDefault} onClick={() => updateOrder([...defaultMenuOrder])}><RotateCcw size={14} />기본 순서</button>
        <button className="button secondary" type="button" disabled={busy || !!dragging || !changed} onClick={() => { setDraft(null); setError(''); setMessage('저장된 순서로 되돌렸습니다.'); }}>변경 취소</button>
        <button className="button primary" type="submit" disabled={busy || !!dragging || !changed}><Save size={15} />순서 저장</button>
      </div>
    </form>
  </section>;
}
