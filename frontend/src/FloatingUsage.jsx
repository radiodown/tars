import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Gauge } from 'lucide-react';
import { UsageSummary } from './Usage.jsx';

// Reuse the saved corner of the former create button.
const POSITION_KEY = 'tars:create-corner';
const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const transform = ({ x, y }) => `translate3d(${x}px, ${y}px, 0)`;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function savedCorner() {
  try {
    const value = localStorage.getItem(POSITION_KEY);
    if (CORNERS.includes(value)) return value;
  } catch { /* Position remains usable when storage is unavailable. */ }
  return 'bottom-right';
}

export function FloatingUsage({ disabled }) {
  const [corner, setCorner] = useState(savedCorner);
  const [phase, setPhase] = useState('idle');
  const [target, setTarget] = useState(corner);
  const [expanded, setExpanded] = useState(false);
  const cornerRef = useRef(corner);
  const areaRef = useRef(null);
  const dockRef = useRef(null);
  const buttonRef = useRef(null);
  const panelRef = useRef(null);
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
      panelRef.current.hidePopover();
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

  function triggerKeyDown(event) {
    const directions = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    if (event.altKey && directions.includes(event.key)) {
      event.preventDefault();
      const [vertical, horizontal] = cornerRef.current.split('-');
      const nextVertical = event.key === 'ArrowUp' ? 'top' : event.key === 'ArrowDown' ? 'bottom' : vertical;
      const nextHorizontal = event.key === 'ArrowLeft' ? 'left' : event.key === 'ArrowRight' ? 'right' : horizontal;
      snapTo(`${nextVertical}-${nextHorizontal}`);
    } else if (event.key === 'Escape') {
      cancelDrag();
    }
  }

  return <div className="floating-usage-area" ref={areaRef} data-phase={phase}>
    <div className="floating-usage-targets" aria-hidden="true">
      {CORNERS.map(value => <span key={value} className="floating-usage-target" data-corner={value} data-active={target === value} />)}
    </div>
    <div className="floating-usage" ref={dockRef} data-corner={corner} data-phase={phase}>
      <button className="floating-usage-trigger" ref={buttonRef} type="button" disabled={disabled}
        aria-label="사용량 보기" aria-haspopup="dialog" aria-expanded={expanded} aria-describedby="floating-usage-help"
        popoverTarget="floating-usage-panel"
        title="사용량 보기 · 드래그하여 위치 이동"
        onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={event => finishDrag(event)}
        onPointerCancel={event => finishDrag(event, true)} onLostPointerCapture={event => finishDrag(event, true)}
        onKeyDown={triggerKeyDown}
        onClick={event => {
          if (event.detail > 0 && suppressClickRef.current) {
            suppressClickRef.current = false;
            event.preventDefault();
          }
        }}>
        <Gauge size={16} strokeWidth={2} />
      </button>
      <span id="floating-usage-help" className="floating-usage-help">드래그하거나 Alt와 방향키를 함께 눌러 네 모서리로 이동할 수 있습니다.</span>
      <div id="floating-usage-panel" className="floating-usage-panel" ref={panelRef} popover="auto" role="dialog" aria-label="사용량" tabIndex={-1}
        onToggle={event => {
          const open = event.newState === 'open';
          setExpanded(open);
          if (open) event.currentTarget.focus({ preventScroll: true });
        }}>
        {expanded && <UsageSummary onDetails={() => panelRef.current.hidePopover()} />}
      </div>
    </div>
  </div>;
}
