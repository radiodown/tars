import { launchClaude } from './claude-agent.js';
import { readFile, readdir } from 'node:fs/promises';
import { codexAccountSchema } from './contracts.js';
import { executable } from './executables.js';
import { validateModelSettings } from './model-catalog.js';
export { executable } from './executables.js';

export async function providers() {
  return Promise.all(['codex', 'claude'].map(async name => {
    const accounts = await Promise.all((name === 'codex' ? ['codex', 'codex2'] : ['claude'])
      .map(async id => ({ id, installed: Boolean(await executable(id)), authentication: 'unchecked' })));
    return { name, installed: accounts.some(account => account.installed), authentication: 'unchecked', accounts };
  }));
}

export function providerCommand(member) {
  return member.provider === 'codex' ? codexAccountSchema.parse(member.codexAccount || 'codex') : member.provider;
}

export async function killOwned(session, signal = 'SIGTERM') {
  if (!session.pid || !session.processToken) return;
  // A group leader may have exited while its command is still alive.
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) !== session.pid || fields[0] === 'Z') continue;
      const environment = await readFile(`/proc/${pid}/environ`);
      if (!environment.toString().split('\0').includes(`TARS_SESSION_TOKEN=${session.processToken}`)) continue;
      process.kill(-session.pid, signal);
      return;
    } catch (error) { if (!['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) throw error; }
  }
}

export async function launch(options) {
  const { session, member, codexServers } = options;
  const command = providerCommand(session);
  const binary = await executable(command);
  if (!binary) throw new Error(`${command} CLI를 찾을 수 없습니다. 선택한 계정의 실행 명령과 PATH 설정을 확인하세요.`);
  if (session.provider === 'codex') return codexServers.launch({ ...options, binary });
  await validateModelSettings(member);
  return launchClaude({ ...options, binary });
}
