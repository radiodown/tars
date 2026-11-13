import { collections } from './store.js';
import { fail } from './contracts.js';

const names = { members: 'AI', tasks: '작업', documents: '문서', sessions: '실행 기록' };

export function deleteDepartment(store, departmentId) {
  return store.transaction(() => {
    const department = store.require('departments', departmentId);
    const dependencies = collections.filter(kind => kind !== 'departments' && kind !== 'settings'
      && store.list(kind).some(record => record.departmentId === departmentId));
    if (dependencies.length) fail(`이 부서에 연결된 ${dependencies.map(kind => names[kind] || kind).join('·')}이 있어 삭제할 수 없습니다.`);
    store.delete('departments', departmentId);
    store.event(`부서 삭제 · ${department.name}`);
    return { ok: true, id: departmentId };
  });
}
