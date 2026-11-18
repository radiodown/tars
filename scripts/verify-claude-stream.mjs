// Opt-in live check: additional input + structured output in one Claude SDK run.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const directory = await mkdtemp(join(tmpdir(), 'tars-claude-stream-'));
process.env.TARS_DATA_DIR = directory;
process.env.TARS_AGENT_API_BASE = 'http://127.0.0.1:1'; // No access to operational TARS APIs.
const { launchClaude } = await import('../backend/src/claude-agent.js');
const { executable } = await import('../backend/src/executables.js');
const session = { id: randomUUID(), provider: 'claude', kind: 'work', accessProfile: 'workspace-write', processToken: randomUUID() };
let handle, queued = false, toolsReady = false;
const result = { directory, passed: false };
try {
  handle = await launchClaude({ binary: await executable('claude'), session, member: { name: '입력 스트림 검증', model: '', reasoning: 'default' }, cwd: directory, minutes: 2,
    prompt: '격리된 실행기 검증입니다. TARS 도구나 파일 수정은 하지 마세요. Bash로 sleep 3 명령을 딱 한 번 실행한 뒤, 구조화 결과 summary를 FIRST_RESULT로 제출하세요. workPerformed, artifacts, verification, remaining, followUp 배열은 빈 배열로 제출하세요. 이후 사용자 메시지를 받으면 도구 호출 없이 summary를 그 메시지에 적힌 정확한 문자열로 바꾸어 동일 형식의 구조화 결과를 제출하세요.',
    onIdentity: value => { toolsReady ||= Boolean(value.toolsReady); },
    onEvent: (message) => { if (!queued && message.includes('Bash') && handle) { queued = true; void handle.steer('최종 summary에는 STREAM_STRUCTURED_OK만 적으세요. 다른 모든 배열은 비워두세요.'); } },
  });
  const output = await handle.promise;
  if (output.failure) throw new Error(output.failure);
  if (!queued || !toolsReady || output.structured?.summary !== 'STREAM_STRUCTURED_OK') throw new Error('Queued input was not reflected in structured result');
  result.passed = true; result.sessionId = session.id; result.providerSessionId = output.providerSessionId; result.structured = output.structured;
} catch (error) { result.error = error.message; process.exitCode = 1; }
await writeFile(join(directory, 'verification.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
console.log(JSON.stringify(result));
