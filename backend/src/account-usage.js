import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { executable } from './providers.js';
import { codexConnection } from './codex-rpc.js';

const MIN_REFRESH_MS = 60_000;
const cache = new Map();
const active = new Set();
const validPercent = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_. -]{1,80}$/.test(value) ? value : null;

function planName(value) {
  const name = identifier(value)?.toLowerCase();
  const names = { free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', max: 'Max', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu', ultra: 'Ultra' };
  return name ? Object.hasOwn(names, name) ? names[name] : name : null;
}

function resetTime(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(typeof value === 'number' ? value * 1000 : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function codexWeekly(response) {
  const mapped = response?.rateLimitsByLimitId;
  const buckets = mapped && typeof mapped === 'object' && !Array.isArray(mapped) ? Object.entries(mapped) : [];
  const fallback = response?.rateLimits;
  if (fallback && !buckets.some(([key, bucket]) => key === (fallback.limitId || 'codex') || (fallback.limitId && bucket?.limitId === fallback.limitId))) {
    buckets.unshift([fallback.limitId || 'codex', fallback]);
  }
  return buckets.slice(0, 20).flatMap(([key, bucket]) => ['primary', 'secondary'].flatMap(window => {
    const value = bucket?.[window];
    // The secondary window is not necessarily weekly. Only a reported seven-day window qualifies.
    if (value?.windowDurationMins !== 7 * 24 * 60 || !validPercent(value.usedPercent)) return [];
    const id = identifier(bucket.limitId) || identifier(key) || 'codex';
    return [{ id: `${id}-${window}`, label: id === 'codex' ? '전체 모델' : identifier(bucket.limitName) || id,
      usedPercent: value.usedPercent, resetsAt: resetTime(value.resetsAt) }];
  }));
}


async function readCodex(signal, accountId = 'codex') {
  const binary = await executable(accountId);
  if (!binary) return { status: 'not_installed', message: `서버에서 ${accountId} 실행 명령을 설치하고 로그인하세요.` };
  const rpc = codexConnection(binary, signal);
  let plan = null;
  try {
    await rpc.call('initialize', { clientInfo: { name: 'tars_usage', title: 'Tars', version: '0.1.0' } });
    rpc.initialized();
    const result = await rpc.call('account/read', { refreshToken: false });
    const account = result?.account;
    if (!account) return { status: 'auth_required', message: `서버에서 ${accountId} 계정에 로그인한 뒤 다시 조회하세요.` };
    plan = planName(account.planType);
    if (!['chatgpt', 'chatgptAuthTokens'].includes(account.type)) {
      return { status: 'unsupported', plan: account.type === 'apiKey' ? 'API' : plan, message: '이 인증 방식은 ChatGPT 구독의 주간 한도를 제공하지 않습니다.' };
    }
    const response = await rpc.call('account/rateLimits/read');
    plan ||= planName(response?.rateLimits?.planType || response?.rateLimitsByLimitId?.codex?.planType);
    const weekly = codexWeekly(response);
    return { plan, weekly, status: weekly.length ? 'ready' : 'unavailable', message: weekly.length ? null : '계정에서 주간 한도를 제공하지 않았습니다.' };
  } catch {
    return { plan, status: 'error', message: `한도를 조회하지 못했습니다. ${accountId} 로그인 상태와 연결을 확인하세요.` };
  } finally { rpc.close(); }
}

async function claudeCredentials() {
  const directory = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const file = await open(join(directory, '.credentials.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 65536) throw new Error('Credentials unavailable');
    return JSON.parse(await file.readFile('utf8'))?.claudeAiOauth;
  } finally { await file.close(); }
}

async function responseJson(response) {
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 262144) throw new Error('Usage response too large');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel(); }
}

async function readClaude(signal) {
  let auth;
  try { auth = await claudeCredentials(); } catch { /* Missing or unreadable login. */ }
  // A separately supplied OAuth token may belong to another account; do not attach the file's plan to it.
  const suppliedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  let plan = suppliedToken ? null : planName(auth?.subscriptionType);
  if (plan === 'Max' && auth?.rateLimitTier === 'default_claude_max_5x') plan = 'Max 5x';
  if (plan === 'Max' && auth?.rateLimitTier === 'default_claude_max_20x') plan = 'Max 20x';
  const token = suppliedToken || auth?.accessToken;
  if (typeof token !== 'string' || !token.length || token.length > 16384) {
    return { plan, status: 'auth_required', message: '서버의 Claude Code 로그인 정보가 필요합니다. API 키만으로는 구독 한도를 조회할 수 없습니다.' };
  }
  try {
    // Claude Code's own usage endpoint, not a documented public API. Keep destination fixed;
    // do not follow redirects, refresh credentials, or return raw provider errors to the browser.
    const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
    });
    if (!response.ok) {
      const retry = response.headers.get('retry-after');
      const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : (Date.parse(retry) - Date.now()) / 1000;
      await response.body?.cancel();
      if (response.status === 429) return { plan, status: 'rate_limited', retryMs: Math.max(300_000, Number.isFinite(seconds) ? seconds * 1000 : 0), message: '조회 요청이 많아 잠시 쉬고 있습니다. 다음 조회 시간 이후 다시 확인하세요.' };
      if ([401, 403].includes(response.status)) return { plan, status: 'auth_required', message: 'Claude Code에서 로그인을 확인한 뒤 다시 조회하세요.' };
      return { plan, status: 'error', message: 'Claude 사용 한도를 조회하지 못했습니다. 잠시 후 다시 확인하세요.' };
    }
    const body = await responseJson(response);
    const window = body?.five_hour;
    const fiveHour = validPercent(window?.utilization)
      ? { id: 'five_hour', label: '전체 모델', usedPercent: window.utilization, resetsAt: resetTime(window.resets_at) }
      : null;
    const labels = { seven_day: '전체 모델', seven_day_sonnet: 'Sonnet', seven_day_opus: 'Opus', seven_day_oauth_apps: 'OAuth 앱', seven_day_cowork: 'Cowork' };
    const weekly = Object.entries(labels).flatMap(([id, label]) => {
      const value = body?.[id];
      return validPercent(value?.utilization) ? [{ id, label, usedPercent: value.utilization, resetsAt: resetTime(value.resets_at) }] : [];
    });
    const available = fiveHour !== null || weekly.length > 0;
    return { plan, fiveHour, weekly, status: available ? 'ready' : 'unavailable', message: available ? null : '계정에서 5시간·주간 한도를 제공하지 않았습니다.' };
  } catch {
    return { plan, status: 'error', message: 'Claude 사용 한도를 조회하지 못했습니다. 로그인 상태와 연결을 확인하세요.' };
  }
}

async function account(provider, read, accountId = provider) {
  let entry = cache.get(accountId);
  if (entry?.pending) return entry.pending;
  if (entry?.value && Date.now() < entry.nextRefreshAt) return entry.value;
  entry ||= {};
  cache.set(accountId, entry);
  const controller = new AbortController();
  active.add(controller);
  entry.pending = (async () => {
    let result;
    try { result = await read(controller.signal); }
    catch { result = { status: 'error', message: '계정 한도를 조회하지 못했습니다. 잠시 후 다시 확인하세요.' }; }
    const checkedAt = Date.now();
    entry.nextRefreshAt = checkedAt + Math.max(MIN_REFRESH_MS, result.retryMs || 0);
    // Allowlist only display data; authentication and raw CLI/API output never leave this module.
    entry.value = { provider, accountId, plan: result.plan || null, fiveHour: result.fiveHour || null, weekly: result.weekly || [], status: result.status,
      message: result.message || null, checkedAt: new Date(checkedAt).toISOString(), nextRefreshAt: new Date(entry.nextRefreshAt).toISOString() };
    return entry.value;
  })();
  try { return await entry.pending; }
  finally { entry.pending = null; active.delete(controller); }
}

export async function accountUsage() {
  return { accounts: await Promise.all([
    account('codex', readCodex),
    account('codex', signal => readCodex(signal, 'codex2'), 'codex2'),
    account('claude', readClaude),
  ]) };
}

export function closeAccountUsage() {
  for (const controller of active) controller.abort();
}
