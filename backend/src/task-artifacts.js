import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink, realpath, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DATA } from './store.js';
import { createPatch } from './workspaces.js';
import { fail } from './contracts.js';

export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const taskRecordPath = taskId => join(DATA, 'tasks', taskId, 'record.md');
export function completionCriteria(task) {
  const lines = String(task.acceptance || '').split('\n').map(line => line.trim()).filter(Boolean);
  if (task.goalId && task.plannedUnits) lines.unshift(`목표 ${task.goalId}: 배정된 ${task.plannedUnits}단위 전체의 산출물과 검증 근거 확인`);
  const criteria = lines.length > 40 ? [...lines.slice(0, 39), lines.slice(39).join('\n')] : lines;
  return criteria.map((text, index) => ({ id: `C${index + 1}`, text }));
}
export function specificationHash(store, task) {
  const goal = task.goalId && store.get('requests', task.requestId)?.progressPlan?.goals.find(goal => goal.id === task.goalId);
  return digest({ title: task.title, description: task.description, acceptance: task.acceptance,
    assigneeId: task.assigneeId, projectId: task.projectId, departmentId: task.departmentId,
    ...(task.goalId ? { goalId: task.goalId, plannedUnits: task.plannedUnits,
      goal: goal ? { unit: goal.unit, acceptance: goal.acceptance } : null } : {}),
    documents: (task.documentIds || []).map(key => [key, store.get('documents', key)?.version]),
    dependencies: (task.dependsOn || []).map(key => [key, store.get('tasks', key)?.acceptedReportId || null]) });
}

// Bounded, streaming fingerprints. A missing/unreadable artifact prevents acceptance.
async function fingerprint(path, budget = { files: 0, bytes: 0, parents: new Set() }) {
  if (++budget.files > 30000) throw new Error('산출물 파일 수가 30,000개를 초과했습니다. 결과 파일 범위를 줄이세요.');
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) return digest(['symlink', await readlink(path), await fingerprint(await realpath(path), budget)]);
  if (stat.isDirectory()) {
    const canonical = await realpath(path);
    if (budget.parents.has(canonical)) throw new Error(`순환하는 산출물 링크입니다: ${path}`);
    budget.parents.add(canonical);
    const entries = (await readdir(path)).sort().filter(name => !['.git', 'node_modules', '.tars-data', '.tars-run', '.agents', '.claude'].includes(name));
    const values = [];
    try { for (const name of entries) values.push([name, await fingerprint(join(path, name), budget)]); }
    finally { budget.parents.delete(canonical); }
    return digest(values);
  }
  if (!stat.isFile()) throw new Error(`일반 파일이 아닌 산출물입니다: ${path}`);
  budget.bytes += stat.size;
  if (budget.bytes > 512 * 1024 * 1024) throw new Error('산출물 지문 확인 범위가 512 MiB를 초과했습니다.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const after = await lstat(path);
  if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw new Error(`기록 중 파일이 변경되었습니다: ${path}`);
  return digest([stat.mode, hash.digest('hex')]);
}

export async function captureArtifacts(store, task, artifacts = [], reportId = null) {
  if (!task.workspace) throw new Error('산출물을 확인할 작업 디렉토리가 없습니다.');
  let patchHash = null, patchPath = null;
  if (task.isolation === 'worktree') {
    const { patch } = await createPatch(store, task);
    patchHash = digest(patch);
    if (reportId) {
      const directory = join(DATA, 'tasks', task.id, 'reports', reportId);
      await mkdir(directory, { recursive: true });
      patchPath = join(directory, 'changes.patch');
      await writeFile(patchPath, patch, { flag: 'wx', mode: 0o600 });
    }
  }
  const files = [];
  for (const item of artifacts) {
    const path = resolve(task.workspace, item.path);
    files.push({ ...item, path, hash: await fingerprint(path) });
  }
  // Non-Git workspaces also need to detect unlisted changes during review.
  const workspaceHash = task.isolation === 'worktree' ? null : await fingerprint(task.workspace);
  return { workspace: task.workspace, workspaceHash, patchHash, patchPath, files,
    hash: digest({ workspace: task.workspace, workspaceHash, patchHash, files }) };
}

export async function assertCurrentArtifacts(store, task, report) {
  if (report.legacy || !report.artifacts?.hash) fail('이전 결과에는 산출물 버전이 없습니다. 새 결과를 제출하세요.');
  if (report.specificationHash !== specificationHash(store, task)) fail('결과 제출 후 지시·완료 기준·참조 자료가 변경되었습니다. 다시 실행하세요.');
  const current = await captureArtifacts(store, task, report.result.artifacts);
  if (current.hash !== report.artifacts.hash) fail('결과 제출 후 산출물이 변경되었습니다. 새 결과를 제출하고 다시 검토하세요.');
}

export function renderResult(result) {
  const items = values => values.length ? values.map(value => `- ${value}`).join('\n') : '없음';
  return `## 결과 요약\n\n${result.summary}\n\n## 수행 내용\n\n${items(result.workPerformed)}\n\n## 산출물\n\n${items(result.artifacts.map(item => `${item.path} · ${item.description}`))}\n\n## 검증\n\n${items(result.verification.map(item => `${item.criterion} · ${item.status}\n  ${item.evidence}`))}\n\n## 미완료 사항\n\n${items(result.remaining)}\n\n## 후속 작업\n\n${items(result.followUp)}`;
}
