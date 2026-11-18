import { executable } from './executables.js';
import { codexConnection } from './codex-rpc.js';
import { readClaudeModels } from './claude-models.js';
import { modelSettingsError } from '../../shared/model-settings.mjs';

const cache = new Map();
const active = new Set();
const validEffort = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(value);
const shortText = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';

async function readCodex(signal, account) {
  const binary = await executable(account);
  if (!binary) return { status: 'unavailable', models: [], message: `${account} 실행 명령을 찾을 수 없습니다. 해당 계정의 CLI 설치와 경로를 확인하세요.` };
  const rpc = codexConnection(binary, signal);
  try {
    await rpc.call('initialize', { clientInfo: { name: 'tars_models', title: 'Tars', version: '0.1.0' } });
    rpc.initialized();
    const models = new Map();
    const cursors = new Set();
    let cursor;
    for (let page = 0; page < 5; page++) {
      const result = await rpc.call('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result?.data)) throw new Error('Invalid model catalog');
      for (const item of result.data) {
        if (!item || item.hidden || typeof item.model !== 'string' || !item.model.trim() || item.model.length > 100) continue;
        const efforts = Array.isArray(item.supportedReasoningEfforts)
          ? [...new Set(item.supportedReasoningEfforts.map(option => option?.reasoningEffort).filter(validEffort))].slice(0, 20) : null;
        models.set(item.model, {
          id: item.model, label: shortText(item.displayName, 120) || item.model,
          reasoningEfforts: efforts,
          defaultReasoning: validEffort(item.defaultReasoningEffort) ? item.defaultReasoningEffort : null,
        });
      }
      cursor = result.nextCursor;
      if (!cursor) break;
      if (typeof cursor !== 'string' || cursor.length > 4000 || cursors.has(cursor)) throw new Error('Invalid catalog cursor');
      cursors.add(cursor);
    }
    return { status: models.size ? 'ready' : 'unavailable', models: [...models.values()],
      message: cursor ? '목록이 길어 일부 모델만 표시합니다. 다른 모델은 직접 입력할 수 있습니다.'
        : models.size ? `${account} 계정의 CLI가 제공하는 모델 목록입니다.` : '제공된 모델이 없습니다. 기본 모델이나 직접 입력을 사용할 수 있습니다.' };
  } finally { rpc.close(); }
}

export async function modelCatalog(provider, account = 'codex') {
  if (provider === 'claude') account = 'claude';
  const key = `${provider}:${account}`;
  const cached = cache.get(key);
  if (cached?.pending) return cached.pending;
  if (cached?.value && cached.expires > Date.now()) return cached.value;
  const controller = new AbortController();
  active.add(controller);
  const entry = { pending: null, value: null, expires: 0 };
  cache.set(key, entry);
  entry.pending = (async () => {
    let result;
    try {
      if (provider === 'claude') {
        const binary = await executable('claude');
        const models = binary ? await readClaudeModels(binary, controller.signal) : [];
        result = { status: models.length ? 'ready' : 'unavailable', models,
          message: models.length ? '설치된 Claude CLI의 모델 버전과 지원 추론 단계입니다. CLI 기본 모델은 실행 위치의 설정을 따릅니다.'
            : 'Claude 모델 목록을 불러오지 못했습니다. CLI 설치와 로그인 상태를 확인하세요.' };
      } else result = await readCodex(controller.signal, account);
    }
    catch { result = { status: 'unavailable', models: [], message: `${account} 모델 목록을 불러오지 못했습니다. 해당 계정의 로그인 상태를 확인하세요.` }; }
    finally { active.delete(controller); }
    entry.value = { provider, accountId: account, ...result, checkedAt: new Date().toISOString() };
    entry.expires = Date.now() + (result.status === 'ready' ? 600_000 : 60_000);
    entry.pending = null;
    return entry.value;
  })();
  return entry.pending;
}

export async function validateModelSettings(member) {
  for (const profile of Object.values(member.sessionProfiles || {})) await validateModelSettings({ ...member, ...profile, sessionProfiles: {} });
  if (member.provider !== 'claude') return;
  // Reject foreign effort names even if the CLI cannot be queried.
  let error = modelSettingsError(member);
  if (!error && member.model) error = modelSettingsError(member, await modelCatalog('claude'));
  if (error) throw Object.assign(new Error(error), { statusCode: 400 });
}

export function closeModelCatalog() {
  for (const controller of active) controller.abort();
}
