import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'tars-change-review-'));
process.env.TARS_DATA_DIR = join(directory, 'data');
const { Store } = await import('../src/store.js');
const { changeReview, applyReviewedChanges } = await import('../src/change-review.js');
const { captureArtifacts, specificationHash } = await import('../src/task-artifacts.js');
after(() => rmSync(directory, { recursive: true, force: true }));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('review approval binds the report and patch, rejects agent/stale/live requests and applies only reviewed changes', async () => {
  const store = new Store();
  const repo = join(directory, 'repo'), worktree = join(directory, 'worktree');
  try {
    await mkdir(repo); git(repo, 'init'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
    await writeFile(join(repo, 'file.txt'), 'before\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'fixture');
    const baseCommit = git(repo, 'rev-parse', 'HEAD'); git(repo, 'worktree', 'add', '--detach', worktree, baseCommit);
    const project = store.put('projects', { path: repo });
    let task = store.put('tasks', { projectId: project.id, title: 'change', description: '', acceptance: '', isolation: 'worktree', workspace: worktree, baseCommit, status: 'done' });
    await writeFile(join(worktree, 'file.txt'), 'after\n');
    await writeFile(join(worktree, 'new.txt'), 'new file\n');
    const report = store.put('taskReports', { specificationHash: specificationHash(store, task), artifacts: await captureArtifacts(store, task), result: { artifacts: [] } });
    task = store.patch('tasks', task.id, { acceptedReportId: report.id });
    const review = await changeReview(store, task.id);
    assert.match(review.patch, /new file/); assert(review.canApply);
    await assert.rejects(applyReviewedChanges(store, task.id, review, 'agent'), /사용자만/);
    const running = store.put('sessions', { taskId: task.id, status: 'running' });
    await assert.rejects(applyReviewedChanges(store, task.id, review), /실행이 끝난/);
    store.patch('sessions', running.id, { status: 'completed' });
    await writeFile(join(worktree, 'file.txt'), 'unreviewed\n');
    await assert.rejects(applyReviewedChanges(store, task.id, review), /검토 대상/);
    assert.equal(await readFile(join(repo, 'file.txt'), 'utf8'), 'before\n');
    await writeFile(join(worktree, 'file.txt'), 'after\n');
    await assert.rejects(applyReviewedChanges(store, task.id, { ...review, reportId: 'wrong' }), /검토 대상/);
    const applied = await applyReviewedChanges(store, task.id, review);
    assert.equal(applied.changeReview.hash, review.hash);
    assert.equal(await readFile(join(repo, 'file.txt'), 'utf8'), 'after\n');
    assert.equal(await readFile(join(repo, 'new.txt'), 'utf8'), 'new file\n');
    await assert.rejects(applyReviewedChanges(store, task.id, review), /검토 대상/);
  } finally { store.db.close(); }
});
