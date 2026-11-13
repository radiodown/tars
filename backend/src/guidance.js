import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DATA } from './store.js';
import { fail } from './contracts.js';
import { agentAccessInstructions, DEFAULT_INSTRUCTIONS, LEGACY_DEFAULT_INSTRUCTIONS, PREVIOUS_DEFAULT_INSTRUCTIONS, PREVIOUS_WORK_INSTRUCTIONS, PREVIOUS_REGISTRATION_INSTRUCTIONS } from './agent-access.js';

export const GUIDANCE_CONFIG = { project_root_markers: ['.tars-root'], project_doc_max_bytes: 32 * 1024 };
export const memberDirectory = member => member.role === 'ceo'
  ? join(DATA, 'executive', 'tars') : join(DATA, 'departments', member.departmentId, 'members', member.id);
export const scopeDirectory = (member, projectId) => projectId ? join(memberDirectory(member), 'projects', projectId) : memberDirectory(member);
export const appliesTo = (doc, member, projectId) => (!doc.departmentId || doc.departmentId === member.departmentId)
  && (!doc.projectId || doc.projectId === projectId);
const hash = value => createHash('sha256').update(value).digest('hex');
const sharedSkills = join(DATA, 'shared', 'skills');
const commonRules = '자동 적용된 지침은 변경 확인이 필요한 경우에만 다시 읽으세요. 참고 지침은 명시된 적용 조건이 현재 작업에 맞을 때 해당 원문만 읽으세요. 관련 스킬의 SKILL.md와 필요한 참고 자료만 읽으세요. 내부 추론 대신 진행 단계와 차단 사항을 짧게 알리세요. 작업 종료 보고에는 받은 지시, 수행한 task, 결과·산출물, 검증·미검증, 미완료·차단 사유를 구분하세요. TARS가 이력을 저장하므로 별도 이력 파일을 직접 수정하지 마세요. 실행 종료와 검토 완료는 다릅니다. 관리자는 배정·보고 전에 제공된 조직 상태 파일의 확인 시각과 담당자 실행 여부를 확인하세요.';

export function reviseDocument(store, existing, input) {
  const revisions = [...existing.revisions, { version: existing.version, content: existing.content, title: existing.title,
    instructionMode: existing.instructionMode || 'always', readWhen: existing.readWhen || '', savedAt: existing.updatedAt }];
  return store.patch('documents', existing.id, { ...input, version: existing.version + 1, revisions });
}
export function initializeDefaultInstructions(store) {
  const documents = store.list('documents');
  if (!documents.some(doc => doc.kind === 'instruction')) {
    store.put('documents', { title: '팀 공통 작업 원칙', kind: 'instruction', instructionMode: 'always', version: 1,
      revisions: [], projectId: null, departmentId: null, content: DEFAULT_INSTRUCTIONS });
  }
  // Upgrade only the untouched, TARS-generated default. Keep custom rules and history.
  for (const doc of documents) if (doc.kind === 'instruction' && doc.title === '팀 공통 작업 원칙'
    && !doc.departmentId && !doc.projectId && [LEGACY_DEFAULT_INSTRUCTIONS, PREVIOUS_DEFAULT_INSTRUCTIONS, PREVIOUS_WORK_INSTRUCTIONS, PREVIOUS_REGISTRATION_INSTRUCTIONS].includes(doc.content)) {
    reviseDocument(store, doc, { content: DEFAULT_INSTRUCTIONS });
  }
}
// Missing mode means legacy always-on guidance; never silently demote existing rules.
export const instructionMode = doc => doc.instructionMode || 'always';
const contentKey = content => content.replace(/\r\n/g, '\n').trim();
const oneLine = value => String(value || '').replace(/\s+/g, ' ').trim();
const commonInstructions = docs => docs.filter(doc => doc.kind === 'instruction' && !doc.departmentId && !doc.projectId);
const departmentInstructions = (docs, departmentId) => docs.filter(doc => doc.kind === 'instruction' && departmentId && doc.departmentId === departmentId && !doc.projectId);

// Keep the last exact duplicate within a scope to retain its precedence. Never
// collapse scopes: a child may deliberately restore a rule overridden in between.
export function renderInstructions(docs) {
  const keyFor = doc => JSON.stringify([doc.departmentId || null, doc.projectId || null, contentKey(doc.content)]);
  const last = new Map();
  docs.forEach((doc, index) => { if (instructionMode(doc) === 'always') last.set(keyFor(doc), index); });
  const parts = [];
  const references = [];
  for (const [index, doc] of docs.entries()) {
    if (instructionMode(doc) === 'on_demand') {
      references.push(`- ${oneLine(doc.title)} — 읽을 때: ${oneLine(doc.readWhen)}; 원문: ${join(DATA, 'documents', `${doc.id}.md`)} (v${doc.version})`);
      continue;
    }
    if (!contentKey(doc.content) || last.get(keyFor(doc)) !== index) continue;
    parts.push(`# ${doc.title}\n\n${doc.content}`);
  }
  if (references.length) parts.push(`## 필요할 때 읽는 지침\n\n${references.join('\n')}`);
  return parts.join('\n\n---\n\n');
}
const stat = async path => { try { return await lstat(path); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; } };

// Rendered files belong to TARS. Replace atomically, without rewriting unchanged files.
async function renderFile(path, content) {
  const info = await stat(path);
  if (info && !info.isFile()) fail(`지침 생성 경로가 일반 파일이 아닙니다: ${path}`);
  if (info && await readFile(path, 'utf8') === content) return;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, content); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

async function linkFile(target, path) {
  const info = await stat(path);
  if (info) {
    if (info.isSymbolicLink() && resolve(dirname(path), await readlink(path)) === resolve(target)) return;
    fail(`기존 파일과 TARS 지침 연결이 충돌합니다. 파일을 보존했습니다: ${path}`);
  }
  await mkdir(dirname(path), { recursive: true });
  await symlink(relative(dirname(path), target), path);
}

async function removeDeletedDepartmentGuidance(store) {
  const root = join(DATA, 'departments');
  const rootInfo = await stat(root);
  if (!rootInfo) return;
  if (!rootInfo.isDirectory()) fail(`부서 지침 경로가 디렉토리가 아닙니다: ${root}`);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name) || store.get('departments', entry.name)) continue;
    const dir = join(root, entry.name);
    const instructions = join(dir, 'instructions.md');
    const agents = join(dir, 'AGENTS.md');
    const agentInfo = await stat(agents);
    if (agentInfo && (!agentInfo.isSymbolicLink() || resolve(dir, await readlink(agents)) !== instructions)) continue;
    if (agentInfo) await rm(agents);
    const instructionsInfo = await stat(instructions);
    if (instructionsInfo?.isFile()) await rm(instructions);
    try { await rmdir(dir); } catch (error) { if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) throw error; }
  }
}

let sharedWrites = Promise.resolve();
export function syncShared(store) {
  const pending = sharedWrites.then(() => writeShared(store));
  sharedWrites = pending.catch(() => {});
  return pending;
}

async function writeShared(store) {
  const documents = store.list('documents');
  await mkdir(sharedSkills, { recursive: true });
  for (const doc of documents) await renderFile(join(DATA, 'documents', `${doc.id}.md`), doc.content);
  const instructions = documents.filter(doc => doc.kind === 'instruction');
  const common = commonInstructions(instructions);
  await renderFile(join(DATA, 'shared', 'instructions.md'), `# TARS 공용 지침\n\n${commonRules}\n\n${agentAccessInstructions}\n\n${renderInstructions(common)}\n`);
  await renderFile(join(DATA, '.tars-root'), 'TARS instruction discovery root\n');
  await linkFile(join(DATA, 'shared', 'instructions.md'), join(DATA, 'AGENTS.md'));
  for (const department of store.list('departments')) {
    const dir = join(DATA, 'departments', department.id);
    await renderFile(join(dir, 'instructions.md'), `# ${department.name} 공용 지침\n\n${renderInstructions(departmentInstructions(instructions, department.id))}\n`);
    await linkFile(join(dir, 'instructions.md'), join(dir, 'AGENTS.md'));
  }
  await removeDeletedDepartmentGuidance(store);
  for (const skill of documents.filter(doc => doc.kind === 'skill')) {
    const content = skill.content.startsWith('---\n') || skill.content.startsWith('---\r\n') ? skill.content
      : `---\nname: skill-${skill.id}\ndescription: ${JSON.stringify(skill.title)}\n---\n\n${skill.content}`;
    // Keep supporting scripts/references alongside SKILL.md; never replace the directory.
    await renderFile(join(sharedSkills, skill.id, 'SKILL.md'), content);
  }
}

export async function syncMember(store, member) {
  const dir = memberDirectory(member);
  const role = member.role === 'ceo'
    ? 'CEO TARS: 사용자와 대화로 업무를 받고 상위 요청을 관리합니다. 요구사항과 설계, 검토, 팀장·팀원 위임, 실행과 결과 확인을 조율하고 사용자에게 보고합니다. 요청에 필요한 조직 구성과 구현·검증도 수행합니다.'
    : member.role === 'leader'
      ? '팀장: 사용자와 대화로 받은 업무를 요구사항·설계 문서와 하위 작업으로 기록합니다. 설계 검토와 작업 위임, 구현, 실행, 결과 확인과 보고를 수행합니다. 사용자 요청에 필요한 도구를 직접 사용합니다.'
      : '팀원: 배정된 범위에서 작업하고 결과, 변경 파일, 차단 사항과 검증 여부를 보고합니다.';
  const department = member.role === 'ceo' ? '전체 조직 · 모든 부서 상위' : store.require('departments', member.departmentId).name;
  await renderFile(join(dir, 'profile.md'), `# ${member.name}\n\n소속: ${department}\n역할: ${member.role}\n도구: ${member.provider}\n${member.provider === 'codex' ? `실행 계정: ${member.codexAccount || 'codex'}\n` : ''}모델: ${member.model || 'CLI 기본값'}\n전문 분야: ${member.specialty}\n`);
  await renderFile(join(dir, 'instructions.md'), `# ${member.name} 작업 지침\n\n${role}\n\n전문 분야: ${member.specialty}\n\n${member.instructions || ''}\n`);
  await linkFile(join(dir, 'instructions.md'), join(dir, 'AGENTS.md'));
  await linkFile(join(dir, 'instructions.md'), join(dir, 'CLAUDE.md'));
  await linkFile(sharedSkills, join(dir, '.claude', 'skills'));
  // Upgrade only the exact old TARS link. Project-owned skill directories are untouched.
  const oldSkills = join(dir, '.agents', 'skills');
  const oldInfo = await stat(oldSkills);
  if (oldInfo?.isSymbolicLink() && resolve(dirname(oldSkills), await readlink(oldSkills)) === sharedSkills) await rm(oldSkills);
  return dir;
}

export async function prepareScope(store, member, projectId) {
  await syncShared(store);
  await syncMember(store, member);
  const dir = scopeDirectory(member, projectId);
  if (projectId) {
    const project = store.require('projects', projectId);
    const documents = store.list('documents');
    const docs = documents.filter(doc => doc.kind === 'instruction' && doc.projectId === projectId && appliesTo(doc, member, projectId));
    await renderFile(join(dir, 'instructions.md'), `# ${project.name} 작업 지침\n\n${renderInstructions(docs)}\n`);
    await linkFile(join(dir, 'instructions.md'), join(dir, 'AGENTS.md'));
  }
  return dir;
}

const linksId = cwd => hash(resolve(cwd));
export function managedSkillPaths(store, cwd) {
  return (store.get('guidanceLinks', linksId(cwd))?.links || []).map(link => link.path);
}

export function relocateGuidanceLinks(store, previous, cwd) {
  const record = store.get('guidanceLinks', linksId(previous));
  if (record) store.put('guidanceLinks', { ...record, id: linksId(cwd), cwd });
}

async function syncSkills(store, member, projectId, cwd) {
  const docs = store.list('documents').filter(doc => doc.kind === 'skill' && appliesTo(doc, member, projectId));
  const id = linksId(cwd);
  let links = store.get('guidanceLinks', id)?.links || [];
  const root = await realpath(cwd);
  const inside = path => { const offset = relative(root, path); return offset && !isAbsolute(offset) && offset !== '..' && !offset.startsWith('../'); };
  let skillsDirectory;
  for (const path of [join(cwd, '.agents'), join(cwd, '.agents', 'skills')]) {
    const info = await stat(path);
    if (info) {
      // Projects may share skills through .agents/skills -> ../.claude/skills.
      // Follow only existing directories inside this workspace, never a source checkout.
      let canonical;
      try { canonical = await realpath(path); }
      catch (error) {
        if (!['ENOENT', 'ELOOP', 'ENOTDIR'].includes(error.code)) throw error;
        fail(`스킬 폴더 연결 대상을 확인할 수 없습니다: ${path} (${error.code}). 끊어진 링크나 순환 링크인지 확인하세요. 기존 경로는 보존했습니다.`);
      }
      if (!inside(canonical)) fail(`스킬 폴더 연결이 작업 공간 밖 또는 작업 공간 루트를 가리킵니다: ${path} → ${canonical}. 작업 공간 내부의 스킬 디렉토리를 사용하세요. 기존 경로는 보존했습니다.`);
      if (!(await lstat(canonical)).isDirectory()) fail(`스킬 폴더 연결 대상이 디렉토리가 아닙니다: ${path} → ${canonical}. 기존 파일은 보존했습니다.`);
      skillsDirectory = canonical;
    } else {
      await mkdir(path);
      skillsDirectory = await realpath(path);
    }
  }
  // Git records the physical path, not files below a directory symlink.
  const wanted = docs.map(doc => ({ path: relative(root, join(skillsDirectory, `tars-${doc.id}`)), target: join(sharedSkills, doc.id) }));
  for (const existing of links) {
    if (wanted.some(item => item.path === existing.path && item.target === existing.target)) continue;
    const path = join(cwd, existing.path);
    const info = await stat(path);
    if (info && !inside(await realpath(dirname(path)))) fail(`스킬 폴더 연결이 작업 공간 밖을 가리킵니다: ${path}`);
    if (info && (!info.isSymbolicLink() || resolve(dirname(path), await readlink(path)) !== existing.target)) fail(`변경된 TARS 스킬 연결을 보존했습니다: ${path}`);
    if (info) await rm(path);
    links = links.filter(item => item.path !== existing.path);
    store.put('guidanceLinks', { id, cwd, links });
  }
  for (const item of wanted) {
    const path = join(cwd, item.path);
    if (!links.some(existing => existing.path === item.path)) {
      if (await stat(path)) fail(`프로젝트의 기존 스킬과 이름이 충돌합니다: ${path}`);
      links = [...links, item];
      // Record ownership before creating the link, including interrupted preparations.
      store.put('guidanceLinks', { id, cwd, links });
    }
    // Absolute links remain correct when an existing worktree is moved under its member.
    const info = await stat(path);
    if (info) {
      if (!info.isSymbolicLink() || resolve(dirname(path), await readlink(path)) !== item.target) fail(`변경된 TARS 스킬 연결을 보존했습니다: ${path}`);
    } else await symlink(item.target, path);
  }
  return docs.map(doc => ({ id: doc.id, title: doc.title, path: join(sharedSkills, doc.id, 'SKILL.md'), version: doc.version }));
}

export async function prepareGuidance(store, member, projectId, cwd) {
  const scope = scopeDirectory(member, projectId);
  const offset = relative(scope, cwd);
  if (isAbsolute(offset) || offset === '..' || offset.startsWith('../')) fail('작업 디렉토리가 담당 AI의 지침 경로 밖에 있습니다.');
  // Previously launched parent contexts may still be scanned. Reconcile their
  // owned links too, so changing a document's scope cannot leak an old skill.
  const memberDir = memberDirectory(member);
  if (cwd !== memberDir) await syncSkills(store, member, null, memberDir);
  if (scope !== memberDir && scope !== cwd) await syncSkills(store, member, projectId, scope);
  const skills = await syncSkills(store, member, projectId, cwd);
  const required = [join(DATA, 'AGENTS.md'),
    ...(member.departmentId ? [join(DATA, 'departments', member.departmentId, 'AGENTS.md')] : []),
    join(memberDirectory(member), 'AGENTS.md'), ...(projectId ? [join(scope, 'AGENTS.md')] : [])];
  const directories = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    directories.unshift(dir);
    if (dir === DATA) break;
    if (dirname(dir) === dir) fail('TARS 지침 루트를 찾을 수 없습니다.');
  }
  const sources = [];
  const fingerprint = ['tars-guidance-v2'];
  let bytes = 0;
  for (const dir of directories) {
    if (dir !== DATA && await stat(join(dir, '.tars-root'))) fail(`작업 경로에 중첩된 TARS 지침 루트가 있습니다: ${dir}`);
    for (const name of ['AGENTS.override.md', 'AGENTS.md']) {
      const path = join(dir, name);
      if (!await stat(path)) continue;
      const content = await readFile(path, 'utf8');
      if (!content.trim()) continue;
      bytes += Buffer.byteLength(content) + 2;
      sources.push(path);
      fingerprint.push(path, content);
      break;
    }
    const config = join(dir, '.codex', 'config.toml');
    if (await stat(config)) fingerprint.push(config, await readFile(config, 'utf8'));
  }
  if (required.some(path => !sources.includes(path))) fail('AGENTS.override.md가 공용 또는 개인 지침을 가리고 있습니다. 지침 파일을 확인하세요.');
  if (bytes > GUIDANCE_CONFIG.project_doc_max_bytes) fail(`자동 적용 지침이 32 KiB 한도를 초과했습니다 (${bytes} bytes). 상세 지침을 '필요할 때 읽기' 또는 스킬로 분리하세요. 적용 경로: ${sources.join(', ')}`);
  for (const skill of skills) fingerprint.push(skill.path, await readFile(skill.path, 'utf8'));
  const documentWarnings = [];
  const documentContents = new Map();
  const instructions = store.list('documents').filter(doc => doc.kind === 'instruction' && instructionMode(doc) === 'always' && appliesTo(doc, member, projectId));
  for (const doc of [...instructions, { title: `${member.name} 개인 지침`, content: member.instructions || '', memberId: member.id }]) {
    const key = contentKey(doc.content);
    if (!key) continue;
    const other = documentContents.get(key);
    if (other) {
      const sameScope = !doc.memberId && !other.memberId && (doc.departmentId || null) === (other.departmentId || null) && (doc.projectId || null) === (other.projectId || null);
      documentWarnings.push(`같은 본문의 등록 지침: ${oneLine(other.title)} / ${oneLine(doc.title)} (${sameScope ? '같은 범위에서는 한 번 포함' : '상속 우선순위 보존을 위해 각 범위에 유지'})`);
    } else documentContents.set(key, doc);
  }
  return { hash: hash(JSON.stringify(fingerprint)), expectedSources: sources, skills, documentWarnings };
}

export async function inspectLoadedGuidance(guidance, response, skillResponse, cwd) {
  const sources = response.instructionSources;
  if (!Array.isArray(sources) || sources.some(path => typeof path !== 'string')) throw new Error('설치된 Codex가 instructionSources를 제공하지 않아 지침 로딩을 확인할 수 없습니다.');
  const loaded = new Set();
  const instructionFiles = [];
  const contents = new Map();
  let instructionBytes = 0;
  for (const path of sources) {
    const canonical = await realpath(path);
    const content = await readFile(canonical);
    const key = hash(contentKey(content.toString('utf8')));
    const duplicateOf = contents.get(key) || null;
    if (!duplicateOf) contents.set(key, path);
    loaded.add(canonical);
    // Count every reported occurrence, including aliases of the same file.
    instructionBytes += content.length + 2;
    instructionFiles.push({ path, bytes: content.length, duplicateOf });
  }
  if (instructionBytes > GUIDANCE_CONFIG.project_doc_max_bytes) throw new Error(`전역 지침을 포함한 자동 적용 지침이 32 KiB 한도를 초과했습니다 (${instructionBytes} bytes). 상세 지침을 '필요할 때 읽기' 또는 스킬로 분리하세요. 적용 경로: ${sources.join(', ')}`);
  const guidanceWarnings = [...(guidance.documentWarnings || [])];
  if (instructionBytes > 16 * 1024) guidanceWarnings.push('자동 적용 지침이 권장 크기 16 KiB를 넘었습니다. 상세 절차를 필요할 때 읽도록 분리하세요.');
  for (const file of instructionFiles) {
    if (file.bytes > 8 * 1024) guidanceWarnings.push(`큰 지침 파일 (${file.bytes} bytes): ${file.path}`);
    if (file.duplicateOf) guidanceWarnings.push(`동일한 지침 본문이 반복됩니다: ${file.path} = ${file.duplicateOf}`);
  }
  const missing = [];
  for (const path of guidance.expectedSources) if (!loaded.has(await realpath(path))) missing.push(path);
  if (missing.length) throw new Error(`필수 지침이 로딩되지 않았습니다: ${missing.join(', ')}`);
  const canonicalCwd = await realpath(cwd);
  let entry;
  for (const item of skillResponse?.data || []) {
    if (typeof item.cwd === 'string' && await realpath(item.cwd) === canonicalCwd) { entry = item; break; }
  }
  if (!entry || !Array.isArray(entry.skills)) throw new Error('App Server의 스킬 탐색 결과를 확인할 수 없습니다.');
  if (entry.errors?.length) throw new Error(`스킬 로딩 오류: ${entry.errors.map(item => item.message || item.path || '잘못된 SKILL.md').join(', ')}`);
  const expectedPaths = new Set(await Promise.all(guidance.skills.map(skill => realpath(skill.path))));
  const skills = [];
  const names = new Map();
  for (const skill of entry.skills) {
    if (skill.enabled === false) continue;
    const path = await realpath(skill.path);
    const other = names.get(skill.name);
    if (other && other !== path && (expectedPaths.has(path) || expectedPaths.has(other))) throw new Error(`TARS 스킬과 이름이 중복된 스킬이 있습니다: ${skill.name}`);
    if (skills.some(item => item.name === skill.name && item.path === path)) continue;
    names.set(skill.name, path);
    skills.push({ name: skill.name, path, description: skill.description });
  }
  for (const expected of guidance.skills) {
    if (!skills.some(skill => skill.path === expected.path || skill.path === resolve(expected.path))) {
      const canonical = await realpath(expected.path);
      if (!skills.some(skill => skill.path === canonical)) throw new Error(`공용 스킬이 발견되지 않았거나 비활성화되어 있습니다: ${expected.title}`);
    }
  }
  const loadedGuidanceHash = await guidanceFilesHash([...sources, ...skills.map(skill => skill.path)]);
  return { instructionSources: sources, instructionFiles, instructionBytes, guidanceWarnings,
    availableSkills: skills, loadedGuidanceHash, guidanceStatus: 'loaded' };
}

// Include account-wide/project-owned files in the resume decision, without putting
// their contents into the user prompt or storing them in TARS's session records.
export async function guidanceFilesHash(paths) {
  const digest = createHash('sha256');
  for (const path of [...new Set(paths)].sort()) {
    try { digest.update(path).update('\0').update(await readFile(path)).update('\0'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  return digest.digest('hex');
}
