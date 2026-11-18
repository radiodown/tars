import { resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { executable } from './executables.js';
import { codexConnection } from './codex-rpc.js';
import { prepareScope, prepareGuidance } from './guidance.js';
import { fail } from './contracts.js';
import { skillMentions } from '../../shared/skill-mentions.mjs';

const active = new Set();

export function normalizeSkills(response, cwd) {
  const entry = response?.data?.find(item => typeof item.cwd === 'string' && resolve(item.cwd) === resolve(cwd));
  if (!Array.isArray(entry?.skills)) throw new Error('스킬 목록을 확인하지 못했습니다.');
  const skills = new Map();
  for (const item of entry.skills) {
    if (item.enabled === false || typeof item.name !== 'string' || !/^[\p{L}\p{N}_:-]{1,160}$/u.test(item.name)
      || typeof item.path !== 'string' || !item.path.startsWith('/')) continue;
    const path = resolve(item.path);
    skills.set(`${item.name}:${path}`, { name: item.name, path,
      label: String(item.interface?.displayName || item.name).slice(0, 200),
      description: String(item.interface?.shortDescription || item.shortDescription || item.description || '').slice(0, 1000),
      scope: typeof item.scope === 'string' ? item.scope : 'user' });
  }
  const counts = new Map();
  for (const skill of skills.values()) counts.set(skill.name, (counts.get(skill.name) || 0) + 1);
  return { skills: [...skills.values()].map(skill => ({ ...skill,
    ...(counts.get(skill.name) > 1 ? { disabledReason: '같은 이름의 스킬이 여러 개 있습니다. 메시지에 사용할 스킬의 경로를 명시하세요.' } : {}),
  })).sort((a, b) => a.name.localeCompare(b.name)),
  warnings: (entry.errors || []).map(error => String(error.message || '일부 스킬을 읽지 못했습니다.').slice(0, 500)) };
}

export function codexChatInput(text, userPrompt, skills) {
  const names = skillMentions(userPrompt);
  const selected = skills.filter(skill => names.has(skill.name));
  const ambiguous = selected.find(skill => skill.disabledReason);
  if (ambiguous) throw new Error(`$${ambiguous.name}: ${ambiguous.disabledReason}`);
  return [{ type: 'text', text }, ...selected.map(({ name, path }) => ({ type: 'skill', name, path }))];
}

export async function readCodexSkills(binary, cwd, signal) {
  const rpc = codexConnection(binary, signal);
  try {
    await rpc.call('initialize', { clientInfo: { name: 'tars_skills', title: 'Tars', version: '0.1.0' } });
    rpc.initialized();
    const response = await rpc.call('skills/list', { cwds: [cwd], forceReload: true });
    const canonical = path => realpath(path).catch(() => path);
    const data = await Promise.all((response?.data || []).map(async entry => ({ ...entry,
      cwd: typeof entry.cwd === 'string' ? await canonical(entry.cwd) : entry.cwd,
      skills: Array.isArray(entry.skills) ? await Promise.all(entry.skills.map(async skill => ({ ...skill,
        path: typeof skill.path === 'string' ? await canonical(skill.path) : skill.path,
      }))) : entry.skills,
    })));
    return normalizeSkills({ data }, await canonical(cwd));
  } finally { rpc.close(); }
}

export async function chatSkills(store, memberId, { projectId = null, sessionId } = {}) {
  const member = store.require('members', memberId);
  const session = sessionId ? store.require('sessions', sessionId) : null;
  if (session && session.memberId !== memberId) fail('다른 AI의 실행 범위는 조회할 수 없습니다.', 400);
  const provider = session?.provider || member.provider;
  if (provider !== 'codex') return { status: 'unavailable', skills: [], message: '$ 스킬 선택은 Codex 대화에서 사용할 수 있습니다.' };
  const account = session?.codexAccount || member.codexAccount || 'codex';
  const controller = new AbortController();
  active.add(controller);
  try {
    const binary = await executable(account);
    if (!binary) throw new Error(`${account} 실행 명령을 찾을 수 없습니다.`);
    let cwd = session?.workspace;
    if (session && !cwd) throw new Error('작업 디렉토리를 준비 중입니다. 잠시 후 다시 조회하세요.');
    if (!session) {
      if (member.status === 'running') throw new Error('실행 준비 중입니다. 잠시 후 다시 조회하세요.');
      const scope = member.role === 'ceo' ? projectId : store.require('departments', member.departmentId).projectId || null;
      if (scope) store.require('projects', scope);
      // Materialize the same SQLite-backed scope as execution, including a first chat.
      // Keep the existing generator responsible for instructions and skill links.
      cwd = await prepareScope(store, member, scope);
      await prepareGuidance(store, member, scope, cwd);
    }
    const result = await readCodexSkills(binary, cwd, controller.signal);
    return { status: 'ready', ...result, account, cwd };
  } catch (error) {
    if (error.statusCode === 404 || error.statusCode === 400) throw error;
    return { status: 'unavailable', skills: [], message: error.message || '스킬 목록을 불러오지 못했습니다.' };
  } finally { active.delete(controller); }
}

export function closeChatSkills() { for (const controller of active) controller.abort(); }
