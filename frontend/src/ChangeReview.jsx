import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useWorkspace } from './App';
import { api } from './api';
import './session-interactions.css';

export function DiffView({ patch }) {
  return <div className="change-diff" aria-label="파일 변경 비교">{patch.split(/(?=^diff --git )/m).filter(Boolean).map((file, index) => {
    const lines = file.split('\n');
    return <details key={index} open><summary>{lines[0]}</summary><pre>{lines.slice(1).map((line, row) => <span key={row} className={line.startsWith('+') ? 'diff-added' : line.startsWith('-') ? 'diff-removed' : ''}>{line || ' '}<br /></span>)}</pre></details>;
  })}</div>;
}

export function ChangeReview({ task }) {
  const { perform } = useWorkspace();
  const [error, setError] = useState('');
  const [applying, setApplying] = useState(false);
  const query = useQuery({ queryKey: ['change-review', task.id, task.updatedAt], queryFn: () => api(`/tasks/${task.id}/change-review`), staleTime: 0 });
  async function apply() {
    if (!query.data?.canApply || applying) return;
    setApplying(true); setError('');
    try {
      await perform(`/tasks/${task.id}/change-review/apply`, 'POST', { hash: query.data.hash, reportId: query.data.reportId }, '검토한 변경을 원본에 반영했습니다.');
      await query.refetch();
    } catch (issue) { setError(issue.message); }
    finally { setApplying(false); }
  }
  return <section className="change-review"><header><h3>파일 변경 검토</h3><button type="button" onClick={() => query.refetch()} disabled={query.isFetching || applying}>새로 확인</button></header>
    <p>작업 폴더의 변경입니다. 원본 반영은 아래 버튼으로 승인합니다.</p>
    {query.isPending && <p>변경 내용을 확인하고 있습니다.</p>}
    {query.data && (query.data.patch ? <DiffView patch={query.data.patch} /> : <p>변경된 파일이 없습니다.</p>)}
    {query.data?.canApply && <button type="button" onClick={apply} disabled={applying || query.isFetching}>검토한 변경을 원본에 반영</button>}
    {query.data?.integratedAt && <p>원본에 반영된 변경입니다.</p>}
    {query.data?.patch && !query.data.reportId && <p>AI 결과 검토가 완료된 뒤 원본에 반영할 수 있습니다.</p>}
    {(error || query.isError) && <p className="form-error" role="alert">{error || query.error.message}</p>}
  </section>;
}
