import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, delimiter } from 'node:path';
import { executable } from './executables.js';

export async function sandboxEnvironment() {
  const paths = await Promise.all(['bwrap', 'socat'].map(name => executable(name)));
  return { ...process.env, PATH: [...new Set([...paths.filter(Boolean).map(dirname), ...(process.env.PATH || '').split(delimiter)])].join(delimiter) };
}
async function canonical(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT' || dirname(path) === path) throw error;
    return resolve(await canonical(dirname(path)), relative(dirname(path), path));
  }
}
export async function guardFileWrite(input, session, cwd) {
  if (!['Write', 'Edit', 'NotebookEdit'].includes(input.tool_name)) return {};
  const deny = reason => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
  if (session.accessProfile !== 'workspace-write' && session.kind !== 'work') return deny('이 세션은 읽기 전용입니다.');
  const path = input.tool_input?.file_path || input.tool_input?.notebook_path;
  if (!path) return deny('수정할 파일 경로를 확인할 수 없습니다.');
  try {
    const target = await canonical(resolve(cwd, path));
    const roots = await Promise.all([cwd, ...(session.extraWritableRoots || [])].map(canonical));
    if (!roots.some(root => { const tail = relative(root, target); return tail && tail !== '..' && !tail.startsWith('../') && !isAbsolute(tail); })) return deny('승인된 작업 폴더 밖의 파일은 수정할 수 없습니다.');
    return {};
  } catch { return deny('실제 파일 경로를 확인할 수 없어 수정을 거절했습니다.'); }
}

export function readOnlyCommand(input, session) {
  if (input.tool_name !== 'Bash' || session.accessProfile === 'workspace-write' || session.kind === 'work') return {};
  if (typeof input.tool_input?.command !== 'string') return {};
  // Claude appends a cwd-tracking write after successful Bash commands. End the
  // read-only shell with the command's own status before that bookkeeping write.
  // Each command starts in the session cwd; cd remains local to that command.
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: {
    ...input.tool_input, command: `${input.tool_input.command}\nbuiltin exit $?`,
  } } };
}
