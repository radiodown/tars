import { useCallback, useEffect, useRef, useState } from 'react';
import { Markdown } from './ui';

export function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  return reduced;
}

export function StreamingMarkdown({ children = '', active = false }) {
  const text = children || '';
  const [shown, setShown] = useState(text);
  const rendered = useRef(text);
  const wasActive = useRef(active);
  const reduced = useReducedMotion();
  useEffect(() => {
    const animate = (active || wasActive.current) && !reduced && text.startsWith(rendered.current);
    wasActive.current = active;
    if (!animate) { rendered.current = text; setShown(text); return; }
    if (rendered.current === text) return;
    let frame;
    let last = performance.now();
    let cursor = rendered.current.length;
    // Each received batch catches up within about 180 ms, even for long responses.
    const rate = Math.max(0.06, (text.length - cursor) / 180);
    function reveal(now) {
      if (now - last < 30) { frame = requestAnimationFrame(reveal); return; }
      cursor = Math.min(text.length, cursor + Math.max(1, Math.floor(Math.min(now - last, 48) * rate)));
      // Never show half of a Unicode surrogate pair.
      if (cursor < text.length && /[\uD800-\uDBFF]/.test(text[cursor - 1])) cursor++;
      rendered.current = text.slice(0, cursor);
      setShown(rendered.current);
      last = now;
      if (cursor < text.length) frame = requestAnimationFrame(reveal);
    }
    frame = requestAnimationFrame(reveal);
    return () => cancelAnimationFrame(frame);
  }, [text, active, reduced]);
  return <div className="streaming-response" data-streaming={active || shown !== text}><Markdown>{shown}</Markdown></div>;
}

export function useConversationScroll(viewport, content, scope) {
  const reduced = useReducedMotion();
  const [follow, setFollowing] = useState(true);
  const following = useRef(true);
  const frame = useRef();
  const schedule = useRef(() => {});
  const touchY = useRef(null);
  const lastTop = useRef(0);
  const setFollow = useCallback(value => {
    const next = typeof value === 'function' ? value(following.current) : value;
    following.current = next;
    if (!next) { cancelAnimationFrame(frame.current); frame.current = undefined; }
    setFollowing(next);
    if (next) schedule.current();
  }, []);
  useEffect(() => {
    const node = viewport.current;
    if (!node || !content.current) return;
    let last = performance.now();
    function tick(now) {
      frame.current = undefined;
      if (!following.current) return;
      const gap = node.scrollHeight - node.clientHeight - node.scrollTop;
      if (gap <= 1) return;
      node.scrollTop += reduced ? gap : Math.max(1, gap * (1 - Math.exp(-Math.min(now - last, 64) / 65)));
      last = now;
      if (node.scrollHeight - node.clientHeight - node.scrollTop > 1) frame.current = requestAnimationFrame(tick);
    }
    function start() {
      if (!following.current || frame.current !== undefined) return;
      last = performance.now();
      frame.current = requestAnimationFrame(tick);
    }
    schedule.current = start;
    const observer = new ResizeObserver(start);
    observer.observe(content.current);
    observer.observe(node);
    start();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame.current);
      frame.current = undefined;
      schedule.current = () => {};
    };
  }, [viewport, content, scope, reduced]);
  useEffect(() => { setFollow(true); }, [scope, setFollow]);

  function pause() {
    const node = viewport.current;
    if (node && node.scrollHeight - node.clientHeight > 2) {
      lastTop.current = node.scrollTop;
      setFollow(false);
    }
  }
  function resumeAtBottom() {
    const node = viewport.current;
    if (node && node.scrollHeight - node.clientHeight - node.scrollTop <= 2) setFollow(true);
  }
  function childCanScroll(target, delta) {
    // Scrolling a code block or another nested viewport should not pause the chat.
    for (let node = target instanceof Element ? target : target?.parentElement; node && node !== viewport.current; node = node.parentElement) {
      if (node.scrollHeight <= node.clientHeight + 1 || !/auto|scroll/.test(getComputedStyle(node).overflowY)) continue;
      if (delta < 0 ? node.scrollTop > 0 : node.scrollTop + node.clientHeight < node.scrollHeight - 1) return true;
    }
    return false;
  }
  const scrollHandlers = {
    onWheel(event) {
      if (childCanScroll(event.target, event.deltaY)) return;
      if (event.deltaY < 0) pause();
      else if (event.deltaY > 0) resumeAtBottom();
    },
    onTouchStart(event) { touchY.current = event.touches[0]?.clientY ?? null; },
    onTouchMove(event) {
      const next = event.touches[0]?.clientY;
      if (next == null) return;
      if (touchY.current != null && next > touchY.current + 1 && !childCanScroll(event.target, touchY.current - next)) pause();
      else if (touchY.current != null && next < touchY.current - 1) resumeAtBottom();
      touchY.current = next;
    },
    onTouchEnd() { touchY.current = null; },
    onTouchCancel() { touchY.current = null; },
    onKeyDown(event) {
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) && !childCanScroll(event.target, -1)) pause();
      else if (event.key === 'End') setFollow(true);
    },
    onPointerDown(event) {
      const node = viewport.current;
      if (event.button === 0 && event.target === node && event.clientX >= node.getBoundingClientRect().right - 16) pause();
    },
    onScroll(event) {
      const node = event.currentTarget;
      const movingDown = node.scrollTop > lastTop.current + 0.01;
      lastTop.current = node.scrollTop;
      // Resize clamping and our animation also emit scroll events. Only explicit
      // user input pauses following; reaching the actual bottom resumes it.
      if (event.target === node && !following.current && movingDown && node.scrollHeight - node.clientHeight - node.scrollTop <= 2) setFollow(true);
    },
  };
  return { follow, setFollow, scrollHandlers };
}
