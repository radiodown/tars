import { useEffect, useRef } from 'react';
import { X, Inbox, ArrowUpRight, Crown, Bot, LoaderCircle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { labels } from './api';

export function Badge({ status, children }) { return <span className={`badge ${status || ''}`}><i />{children || labels[status] || status}</span>; }
export function Avatar({ member, large = false }) {
  return <span className={`avatar ${member?.provider || 'codex'} ${large ? 'large' : ''}`}>
    {member?.name?.slice(0, 1).toUpperCase() || <Bot size={18} />}
    {['leader', 'ceo'].includes(member?.role) && <span className="crown"><Crown size={10} /></span>}
  </span>;
}
export function Empty({ title, description, action, label = '시작하기', compact = false }) {
  return <div className={`empty ${compact ? 'compact' : ''}`}><span className="empty-icon"><Inbox size={24} strokeWidth={1.4} /></span>
    <h3>{title}</h3><p>{description}</p>{action && <button className="button secondary" onClick={action}>{label}<ArrowUpRight size={15} /></button>}</div>;
}
export function Markdown({ children }) { return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{children || ''}</ReactMarkdown></div>; }
export function Dialog({ title, subtitle, children, onClose, wide = false, drawer = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const element = ref.current;
    element.showModal();
    const close = event => { event.preventDefault(); onClose(); };
    element.addEventListener('cancel', close);
    return () => { element.removeEventListener('cancel', close); element.close(); };
  }, []);
  return <dialog ref={ref} className={`${wide ? 'wide' : ''} ${drawer ? 'drawer' : ''}`} aria-labelledby="dialog-title" onClick={event => { if (event.target === ref.current) onClose(); }}>
    <header className="dialog-head"><div><h2 id="dialog-title">{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" aria-label="닫기" onClick={onClose}><X size={20} /></button></header>
    <div className="dialog-body">{children}</div>
  </dialog>;
}
export function Field({ label, children, hint }) { return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
export function Submit({ busy, children = '저장하기' }) { return <button className="button primary" type="submit" disabled={busy}>{busy && <LoaderCircle size={16} className="spin" />}{children}</button>; }
