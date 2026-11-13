import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, Link2, RefreshCw, Search, Settings2 } from 'lucide-react';
import { useWorkspace } from './App';
import { api, time } from './api';
import { Empty, Markdown } from './ui';
import './knowledge-explorer.css';

function allFiles(node) {
  return !node ? [] : node.type === 'file' ? [node] : node.children.flatMap(allFiles);
}

function ancestorIds(node, id) {
  if (!node) return null;
  if (node.id === id) return [];
  for (const child of node.children || []) {
    const found = ancestorIds(child, id);
    if (found) return [node.id, ...found];
  }
  return null;
}

function filterTree(node, term) {
  if (!node || !term) return node;
  const matches = node.id !== 'root' && `${node.name} ${node.label || ''} ${node.description || ''}`.toLowerCase().includes(term);
  if (matches) return node;
  if (node.type === 'file') return null;
  const children = node.children.map(child => filterTree(child, term)).filter(Boolean);
  return children.length ? { ...node, children } : null;
}

function TreeBranch({ node, selectedId, onSelect, expanded, onToggle, searching, depth = 0 }) {
  const folder = node.type === 'folder';
  const isOpen = folder && (searching || expanded.has(node.id));
  const Icon = folder ? isOpen ? FolderOpen : Folder : node.linkTarget ? Link2 : FileText;
  return <li>
    <button type="button" className={`knowledge-tree-row ${selectedId === node.id ? 'selected' : ''}`} style={{ paddingLeft: 12 + depth * 17 }}
      title={node.path} aria-current={!folder && selectedId === node.id ? 'true' : undefined}
      aria-expanded={folder ? isOpen : undefined} onClick={() => folder ? onToggle(node.id) : onSelect(node.id)}>
      {folder ? isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : <span className="knowledge-tree-spacer" />}
      <Icon size={15} /><span>{node.label || node.name}<small>{node.description}</small></span>
    </button>
    {isOpen && (node.children.length ? <ul>{node.children.map(child => <TreeBranch key={child.id} node={child} selectedId={selectedId} onSelect={onSelect} expanded={expanded} onToggle={onToggle} searching={searching} depth={depth + 1} />)}</ul>
      : <p className="knowledge-tree-empty" style={{ paddingLeft: 42 + depth * 17 }}>아직 자료가 없습니다.</p>)}
  </li>;
}

export function KnowledgeExplorer() {
  const { data, open } = useWorkspace();
  const [selectedId, setSelectedId] = useState('');
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState('preview');
  const [expanded, setExpanded] = useState(() => new Set(['root', 'shared', 'executive', 'departments']));
  const viewport = useRef(null);
  const revision = [...data.members, ...data.documents, ...data.departments, ...data.projects, ...data.tasks].map(item => `${item.id}:${item.updatedAt}`).join('|')
    + data.sessions.map(item => `${item.id}:${item.guidanceHash || ''}:${item.guidanceStatus || ''}`).join('|');
  const tree = useQuery({
    queryKey: ['knowledge-tree', revision], queryFn: ({ signal }) => api('/knowledge/tree', 'GET', undefined, { signal }),
    placeholderData: previous => previous, retry: false,
  });
  const files = allFiles(tree.data?.root);
  const selected = files.find(file => file.id === selectedId) || files.find(file => file.id === tree.data?.defaultFileId) || files[0];
  const file = useQuery({
    queryKey: ['knowledge-file', selected?.id, revision], enabled: Boolean(selected), retry: false,
    queryFn: ({ signal }) => api(`/knowledge/file/${encodeURIComponent(selected.id)}`, 'GET', undefined, { signal }),
  });
  const ancestors = (ancestorIds(tree.data?.root, selected?.id) || []).join('|');
  useEffect(() => {
    if (ancestors) setExpanded(previous => new Set([...previous, ...ancestors.split('|')]));
  }, [ancestors]);
  useEffect(() => { if (viewport.current) viewport.current.scrollTop = 0; }, [selected?.id, mode]);
  const term = search.trim().toLowerCase();
  const visibleTree = filterTree(tree.data?.root, term);
  const member = data.members.find(item => item.id === selected?.memberId);
  const selectedDocument = data.documents.find(item => item.id === selected?.documentId);
  function toggle(id) {
    setExpanded(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  return <section className="knowledge-explorer" aria-label="개인 지침과 공용 자료 탐색">
    <aside className="knowledge-sidebar" aria-label="지침 파일 탐색">
      <header><strong>지침 · 문서 탐색</strong><button type="button" className="icon-button" title="파일 목록과 내용 새로고침" aria-label="지침 탐색 새로고침" disabled={tree.isFetching || file.isFetching} onClick={() => { tree.refetch(); if (selected) file.refetch(); }}><RefreshCw size={15} /></button></header>
      <label className="knowledge-search"><Search size={15} /><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="팀원 · 파일 · 문서 검색" aria-label="팀원과 지침 파일 검색" /></label>
      <nav className="knowledge-tree-scroll" aria-label="지침 폴더와 파일">
        {tree.isPending ? <p className="knowledge-message" role="status">파일 목록을 불러오는 중…</p>
          : tree.isError ? <p className="knowledge-message error" role="alert">{tree.error.status === 404 ? '지침 탐색 기능을 적용하려면 백엔드를 재시작해주세요.' : tree.error.message}</p>
          : visibleTree ? <ul className="knowledge-tree"><TreeBranch node={visibleTree} selectedId={selected?.id} onSelect={setSelectedId} expanded={expanded} onToggle={toggle} searching={Boolean(term)} /></ul>
          : <p className="knowledge-message">검색 결과가 없습니다.</p>}
      </nav>
    </aside>
    <article className="knowledge-viewer" aria-label="선택한 지침 내용">
      {selected && !tree.isError ? <>
        <header className="knowledge-file-head"><div><h2><FileText size={18} />{selected.label || selected.name}</h2><p>{member ? `${member.name} · ${selected.description}` : selected.description || '문서 원문'}</p></div>
          {member && <button type="button" className="button secondary" disabled={member.status === 'running'} onClick={() => open(member.role === 'ceo' ? 'ceoSettings' : 'member', member)}><Settings2 size={14} />프로필 설정</button>}
          {selectedDocument && <button type="button" className="button secondary" onClick={() => open('document', selectedDocument)}>문서 편집</button>}
        </header>
        <div className="knowledge-file-path"><code>{selected.path}</code>{file.data?.linkTarget && <span><Link2 size={12} />연결 대상: <code>{file.data.linkTarget}</code></span>}</div>
        <div className="knowledge-file-toolbar"><div className="segmented" role="group" aria-label="지침 표시 방식"><button type="button" className={mode === 'preview' ? 'selected' : ''} aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>Markdown</button><button type="button" className={mode === 'source' ? 'selected' : ''} aria-pressed={mode === 'source'} onClick={() => setMode('source')}>원문</button></div><small>{file.data ? `파일 수정 ${time(file.data.modifiedAt)}` : '생성된 파일 보기'}</small></div>
        {file.data?.truncated && <p className="knowledge-message">긴 파일의 처음 512 KiB만 표시합니다.</p>}
        <div className="knowledge-content" ref={viewport} tabIndex={0} aria-label="지침 본문" aria-busy={file.isPending}>
          {file.isPending ? <p className="knowledge-message" role="status">파일 내용을 불러오는 중…</p>
            : file.isError ? <div className="knowledge-message error" role="alert"><p>{file.error.message}</p><button type="button" className="text-button" onClick={() => file.refetch()}>다시 불러오기</button></div>
            : file.data?.content ? mode === 'source' ? <pre className="knowledge-source">{file.data.content}</pre> : <Markdown>{file.data.content}</Markdown>
            : <Empty compact title="내용이 없는 파일입니다" />}
        </div>
      </> : <Empty title="지침 파일을 선택하세요" description="TARS와 각 부서의 팀원을 펼쳐 개인 지침을 확인할 수 있습니다." />}
    </article>
  </section>;
}
