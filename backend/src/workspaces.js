import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { DATA } from './store.js';
import { fail } from './contracts.js';
import { appliesTo, GUIDANCE_CONFIG, instructionMode, managedSkillPaths, memberDirectory, relocateGuidanceLinks, renderInstructions, scopeDirectory, syncMember, syncShared } from './guidance.js';
export { memberDirectory, syncMember, syncShared } from './guidance.js';

const exec = promisify(execFile);
export const git = async (cwd, args) => (await exec('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 30000 })).stdout;
export async function projectPath(path) {
  if (!isAbsolute(path)) fail('프로젝트 경로는 절대 경로여야 합니다.', 400);
  const canonical = await realpath(path);
  if (!(await lstat(canonical)).isDirectory()) fail('프로젝트 디렉토리가 아닙니다.', 400);
  if (canonical === DATA || canonical.startsWith(DATA + '/')) fail('Tars 데이터 디렉토리는 소스 프로젝트로 등록할 수 없습니다.', 400);
  return canonical;
}

export async function prepareWorkspace(store, task, member) {
  const destination = join(scopeDirectory(member, task.projectId), 'workspaces', task.id);
  if (task.workspace) {
    await access(task.workspace);
    if (member.provider === 'codex' && task.workspace !== destination) {
      const previous = task.workspace;
      const path = relative(DATA, previous);
      if (isAbsolute(path) || path === '..' || path.startsWith('../')) fail('기존 작업 공간이 TARS 데이터 폴더 밖에 있어 이동하지 않았습니다.');
      await mkdir(dirname(destination), { recursive: true });
      try { await lstat(destination); fail('새 지침 경로에 작업 폴더가 이미 있습니다. 기존 파일을 보존했습니다.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (task.isolation === 'worktree') await git(store.require('projects', task.projectId).path, ['worktree', 'move', previous, destination]);
      else await rename(previous, destination);
      relocateGuidanceLinks(store, previous, destination);
      store.patch('tasks', task.id, { workspace: destination });
      task.workspace = destination;
    }
    return task.workspace;
  }
  let workspace;
  let baseCommit = null;
  let baselineTree = null;
  if (task.projectId && task.isolation !== 'personal') {
    const project = store.require('projects', task.projectId);
    workspace = member.provider === 'codex' ? destination : join(DATA, 'workspaces', task.id);
    await mkdir(dirname(workspace), { recursive: true });
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
    workspace = member.provider === 'codex' ? destination : join(memberDirectory(member), 'workspaces', task.id);
    await mkdir(workspace, { recursive: true });
  }
  store.patch('tasks', task.id, { workspace, baseCommit, baselineTree });
  return workspace;
}

export async function createPatch(store, task) {
  if (!task.workspace || task.isolation !== 'worktree') fail('Git worktree 작업에서만 패치를 만들 수 있습니다.');
  // Exclude only links owned by TARS, never the project's AGENTS.md or its own skills.
  const paths = ['.', ...managedSkillPaths(store, task.workspace).map(path => `:(top,exclude,literal)${path}`)];
  // Intent-to-add includes new files without committing or modifying the source checkout.
  await git(task.workspace, ['add', '--intent-to-add', '--', ...paths]);
  const patch = await git(task.workspace, ['diff', '--binary', task.baselineTree || task.baseCommit, '--', ...paths]);
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

export async function contextFor(store, member, projectId, documentIds = [], { includeSummary = true } = {}) {
  const native = member.provider === 'codex';
  const dir = memberDirectory(member);
  if (!native) { await syncShared(store); await syncMember(store, member); }
  const common = native ? '' : await readFile(join(DATA, 'shared', 'instructions.md'), 'utf8');
  const personal = native ? '' : await readFile(join(dir, 'instructions.md'), 'utf8');
  const scoped = native ? [] : store.list('documents').filter(doc => doc.kind === 'instruction'
    && (doc.departmentId || doc.projectId) && appliesTo(doc, member, projectId));
  const scopedInstructions = renderInstructions(scoped);
  if (!native && Buffer.byteLength([common, personal, scopedInstructions].join('\n\n')) > GUIDANCE_CONFIG.project_doc_max_bytes) {
    fail("TARS가 전달할 지침이 32 KiB 한도를 초과했습니다. 상세 지침을 '필요할 때 읽기' 또는 스킬로 분리하세요.");
  }
  const selectedDocuments = [...new Set(documentIds)].map(key => store.require('documents', key));
  const selectedInstructions = selectedDocuments
    .filter(doc => doc.kind === 'instruction' && (instructionMode(doc) === 'on_demand' || !appliesTo(doc, member, projectId)))
    .map(doc => `선택한 지침 ${doc.title} (v${doc.version}): ${join(DATA, 'documents', `${doc.id}.md`)}\n이 작업을 위해 선택된 지침입니다. 원문을 읽고 적용하세요.`);
  const documents = selectedDocuments.filter(doc => doc.kind !== 'instruction' && (!native || doc.kind !== 'skill'));
  const project = projectId ? store.require('projects', projectId) : null;
  const skills = native ? [] : store.list('documents').filter(doc => doc.kind === 'skill' && appliesTo(doc, member, projectId)).map(doc => `${doc.title}: ${join(DATA, 'shared', 'skills', doc.id, 'SKILL.md')}`);
  let documentBudget = 14000;
  const excerpts = documents.map(doc => {
    const excerpt = doc.content.slice(0, Math.min(documentBudget, 7000));
    documentBudget -= excerpt.length;
    return `관련 문서 ${doc.title} (v${doc.version}), 원문: ${join(DATA, 'documents', `${doc.id}.md`)}\n${excerpt}${excerpt.length < doc.content.length ? '\n[일부 발췌. 필요한 경우 원문을 읽으세요.]' : ''}`;
  });
  return [
    native ? '' : `당신은 Tars 팀의 ${member.name}입니다. 역할: ${member.role}. 전문 분야: ${member.specialty}.`,
    native ? '' : `공통 지침 원문: ${join(DATA, 'shared', 'instructions.md')}\n${common}`,
    native ? '' : `개인 지침 원문: ${join(dir, 'instructions.md')}\n${personal}`,
    scopedInstructions,
    ...selectedInstructions,
    includeSummary ? `이전 작업 인계 요약:\n${(member.summary || '없음').slice(-2000)}` : '',
    project ? `프로젝트: ${project.name}\n설명: ${member.role === 'ceo' ? project.description.slice(0, 1000) : project.description}\n참고 원본: ${project.path}` : '',
    ...excerpts,
    native ? '' : `사용 가능한 공통 스킬 (관련된 것만 읽기):\n${(skills.join('\n') || '없음').slice(0, 3000)}\n전체 목록: ${join(DATA, 'shared', 'skills')}`,
  ].filter(Boolean).join('\n\n');
}
