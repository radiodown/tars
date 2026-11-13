import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Boxes, Command, FileText, ListTodo, Plus, Users } from 'lucide-react';

const POSITION_KEY = 'tars:create-corner';
const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const ACTIONS = [
  ['department', '부서 만들기', Users],
  ['member', 'AI 팀원 추가', Command],
  ['task', '작업 만들기', ListTodo],
  ['document', '문서 작성', FileText],
  ['project', '프로젝트 등록', Boxes],
];
const transform = ({ x, y }) => `translate3d(${x}px, ${y}px, 0)`;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function savedCorner() {
  try {
    const value = localStorage.getItem(POSITION_KEY);
    if (CORNERS.includes(value)) return value;
  } catch { /* Position remains usable when storage is unavailable. */ }
  return 'bottom-right';
}

export function FloatingCreate({ expanded, onOpenChange, onCreate, disabled }) {
  const [corner, setCorner] = useState(savedCorner);
  const [phase, setPhase] = useState('idle');
  const [target, setTarget] = useState(corner);
  const cornerRef = useRef(corner);
  const areaRef = useRef(null);
  const dockRef = useRef(null);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const pointerRef = useRef(null);
  const animationRef = useRef(null);
  const frameRef = useRef(null);
  const pendingRef = useRef(null);
  const positionRef = useRef({ x: 0, y: 0 });
  const suppressClickRef = useRef(false);

  const bounds = useCallback(() => {
    const area = areaRef.current.getBoundingClientRect();
    const width = Math.max(0, area.width - dockRef.current.offsetWidth);
    const height = Math.max(0, area.height - dockRef.current.offsetHeight);
    return {
      area, width, height,
      corners: {
        'top-left': { x: 0, y: 0 }, 'top-right': { x: width, y: 0 },
        'bottom-left': { x: 0, y: height }, 'bottom-right': { x: width, y: height },
      },
    };
  }, []);

  const place = useCallback(point => {
    positionRef.current = point;
    dockRef.current.style.transform = transform(point);
  }, []);

  // Read the displayed position before cancelling a snap, so grabbing it mid-flight never jumps.
  const stopMotion = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    if (pendingRef.current) {
      place(pendingRef.current);
      pendingRef.current = null;
    }
    if (animationRef.current) {
      const rect = dockRef.current.getBoundingClientRect();
      const area = areaRef.current.getBoundingClientRect();
      animationRef.current.cancel();
      animationRef.current = null;
      place({ x: rect.left - area.left, y: rect.top - area.top });
    }
    return positionRef.current;
  }, [place]);

  const snapTo = useCallback((nextCorner, animate = true, persist = true) => {
    const from = stopMotion();
    const to = bounds().corners[nextCorner];
    cornerRef.current = nextCorner;
    setCorner(nextCorner);
    setTarget(nextCorner);
    place(to);
    if (persist) {
      try { localStorage.setItem(POSITION_KEY, nextCorner); } catch { /* Optional persistence. */ }
    }
    const travel = distance(from, to);
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!animate || reduceMotion || travel < 1 || !dockRef.current.animate) {
      setPhase('idle');
      return;
    }
    setPhase('settling');
    // A fast pull, a restrained overshoot, then a soft landing; no layout animation.
    const animation = dockRef.current.animate([
      { transform: transform(from) }, { transform: transform(to) },
    ], {
      duration: Math.min(640, 320 + travel * 0.25),
      easing: 'cubic-bezier(0.22, 1.06, 0.36, 1)',
    });
    animationRef.current = animation;
    animation.onfinish = () => {
      if (animationRef.current !== animation) return;
      animationRef.current = null;
      setPhase('idle');
    };
  }, [bounds, place, stopMotion]);

  const cancelDrag = useCallback(() => {
    const pointer = pointerRef.current;
    if (!pointer) return;
    pointerRef.current = null;
    suppressClickRef.current = true;
    if (buttonRef.current.hasPointerCapture(pointer.id)) buttonRef.current.releasePointerCapture(pointer.id);
    snapTo(cornerRef.current, true, false);
  }, [snapTo]);

  useLayoutEffect(() => {
    snapTo(cornerRef.current, false, false);
    const observer = new ResizeObserver(() => {
      if (!pointerRef.current) snapTo(cornerRef.current, false, false);
    });
    observer.observe(areaRef.current);
    observer.observe(dockRef.current);
    return () => {
      observer.disconnect();
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      animationRef.current?.cancel();
    };
  }, [snapTo]);

  useEffect(() => {
    window.addEventListener('blur', cancelDrag);
    return () => window.removeEventListener('blur', cancelDrag);
  }, [cancelDrag]);

  useEffect(() => {
    if (!expanded) return;
    const focusFrame = requestAnimationFrame(() => menuRef.current?.querySelector('[role="menuitem"]')?.focus({ preventScroll: true }));
    const outside = event => {
      if (!dockRef.current?.contains(event.target)) onOpenChange(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('pointerdown', outside);
    };
  }, [expanded, onOpenChange]);

  function nearest(point, corners) {
    return CORNERS.reduce((best, candidate) => distance(point, corners[candidate]) < distance(point, corners[best]) ? candidate : best, cornerRef.current);
  }

  function startDrag(event) {
    if (disabled || !event.isPrimary || event.button !== 0) return;
    const origin = stopMotion();
    suppressClickRef.current = false;
    pointerRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, origin, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    setPhase('pressed');
  }

  function moveDrag(event) {
    const pointer = pointerRef.current;
    if (!pointer || pointer.id !== event.pointerId) return;
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    if (!pointer.moved && Math.hypot(dx, dy) < 6) return;
    if (!pointer.moved) {
      pointer.moved = true;
      suppressClickRef.current = true;
      onOpenChange(false);
      setPhase('dragging');
    }
    const { width, height, corners } = bounds();
    const point = {
      x: Math.max(0, Math.min(width, pointer.origin.x + dx)),
      y: Math.max(0, Math.min(height, pointer.origin.y + dy)),
    };
    const nextCorner = nearest(point, corners);
    const destination = corners[nextCorner];
    const pull = Math.pow(Math.max(0, 1 - distance(point, destination) / 150), 2) * 0.3;
    pendingRef.current = {
      x: point.x + (destination.x - point.x) * pull,
      y: point.y + (destination.y - point.y) * pull,
    };
    setTarget(nextCorner);
    if (frameRef.current === null) {
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        if (pendingRef.current) place(pendingRef.current);
        pendingRef.current = null;
      });
    }
  }

  function finishDrag(event, cancelled = false) {
    const pointer = pointerRef.current;
    if (!pointer || pointer.id !== event.pointerId) return;
    pointerRef.current = null;
    const point = stopMotion();
    const nextCorner = pointer.moved && !cancelled ? nearest(point, bounds().corners) : cornerRef.current;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    snapTo(nextCorner, true, pointer.moved && !cancelled);
  }

  function closeMenu(restoreFocus = false) {
    onOpenChange(false);
    if (restoreFocus) buttonRef.current?.focus({ preventScroll: true });
  }

  function triggerKeyDown(event) {
    const directions = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    if (event.altKey && directions.includes(event.key)) {
      event.preventDefault();
      closeMenu();
      const [vertical, horizontal] = cornerRef.current.split('-');
      const nextVertical = event.key === 'ArrowUp' ? 'top' : event.key === 'ArrowDown' ? 'bottom' : vertical;
      const nextHorizontal = event.key === 'ArrowLeft' ? 'left' : event.key === 'ArrowRight' ? 'right' : horizontal;
      snapTo(`${nextVertical}-${nextHorizontal}`);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      onOpenChange(true);
    } else if (event.key === 'Escape') {
      cancelDrag();
      closeMenu(true);
    }
  }

  function menuKeyDown(event) {
    const items = Array.from(menuRef.current.querySelectorAll('[role="menuitem"]'));
    const index = items.indexOf(document.activeElement);
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault();
      closeMenu(true);
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }
  }

  return <div className="floating-create-area" ref={areaRef} data-phase={phase}>
    <div className="floating-create-targets" aria-hidden="true">
      {CORNERS.map(value => <span key={value} className="floating-create-target" data-corner={value} data-active={target === value} />)}
    </div>
    <div className="floating-create" ref={dockRef} data-corner={corner} data-phase={phase} data-expanded={expanded}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) onOpenChange(false); }}>
      <button className="floating-create-trigger" ref={buttonRef} type="button" disabled={disabled}
        aria-haspopup="menu" aria-expanded={expanded} aria-controls="floating-create-menu" aria-describedby="floating-create-help"
        title="새로 만들기 · 드래그하여 위치 이동"
        onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={event => finishDrag(event)}
        onPointerCancel={event => finishDrag(event, true)} onLostPointerCapture={event => finishDrag(event, true)}
        onKeyDown={triggerKeyDown}
        onClick={event => {
          if (event.detail > 0 && suppressClickRef.current) {
            suppressClickRef.current = false;
            event.preventDefault();
            return;
          }
          onOpenChange(!expanded);
        }}>
        <span className="floating-create-plus"><Plus size={21} strokeWidth={2} /></span>
        <span>새로 만들기</span>
      </button>
      <span id="floating-create-help" className="floating-create-help">드래그하거나 Alt와 방향키를 함께 눌러 네 모서리로 이동할 수 있습니다.</span>
      {expanded && <div className="floating-create-menu" id="floating-create-menu" role="menu" aria-label="새로 만들기" ref={menuRef} onKeyDown={menuKeyDown}>
        <div className="floating-create-menu-label" role="presentation">새로 만들기</div>
        {ACTIONS.map(([type, label, Icon]) => <button key={type} type="button" role="menuitem" tabIndex={-1} onClick={() => { closeMenu(true); onCreate(type); }}><Icon size={17} strokeWidth={1.7} /><span>{label}</span></button>)}
        <p role="presentation">버튼을 끌어 모서리로 옮길 수 있어요</p>
      </div>}
    </div>
  </div>;
}
