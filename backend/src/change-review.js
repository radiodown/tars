import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA } from './store.js';
import { createPatch, git } from './workspaces.js';
import { assertCurrentArtifacts } from './task-artifacts.js';
import { fail } from './contracts.js';

export async function changeReview(store, taskId) {
  const task = store.require('tasks', taskId);
  if (!['review', 'done', 'blocked'].includes(task.status)) fail('작업이 끝난 뒤 변경을 검토할 수 있습니다.');
  if (store.list('sessions').some(s => s.taskId === taskId && ['preparing', 'running', 'waiting_input', 'stopping'].includes(s.status))) fail('관련 실행이 끝난 뒤 변경을 검토하세요.');
  const { patch } = await createPatch(store, task);
  const deleted = task.deletedAt || (task.requestId && store.get('requests', task.requestId)?.deletedAt);
  return { taskId, patch, hash: createHash('sha256').update(patch).digest('hex'), reportId: task.acceptedReportId || null,
    integratedAt: task.integratedAt || null, canApply: Boolean(task.acceptedReportId && patch && !task.integratedAt && !deleted) };
}

export async function applyReviewedChanges(store, taskId, expected, actor = 'user') {
  if (actor !== 'user') fail('변경 검토와 원본 반영은 사용자만 승인할 수 있습니다.', 403);
  const current = await changeReview(store, taskId);
  if (!current.canApply || expected.hash !== current.hash || expected.reportId !== current.reportId) fail('검토 대상이 변경되었거나 반영할 수 없습니다. 변경 내용을 새로 확인하세요.', 409);
  const task = store.require('tasks', taskId);
  await assertCurrentArtifacts(store, task, store.require('taskReports', current.reportId));
  // Apply exactly the bytes the user reviewed; never regenerate a patch after approval.
  const directory = join(DATA, 'change-reviews', taskId);
  await mkdir(directory, { recursive: true });
  const patchPath = join(directory, `${current.hash}.patch`);
  try { await writeFile(patchPath, current.patch, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST' || await readFile(patchPath, 'utf8') !== current.patch) throw error; }
  const project = store.require('projects', task.projectId);
  if ((await git(project.path, ['status', '--porcelain'])).trim()) fail('원본 작업 디렉토리에 변경 사항이 있습니다. 정리한 뒤 적용하세요.');
  await git(project.path, ['apply', '--check', patchPath]);
  await git(project.path, ['apply', patchPath]);
  const at = new Date().toISOString();
  return store.patch('tasks', taskId, { patchPath, integratedAt: at, changeReview: { hash: current.hash, reportId: current.reportId, actor, approvedAt: at } }, { actor });
}
