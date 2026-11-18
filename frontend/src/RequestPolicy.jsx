import { useState } from 'react';
import { useWorkspace } from './App';
export function RequestPolicy({ request }) {
  const { perform, busy } = useWorkspace();
  const [error, setError] = useState('');
  async function save(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await perform(`/requests/${request.id}`, 'PATCH', { instruction: form.get('instruction'), acceptance: form.get('acceptance'),
        approvalMode: form.has('tasks') ? 'tasks' : 'scope', allowManagerImplementation: form.has('managerWrite') }, '업무 범위를 저장했습니다. 범위를 변경했다면 담당 AI에게 재협의를 요청하세요.');
      setError('');
    } catch (error) { setError(error.message); }
  }
  return <details><summary>목표·승인 방식 설정</summary><form onSubmit={save}>
    <label>목표와 범위<textarea name="instruction" required defaultValue={request.instruction} rows={3} maxLength={16000} /></label>
    <label>업무 완료 기준<textarea name="acceptance" defaultValue={request.acceptance || ''} rows={3} maxLength={16000} /></label>
    <label><input type="checkbox" name="tasks" defaultChecked={request.approvalMode !== 'scope'} />TASK 목록 변경도 승인받기</label>
    <label><input type="checkbox" name="managerWrite" defaultChecked={Boolean(request.allowManagerImplementation)} />승인 후 관리자의 직접 구현 허용</label>
    <p className="muted">목표·범위·완료 기준 또는 권한을 바꾸면 새 승인이 필요합니다.</p>
    <button className="button secondary" disabled={busy}>저장</button>{error && <p role="alert">{error}</p>}
  </form></details>;
}
