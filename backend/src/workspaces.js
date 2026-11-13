import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, cp, lstat, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { DATA } from './store.js';
import { fail } from './contracts.js';

const exec = promisify(execFile);
export const git = async (cwd, args) => (await exec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 30000 })).stdout;
export const memberDirectory = member => join(DATA, 'departments', member.departmentId, 'members', member.id);

async function link(target, path) {
  try { await lstat(path); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await symlink(target, path);
  }
}

let sharedWrites = Promise.resolve();
export function syncShared(store) {
  const pending = sharedWrites.then(() => writeShared(store));
  sharedWrites = pending.catch(() => {});
  return pending;
}

async function writeShared(store) {
  const shared = join(DATA, 'shared');
  await mkdir(join(shared, 'skills'), { recursive: true });
  await mkdir(join(DATA, 'documents'), { recursive: true });
  for (const doc of store.list('documents')) await writeFile(join(DATA, 'documents', `${doc.id}.md`), doc.content);
  const instructions = store.list('documents').filter(doc => doc.kind === 'instruction');
  await writeFile(join(shared, 'instructions.md'), instructions.map(doc => `# ${doc.title}\n\n${doc.content}`).join('\n\n---\n\n'));
  for (const skill of store.list('documents').filter(doc => doc.kind === 'skill')) {
    const dir = join(shared, 'skills', skill.id);
    await mkdir(dir, { recursive: true });
    const content = skill.content.startsWith('---\n') ? skill.content
      : `---\nname: skill-${skill.id}\ndescription: ${JSON.stringify(skill.title)}\n---\n\n${skill.content}`;
    await writeFile(join(dir, 'SKILL.md'), content);
  }
}

export async function syncMember(store, member) {
  const dir = memberDirectory(member);
  await mkdir(join(dir, '.agents'), { recursive: true });
  await mkdir(join(dir, '.claude'), { recursive: true });
  const role = member.role === 'leader'
    ? '팀장: 요구사항 협의, 설계, 작업 분배, 결과 검토와 보고에 집중합니다. 직접 소스코드를 수정하지 않습니다.'
    : '팀원: 배정된 범위에서 작업하고 결과, 변경 파일, 차단 사항과 검증 여부를 보고합니다.';
  await writeFile(join(dir, 'profile.md'), `# ${member.name}\n\n소속: ${store.require('departments', member.departmentId).name}\n역할: ${member.role}\n도구: ${member.provider}\n모델: ${member.model || 'CLI 기본값'}\n전문 분야: ${member.specialty}\n`);
  await writeFile(join(dir, 'instructions.md'), `# ${member.name} 작업 지침\n\n${role}\n\n${member.instructions}\n\n공통 지침 원본을 읽고 따르세요: ${join(DATA, 'shared', 'instructions.md')}\n공통 스킬: ${join(DATA, 'shared', 'skills')}\n`);
  await link('instructions.md', join(dir, 'AGENTS.md'));
  await link('instructions.md', join(dir, 'CLAUDE.md'));
  await link(join(DATA, 'shared', 'skills'), join(dir, '.agents', 'skills'));
  await link(join(DATA, 'shared', 'skills'), join(dir, '.claude', 'skills'));
  return dir;
}

export async function projectPath(path) {
  if (!isAbsolute(path)) fail('프로젝트 경로는 절대 경로여야 합니다.', 400);
  const canonical = await realpath(path);
  if (!(await lstat(canonical)).isDirectory()) fail('프로젝트 디렉토리가 아닙니다.', 400);
  if (canonical === DATA || canonical.startsWith(DATA + '/')) fail('Tars 데이터 디렉토리는 소스 프로젝트로 등록할 수 없습니다.', 400);
  return canonical;
}

export async function prepareWorkspace(store, task, member) {
  if (task.workspace) {
    await access(task.workspace);
    return task.workspace;
  }
  let workspace;
  let baseCommit = null;
  let baselineTree = null;
  if (task.projectId && task.isolation !== 'personal') {
    const project = store.require('projects', task.projectId);
    workspace = join(DATA, 'workspaces', task.id);
    await mkdir(join(DATA, 'workspaces'), { recursive: true });
    try { await lstat(workspace); fail('이미 존재하는 작업 디렉토리입니다. 남은 파일을 확인한 뒤 새 작업을 만드세요.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (task.isolation === 'worktree') {
      baseCommit = (await git(project.path, ['rev-parse', 'HEAD'])).trim();
      await git(project.path, ['worktree', 'add', '--detach', workspace, baseCommit]);
      try {
      // Apply each ancestor's own changes once; dependent jobs see the actual files.
      const ancestors = [];
      const visited = new Set();
      const visit = key => {
        if (visited.has(key)) return;
        visited.add(key);
        const dependency = store.require('tasks', key);
        dependency.dependsOn.forEach(visit);
        ancestors.push(dependency);
      };
      task.dependsOn.forEach(visit);
      for (const dependency of ancestors) {
        if (!dependency.workspace || dependency.isolation === 'personal') continue;
        if (dependency.isolation !== 'worktree') fail('선행 코드 작업이 디렉토리 복사 방식입니다. 변경을 원본에 정리한 뒤 새 작업으로 실행하세요.');
        const { patch, target } = await createPatch(store, dependency);
        if (patch.trim()) {
          try { await git(workspace, ['apply', '--check', target]); }
          catch (error) {
            // The source HEAD may already contain this ancestor after manual integration.
            try { await git(workspace, ['apply', '--reverse', '--check', target]); }
            catch { throw error; }
            continue;
          }
          await git(workspace, ['apply', target]);
        }
      }
      await git(workspace, ['add', '--all']);
      baselineTree = (await git(workspace, ['write-tree'])).trim();
      } catch (error) {
        // No AI has started in this newly created directory yet.
        await git(project.path, ['worktree', 'remove', '--force', workspace]).catch(() => {});
        throw error;
      }
    } else {
      if (task.dependsOn.some(key => {
        const dependency = store.require('tasks', key);
        return dependency.workspace && dependency.isolation !== 'personal' && !dependency.integratedAt;
      })) fail('디렉토리 복사 작업은 선행 코드 변경을 자동 전달하지 않습니다. Git worktree를 사용하거나 원본을 정리한 새 작업을 만드세요.');
      const omitted = new Set(['.git', 'node_modules', '.tars-data', '.tars-run', 'dist', '.env']);
      const filter = async source => source !== DATA && !DATA.startsWith(source + '/')
        && !relative(project.path, source).split('/').some(part => omitted.has(part) || part.startsWith('.env.'))
        && !(await lstat(source)).isSymbolicLink();
      await mkdir(workspace, { recursive: true });
      try {
        for (const entry of await readdir(project.path)) {
          const source = join(project.path, entry);
          if (await filter(source)) await cp(source, join(workspace, entry), { recursive: true, filter });
        }
      } catch (error) {
        await rm(workspace, { recursive: true, force: true });
        throw error;
      }
    }
  } else {
    workspace = join(memberDirectory(member), 'workspaces', task.id);
    await mkdir(workspace, { recursive: true });
  }
  store.patch('tasks', task.id, { workspace, baseCommit, baselineTree });
  return workspace;
}

export async function createPatch(store, task) {
  if (!task.workspace || task.isolation !== 'worktree') fail('Git worktree 작업에서만 패치를 만들 수 있습니다.');
  // Intent-to-add includes new files without committing or modifying the source checkout.
  await git(task.workspace, ['add', '--intent-to-add', '--', '.']);
  const patch = await git(task.workspace, ['diff', '--binary', task.baselineTree || task.baseCommit, '--', '.']);
  const target = join(DATA, 'patches', `${task.id}.patch`);
  await mkdir(join(DATA, 'patches'), { recursive: true });
  await writeFile(target, patch);
  return { patch, target };
}

export async function integrate(store, task) {
  if (task.status !== 'done' || task.integratedAt) fail('완료 처리한 미통합 작업만 적용할 수 있습니다.');
  const project = store.require('projects', task.projectId);
  const { patch, target } = await createPatch(store, task);
  if (!patch.trim()) fail('적용할 변경 사항이 없습니다.');
  if ((await git(project.path, ['status', '--porcelain'])).trim()) fail('원본 작업 디렉토리에 변경 사항이 있습니다. 정리한 뒤 적용하세요.');
  await git(project.path, ['apply', '--check', target]);
  await git(project.path, ['apply', target]);
  return { patchPath: target };
}

export async function contextFor(store, member, projectId, documentIds = []) {
  await syncShared(store);
  const dir = await syncMember(store, member);
  const common = await readFile(join(DATA, 'shared', 'instructions.md'), 'utf8');
  const personal = await readFile(join(dir, 'instructions.md'), 'utf8');
  const documents = documentIds.map(key => store.require('documents', key));
  const project = projectId ? store.require('projects', projectId) : null;
  const skills = store.list('documents').filter(doc => doc.kind === 'skill').map(doc => `${doc.title}: ${join(DATA, 'shared', 'skills', doc.id, 'SKILL.md')}`);
  let documentBudget = 14000;
  const excerpts = documents.map(doc => {
    const excerpt = doc.content.slice(0, Math.min(documentBudget, 7000));
    documentBudget -= excerpt.length;
    return `관련 문서 ${doc.title} (v${doc.version}), 원문: ${join(DATA, 'documents', `${doc.id}.md`)}\n${excerpt}${excerpt.length < doc.content.length ? '\n[일부 발췌. 필요한 경우 원문을 읽으세요.]' : ''}`;
  });
  return [
    `당신은 Tars 팀의 ${member.name}입니다. 역할: ${member.role}. 전문 분야: ${member.specialty}.`,
    `공통 지침 원문: ${join(DATA, 'shared', 'instructions.md')}\n${common.slice(0, 8000)}`,
    `개인 지침 원문: ${join(dir, 'instructions.md')}\n${personal.slice(0, 4000)}`,
    `이전 작업 인계 요약:\n${(member.summary || '없음').slice(-2000)}`,
    project ? `프로젝트: ${project.name}\n설명: ${project.description}\n참고 원본: ${project.path}` : '',
    ...excerpts,
    `사용 가능한 공통 스킬 (관련된 것만 읽기):\n${(skills.join('\n') || '없음').slice(0, 3000)}\n전체 목록: ${join(DATA, 'shared', 'skills')}`,
    '토큰을 절약하고 필요한 자료만 읽으세요. 자체 하위 에이전트 생성, 재귀 호출, 자동 재시도는 하지 마세요. 추가 작업은 보고에 제안하세요. 내부 추론 대신 진행 단계와 차단 사항을 짧게 알리세요.',
  ].filter(Boolean).join('\n\n');
}
