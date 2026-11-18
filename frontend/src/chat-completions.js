const commands = [
  { name: '/clear', description: '이전 세션을 보존하고 새 세션 시작', action: 'clear' },
  { name: '/new', description: '새 세션 시작 · /clear와 같은 동작', action: 'clear' },
  { name: '/stop', description: '현재 응답 중지', action: 'stop' },
  { name: '/model', description: 'AI의 모델과 추론 깊이 설정', action: 'settings' },
  { name: '/reasoning', description: 'AI의 추론 깊이 설정', action: 'settings' },
  { name: '/status', description: '최근 실행 상태와 기록 보기', action: 'status' },
  { name: '/skills', description: '사용할 스킬 찾아서 입력', action: 'skills', provider: 'codex' },
  { name: '/help', description: '명령어와 입력 단축키 보기', action: 'help' },
];

export function chatCommands({ provider = 'codex', current, latest, locked = false, terminal = false } = {}) {
  return commands.filter(item => (!item.provider || item.provider === provider) && (!terminal || !['clear', 'settings', 'status', 'help', 'skills'].includes(item.action)))
    .map(item => ({ ...item, disabledReason: item.action === 'clear' && (current || locked) ? '진행 중인 응답이나 작업을 마친 뒤 사용할 수 있습니다.'
      : item.action === 'stop' && (!current || current.status === 'stopping') ? '중지할 응답이 없습니다.'
        : item.action === 'settings' && locked ? '작업이 끝난 뒤 설정을 변경할 수 있습니다.'
          : item.action === 'status' && !latest ? '아직 실행 기록이 없습니다.' : '' }));
}

export function completionContext(value, start, end = start) {
  if (start !== end || start == null) return null;
  const before = value.slice(0, start);
  const command = /^(\s*)\/([a-z-]*)$/i.exec(before);
  if (command) return { kind: 'command', query: command[2], start: command[1].length,
    end: start + (/^[a-z-]*/i.exec(value.slice(start))?.[0].length || 0) };
  // Don't complete shell variables, escaped dollars, or code examples.
  const prose = before.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g, ' ');
  if (/```|~~~|`/.test(prose)) return null;
  const skill = /(?:^|[\s(])\$([\p{L}\p{N}_:-]*)$/u.exec(before);
  if (!skill) return null;
  return { kind: 'skill', query: skill[1], start: start - skill[1].length - 1,
    end: start + (/^[\p{L}\p{N}_:-]*/u.exec(value.slice(start))?.[0].length || 0) };
}

export function completionItems(context, commands, skills = []) {
  if (!context) return [];
  const source = context.kind === 'command' ? commands : skills.map(skill => ({ ...skill, name: `$${skill.name}`, action: 'skill' }));
  const query = context.query.toLocaleLowerCase();
  return source.filter(item => context.kind === 'command' ? item.name.slice(1).toLocaleLowerCase().startsWith(query)
    : [item.name.slice(1), item.label, item.description].some(value => value?.toLocaleLowerCase().includes(query)))
    .sort((a, b) => Number(!a.name.slice(1).toLocaleLowerCase().startsWith(query)) - Number(!b.name.slice(1).toLocaleLowerCase().startsWith(query)));
}

export function insertCompletion(value, context, name, maxLength = 16000) {
  const suffix = value.slice(context.end);
  const separator = /^\s/.test(suffix) ? '' : ' ';
  const text = value.slice(0, context.start) + name + separator + suffix;
  return text.length > maxLength ? null : { text, caret: context.start + name.length + separator.length };
}
