import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative } from 'node:path';
import { DATA } from './store.js';
import { fail } from './contracts.js';
import { memberDirectory, scopeDirectory } from './guidance.js';

// Only TARS-managed Markdown files are addressable; request IDs are never paths.
function registry(store) {
  const files = new Map();
  const file = (id, name, path, extra = {}) => {
    const node = { id, type: 'file', name, path, ...extra };
    files.set(id, node);
    return node;
  };
  const folder = (id, name, path, children, extra = {}) => ({ id, type: 'folder', name, path, children, ...extra });
  const documents = store.list('documents');
  const members = store.list('members');
  const sessions = store.list('sessions');
  const tasks = store.list('tasks');
  function memberFolder(member) {
    const dir = memberDirectory(member);
    const prefix = `member:${member.id}`;
    const owner = { memberId: member.id };
    const children = [
      file(`${prefix}:instructions`, 'instructions.md', join(dir, 'instructions.md'), { ...owner, description: '개인 지침' }),
      file(`${prefix}:agents`, 'AGENTS.md', join(dir, 'AGENTS.md'), { ...owner, description: 'Codex 지침', linkTarget: join(dir, 'instructions.md') }),
      file(`${prefix}:claude`, 'CLAUDE.md', join(dir, 'CLAUDE.md'), { ...owner, description: 'Claude 지침', linkTarget: join(dir, 'instructions.md') }),
      file(`${prefix}:profile`, 'profile.md', join(dir, 'profile.md'), { ...owner, description: '프로필' }),
      folder(`${prefix}:inherited`, '공용 지침', DATA, [
        file(`${prefix}:common`, 'AGENTS.md', join(DATA, 'AGENTS.md'), { label: '전체 공용 지침', linkTarget: join(DATA, 'shared', 'instructions.md'), description: '모든 역할에 적용' }),
        ...(member.departmentId ? [file(`${prefix}:department`, 'AGENTS.md', join(DATA, 'departments', member.departmentId, 'AGENTS.md'), {
          label: '부서 공용 지침', linkTarget: join(DATA, 'departments', member.departmentId, 'instructions.md'), description: '같은 부서에 적용',
        })] : []),
      ]),
    ];
    const projects = new Set([...sessions.filter(item => item.memberId === member.id).map(item => item.projectId),
      ...tasks.filter(item => item.assigneeId === member.id).map(item => item.projectId)].filter(Boolean));
    for (const projectId of projects) {
      const project = store.get('projects', projectId);
      if (!project) continue;
      const path = scopeDirectory(member, projectId);
      children.push(folder(`${prefix}:project:${projectId}`, project.name, path, [
        file(`${prefix}:project:${projectId}:agents`, 'AGENTS.md', join(path, 'AGENTS.md'), {
          ...owner, description: '이 AI의 프로젝트 지침', linkTarget: join(path, 'instructions.md'),
        }),
      ], { description: '프로젝트별 실행 공간' }));
    }
    const lastLoaded = sessions.find(item => item.memberId === member.id && item.guidanceStatus === 'loaded');
    if (lastLoaded) children.push(file(`${prefix}:loaded:${lastLoaded.id}`, 'guidance.md', join(DATA, 'sessions', lastLoaded.id, 'guidance.md'), {
      label: '최근 적용 지침 · 스킬', description: 'App Server가 반환한 로딩 결과',
    }));
    if (member.summary) children.push(file(`${prefix}:summary`, 'context-summary.md', join(dir, 'context-summary.md'), { ...owner, description: '최근 작업 인계 요약' }));
    return folder(prefix, member.name, dir, children, {
      ...owner, description: `${member.role === 'ceo' ? 'CEO' : member.role === 'leader' ? '팀장' : '팀원'} · ${member.provider}`,
    });
  }
  const ceo = members.find(member => member.role === 'ceo');
  const root = folder('root', basename(DATA), DATA, [
    file('root:agents', 'AGENTS.md', join(DATA, 'AGENTS.md'), { description: '공용 지침 진입점', linkTarget: join(DATA, 'shared', 'instructions.md') }),
    folder('shared', 'shared', join(DATA, 'shared'), [
      file('shared:instructions', 'instructions.md', join(DATA, 'shared', 'instructions.md'), { description: '공통 지침' }),
      folder('shared:skills', 'skills', join(DATA, 'shared', 'skills'), documents.filter(doc => doc.kind === 'skill').map(doc =>
        folder(`skill:${doc.id}`, doc.title, join(DATA, 'shared', 'skills', doc.id), [
          file(`skill:${doc.id}:content`, 'SKILL.md', join(DATA, 'shared', 'skills', doc.id, 'SKILL.md'), { documentId: doc.id, description: doc.title }),
        ])), { description: '공용 스킬' }),
    ], { description: '공통 자료' }),
    folder('executive', 'executive', join(DATA, 'executive'), ceo ? [memberFolder(ceo)] : [], { description: 'TARS 개인 자료' }),
    folder('departments', 'departments', join(DATA, 'departments'), store.list('departments').sort((a, b) => a.name.localeCompare(b.name, 'ko')).map(department => {
      const dir = join(DATA, 'departments', department.id);
      const team = members.filter(member => member.role !== 'ceo' && member.departmentId === department.id)
        .sort((a, b) => Number(b.role === 'leader') - Number(a.role === 'leader') || a.name.localeCompare(b.name, 'ko'));
      return folder(`department:${department.id}`, department.name, dir, [
        file(`department:${department.id}:agents`, 'AGENTS.md', join(dir, 'AGENTS.md'), { description: '부서 공용 지침', linkTarget: join(dir, 'instructions.md') }),
        folder(`department:${department.id}:members`, 'members', join(dir, 'members'), team.map(memberFolder), { description: '팀장 · 팀원' }),
      ]);
    }), { description: '부서별 개인 자료' }),
    folder('documents', 'documents', join(DATA, 'documents'), documents.map(doc =>
      file(`document:${doc.id}`, `${doc.id}.md`, join(DATA, 'documents', `${doc.id}.md`), { label: doc.title, documentId: doc.id,
        description: doc.kind === 'instruction' ? (doc.instructionMode === 'on_demand' ? `필요할 때 읽기 · ${doc.readWhen}` : '항상 적용') : undefined })), { description: '문서 원문' }),
  ]);
  return { root, files, defaultFileId: ceo ? `member:${ceo.id}:instructions` : 'shared:instructions' };
}

export function knowledgeTree(store) {
  const { root, defaultFileId } = registry(store);
  return { root, defaultFileId };
}

export async function readKnowledgeFile(store, id) {
  const node = registry(store).files.get(id);
  if (!node) fail('조회할 수 없는 지침 파일입니다.', 404);
  let handle;
  try {
    const root = await realpath(DATA);
    const target = await realpath(node.path);
    const path = relative(root, target);
    if (isAbsolute(path) || path === '..' || path.startsWith('../')) fail('TARS 자료 폴더 밖의 파일은 조회할 수 없습니다.', 403);
    const isLink = (await lstat(node.path)).isSymbolicLink();
    handle = await open(target, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) fail('일반 문서 파일이 아닙니다.', 400);
    const limit = 512 * 1024;
    const buffer = Buffer.alloc(Math.min(stat.size, limit));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { ...node, linkTarget: isLink ? target : null, content: buffer.subarray(0, bytesRead).toString('utf8'), truncated: stat.size > limit, modifiedAt: stat.mtime.toISOString() };
  } catch (error) {
    if (error.code === 'ENOENT') fail('이 파일은 아직 생성되지 않았거나 삭제되었습니다.', 404);
    throw error;
  } finally { await handle?.close(); }
}
