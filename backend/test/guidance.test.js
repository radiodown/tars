import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, readlink, readdir, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'tars-guidance-'));
process.env.TARS_DATA_DIR = directory;
const { Store } = await import('../src/store.js');
const { prepareScope, prepareGuidance, managedSkillPaths } = await import('../src/guidance.js');
const { git, createPatch } = await import('../src/workspaces.js');
after(() => rmSync(directory, { recursive: true, force: true }));

async function fixture(run) {
  const store = new Store();
  const department = store.put('departments', { name: '개발' });
  const member = store.put('members', { name: '담당자', role: 'member', provider: 'codex', departmentId: department.id });
  const skill = store.put('documents', { title: '공용 스킬', kind: 'skill', version: 1,
    departmentId: department.id, content: '---\nname: shared-test\ndescription: Test skill\n---\nTest' });
  const scope = await prepareScope(store, member, null);
  const cwd = join(scope, 'workspaces', 'test');
  await mkdir(join(cwd, '.agents'), { recursive: true });
  try { await run({ store, member, skill, cwd }); }
  finally { store.db.close(); }
}

test('internal project skill symlink is preserved and only TARS links are excluded from patches', () => fixture(async ({ store, member, skill, cwd }) => {
  await mkdir(join(cwd, '.claude', 'skills', 'project-skill'), { recursive: true });
  const projectSkill = join(cwd, '.claude', 'skills', 'project-skill', 'SKILL.md');
  await writeFile(projectSkill, 'Project skill\n');
  await symlink('../.claude/skills', join(cwd, '.agents', 'skills'));
  await git(cwd, ['init']);
  await git(cwd, ['add', '--all']);
  const baselineTree = (await git(cwd, ['write-tree'])).trim();
  const guidance = await prepareGuidance(store, member, null, cwd);
  assert(guidance.skills.some(item => item.id === skill.id));
  assert.equal(await readlink(join(cwd, '.agents', 'skills')), '../.claude/skills');
  const managed = `.claude/skills/tars-${skill.id}`;
  assert.deepEqual(managedSkillPaths(store, cwd), [managed]);
  assert.equal(await readlink(join(cwd, managed)), join(directory, 'shared', 'skills', skill.id));
  await prepareGuidance(store, member, null, cwd);
  await writeFile(projectSkill, 'Updated project skill\n');
  const task = { id: member.id, workspace: cwd, isolation: 'worktree', baselineTree };
  const { patch } = await createPatch(store, task);
  assert.match(patch, /Updated project skill/);
  assert.doesNotMatch(patch, /tars-|\.agents\/skills/);
  store.delete('documents', skill.id);
  await prepareGuidance(store, member, null, cwd);
  assert.deepEqual(await readdir(join(cwd, '.claude', 'skills')), ['project-skill']);
  assert.equal(await readFile(projectSkill, 'utf8'), 'Updated project skill\n');
  assert.deepEqual(managedSkillPaths(store, cwd), []);
}));

test('ordinary skill directories remain supported and name conflicts preserve project files', () => fixture(async ({ store, member, skill, cwd }) => {
  await prepareGuidance(store, member, null, cwd);
  const managed = `.agents/skills/tars-${skill.id}`;
  assert.deepEqual(managedSkillPaths(store, cwd), [managed]);
  await rm(join(cwd, managed));
  await mkdir(join(cwd, managed));
  await writeFile(join(cwd, managed, 'SKILL.md'), 'Keep this file');
  await assert.rejects(prepareGuidance(store, member, null, cwd), /변경된 TARS 스킬 연결/);
  assert.equal(await readFile(join(cwd, managed, 'SKILL.md'), 'utf8'), 'Keep this file');
}));

test('external and broken skill directory symlinks fail without modifying their targets', () => fixture(async ({ store, member, cwd }) => {
  const outside = join(directory, 'external-skills');
  await mkdir(outside);
  const link = join(cwd, '.agents', 'skills');
  for (const target of [outside, join(outside, 'missing')]) {
    await symlink(target, link);
    await assert.rejects(prepareGuidance(store, member, null, cwd), /스킬 폴더/);
    assert.equal(await readlink(link), target);
    assert.deepEqual(await readdir(outside), []);
    await rm(link);
  }
}));

test('a symlinked .agents directory and chained internal skills resolve to their physical paths', () => fixture(async ({ store, member, skill, cwd }) => {
  await rm(join(cwd, '.agents'), { recursive: true });
  await mkdir(join(cwd, 'config', 'agents'), { recursive: true });
  await mkdir(join(cwd, 'config', 'skills'));
  await symlink('config/agents', join(cwd, '.agents'));
  await symlink('../skills', join(cwd, 'config', 'agents', 'skills'));
  await prepareGuidance(store, member, null, cwd);
  assert.deepEqual(managedSkillPaths(store, cwd), [`config/skills/tars-${skill.id}`]);
  await prepareGuidance(store, member, null, cwd);
  assert.equal(await readlink(join(cwd, '.agents')), 'config/agents');
}));

test('cyclic links and regular files produce actionable errors and preserve the original path', () => fixture(async ({ store, member, cwd }) => {
  const link = join(cwd, '.agents', 'skills');
  await symlink('skills', link);
  await assert.rejects(prepareGuidance(store, member, null, cwd), /순환 링크/);
  assert.equal(await readlink(link), 'skills');
  await rm(link);
  await writeFile(link, 'project-owned file');
  await assert.rejects(prepareGuidance(store, member, null, cwd), /디렉토리가 아닙니다/);
  assert.equal(await readFile(link, 'utf8'), 'project-owned file');
}));

test('real Git worktree preparation preserves axtest-style skills and user edits across retries', () => fixture(async ({ store, member, skill, cwd }) => {
  const { prepareWorkspace } = await import('../src/workspaces.js');
  const source = join(cwd, 'source');
  await mkdir(join(source, '.agents'), { recursive: true });
  await mkdir(join(source, '.claude', 'skills', 'project'), { recursive: true });
  await writeFile(join(source, '.claude', 'skills', 'project', 'SKILL.md'), 'original skill');
  await symlink('../.claude/skills', join(source, '.agents', 'skills'));
  await git(source, ['init']);
  await git(source, ['add', '--all']);
  await git(source, ['-c', 'user.name=TARS Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture']);
  const project = store.put('projects', { name: 'axtest fixture', path: source });
  const task = store.put('tasks', { departmentId: member.departmentId, assigneeId: member.id, projectId: project.id, isolation: 'worktree', dependsOn: [] });
  await prepareScope(store, member, project.id);
  const workspace = await prepareWorkspace(store, task, member);
  await prepareGuidance(store, member, project.id, workspace);
  assert.equal(await readlink(join(workspace, '.agents', 'skills')), '../.claude/skills');
  await writeFile(join(workspace, 'result.txt'), 'work in progress');
  assert.equal(await prepareWorkspace(store, store.get('tasks', task.id), member), workspace);
  await prepareGuidance(store, member, project.id, workspace);
  assert.equal(await readFile(join(workspace, 'result.txt'), 'utf8'), 'work in progress');
  const { patch } = await createPatch(store, store.get('tasks', task.id));
  assert.match(patch, /work in progress/);
  assert(!patch.includes(`tars-${skill.id}`));
  assert.equal((await git(source, ['status', '--porcelain'])).trim(), '');
  assert.deepEqual(await readdir(join(source, '.claude', 'skills')), ['project']);
}));
