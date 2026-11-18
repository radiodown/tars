import { fileURLToPath } from 'node:url';
import { backendPort } from '../../network.config.mjs';

// Apply only to processes launched by TARS, never to the user's CLI config files.
export const ACCESS_VERSION = 'role-access-v2';
export const CODEX_THREAD_ACCESS = { approvalPolicy: 'never', sandbox: 'read-only' };
export const CODEX_TURN_ACCESS = { approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' } };
export const TARS_TOOL_NAMES = ['tars_get_state', 'tars_get_team_activity', 'tars_register_work', 'tars_create_department', 'tars_create_member', 'tars_api', 'tars_log_progress', 'tars_ask', 'tars_block'];
export const accessProfile = session => session.accessProfile || (session.kind === 'work' ? 'workspace-write' : 'read-only');
export function codexThreadAccess(session) { return { approvalPolicy: session.permissionMode === 'review' ? 'untrusted' : 'never', sandbox: accessProfile(session) }; }
export function codexTurnAccess(session, cwd) {
  return { approvalPolicy: session.permissionMode === 'review' ? 'untrusted' : 'never', sandboxPolicy: accessProfile(session) === 'workspace-write'
    ? { type: 'workspaceWrite', writableRoots: [cwd, ...(session.extraWritableRoots || [])], networkAccess: true, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
    : { type: 'readOnly' } };
}
export function profileKind(kind) {
  return ['ceo_chat', 'member_chat'].includes(kind) ? 'chat' : kind === 'work' ? 'work'
    : kind === 'task_review' ? 'review' : ['request_report', 'request_escalation', 'review', 'oversight'].includes(kind) ? 'report' : 'plan';
}
export function sessionModel(member, kind) { return { model: member.model, reasoning: member.reasoning, ...member.sessionProfiles?.[profileKind(kind)] }; }
export const agentApiBase = () => process.env.TARS_AGENT_API_BASE || `http://127.0.0.1:${backendPort}`;
export function agentMcpConfig(executionToken) {
  return { command: process.execPath, args: [fileURLToPath(new URL('./agent-mcp.js', import.meta.url))],
    env: { TARS_AGENT_API_BASE: agentApiBase(), ...(executionToken ? { TARS_EXECUTION_TOKEN: executionToken } : {}) } };
}
export function codexAccessConfig(executionToken) {
  const mcp = agentMcpConfig(executionToken);
  return {
    approval_policy: 'never', sandbox_mode: 'read-only',
    'mcp_servers.tars.command': mcp.command, 'mcp_servers.tars.args': mcp.args,
    'mcp_servers.tars.env.TARS_AGENT_API_BASE': mcp.env.TARS_AGENT_API_BASE,
    ...(executionToken ? { 'mcp_servers.tars.env.TARS_EXECUTION_TOKEN': executionToken } : {}),
    'mcp_servers.tars.enabled': true, 'mcp_servers.tars.required': true,
    ...Object.fromEntries(TARS_TOOL_NAMES.map(name => [`mcp_servers.tars.tools.${name}.approval_mode`, 'approve'])),
  };
}
export function claudeAccessArgs(executionToken, session = {}, cwd = '.') {
  const writable = accessProfile(session) === 'workspace-write';
  return ['--permission-mode', 'dontAsk', '--tools', writable ? 'Read,Glob,Grep,Bash,Edit,Write' : 'Read,Glob,Grep,Bash',
    '--allowedTools', 'Read', 'Glob', 'Grep', 'Bash', ...(writable ? ['Edit', 'Write'] : []), 'mcp__tars__*',
    '--strict-mcp-config', '--settings', JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false, filesystem: { allowWrite: writable ? [cwd, ...(session.extraWritableRoots || [])] : [], denyWrite: writable ? [] : ['/**'] } },
      permissions: { deny: writable ? [] : ['Edit', 'Write', 'NotebookEdit'] } }),
    '--mcp-config', JSON.stringify({ mcpServers: { tars: agentMcpConfig(executionToken) } })];
}
export function permissionResponse(method) {
  if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) return { decision: 'decline' };
  if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
  return null;
}

export const PREVIOUS_DEFAULT_INSTRUCTIONS = `사용자의 요청 범위와 프로젝트 지침을 우선합니다.

- CEO·팀장·팀원 모두 파일 읽기·쓰기, 명령 실행, 네트워크와 사용 가능한 도구를 동일한 최대 권한으로 사용합니다.
- 요청을 완료하는 데 필요한 조직 등록·수정, 작업 생성·배정·실행, 구현과 검증을 직접 수행합니다. 사용자가 승인한 작업은 추가 승인을 반복해서 요구하지 않습니다.
- 필요한 자료만 읽고 기존 작업을 보존합니다. 사용자가 명시한 중지·검토·승인 조건은 지킵니다.
- 확인하지 않은 결과는 미검증으로 표시하고, 실제 API 응답과 저장 상태를 확인한 뒤 완료를 보고합니다.
- 토큰 사용량을 추측하거나 만들어내지 않습니다.`;
export const PREVIOUS_WORK_INSTRUCTIONS = `사용자의 요청 범위와 프로젝트 지침을 우선합니다.

- 사용자는 CEO 또는 팀장과 대화로 업무를 지시합니다. 사용자에게 프로젝트나 작업 항목을 먼저 만들라고 요구하지 마세요.
- 관리 AI는 받은 요청을 기준으로 요구사항과 설계를 기록하고, 필요한 하위 작업을 직접 생성·배정·실행하며 결과를 검토하고 보고합니다. 설계 검토나 실행이 실제로 일어나지 않았다면 해당 단계를 완료로 표현하지 마세요.
- CEO·팀장·팀원 모두 파일 읽기·쓰기, 명령 실행, 네트워크와 사용 가능한 도구를 동일한 최대 권한으로 사용합니다.
- 필요한 자료만 읽고 기존 작업을 보존합니다. 사용자가 명시한 중지·검토·승인 조건은 지킵니다.
- 확인하지 않은 결과는 미검증으로 표시하고, 실제 API 응답과 저장 상태를 확인한 뒤 완료를 보고합니다.
- 토큰 사용량을 추측하거나 만들어내지 않습니다.`;
export const PREVIOUS_REGISTRATION_INSTRUCTIONS = PREVIOUS_WORK_INSTRUCTIONS.replace(
  '- 관리 AI는 받은 요청을 기준으로',
  '- 대화 자체는 업무가 아닙니다. 질문·현황 조회에는 업무를 만들지 않습니다. 목표와 범위가 정해지면 CEO·팀장이 tars_register_work로 등록하고 그 업무 ID에 설계·하위 작업·결과·검토·보고를 연결합니다. 후속 협의는 기존 requestId를 사용합니다.\n- 관리 AI는 등록한 업무를 기준으로');
export const PREVIOUS_APPROVAL_INSTRUCTIONS = `${PREVIOUS_REGISTRATION_INSTRUCTIONS}\n- 팀장·CEO는 협의안과 작업 범위를 먼저 제출하고 사용자 승인을 기다립니다. 승인 전에는 작업을 실행하거나 소스를 수정하지 않습니다. 문서·작업 범위가 바뀌면 새 승인을 받습니다.\n- 사용자의 승인·의견은 업무 흐름에서 해당 버전에 기록되며 원래 AI의 후속 실행으로 전달됩니다. 작업 결과 보고 후에도 사용자 확인 대기와 최종 완료를 구분합니다.`;
export const LEGACY_DEFAULT_INSTRUCTIONS = '사용자의 요청 범위와 프로젝트 지침을 우선합니다.\n\n- 필요한 자료만 읽고 작업 결과와 차단 사항을 짧게 보고합니다.\n- 확인하지 않은 결과는 미검증으로 표시합니다.\n- 명시적으로 요청하지 않은 테스트, 빌드, 컴파일, 실행 검증은 수행하지 않습니다.\n- 기존 작업을 보존하고 커밋, 푸시, 배포는 별도 지시가 있을 때만 수행합니다.\n- 팀장은 설계와 위임에 집중하고 팀원은 배정된 범위만 수행합니다.\n- 토큰 사용량을 추측하거나 만들어내지 않습니다.';

export const agentAccessInstructions = `관리자 대화·협의와 검토·보고는 읽기 전용입니다. 팀원 작업 및 사용자가 승인한 관리자 직접 구현만 작업 폴더에 쓸 수 있습니다. 권한을 우회하지 마세요. 업무 등록에는 tars_register_work, 문서·TASK 초안에는 tars_api를 사용하세요. instruction에 목표·범위를, acceptance에 업무 완료 기준을 기록합니다. 범위 변경은 PATCH /api/requests/<id>로 갱신하고 재승인을 받습니다. 승인된 범위 안에서 TASK를 세분화하고 배정하세요. TASK 목록까지 승인하는 업무는 목록 변경에도 재승인이 필요합니다. 대화에는 JSON 양식을 강제하지 않습니다. 필요한 관리 도구를 호출한 뒤 사용자에게 자연스럽게 답하세요. 질문·인사·현황 조회는 업무로 등록하지 마세요. tars_get_state는 요약 목록, collection/id는 개별 상세입니다. 저장 응답을 확인하고 불필요한 재조회를 하지 마세요. 팀원은 tars_log_progress, tars_ask, tars_block을 사용할 수 있고 최종 구조화 결과를 제출합니다. 검토·보고는 읽기와 최종 응답만 사용합니다. 실행 신원은 MCP 환경변수로 전달되며 모델이 토큰을 복사하지 않습니다.`;

export const DEFAULT_INSTRUCTIONS = `사용자의 요청 범위와 프로젝트 지침을 우선합니다.
- 관리자는 협의·설계·배정·검토·보고를 담당하고 기본적으로 파일을 수정하지 않습니다. 팀원은 승인된 작업 디렉토리 안에서 구현합니다.
- 목표·범위(instruction)와 완료 기준(acceptance)을 업무에 명시해 사용자 승인을 받습니다. 승인 범위 안의 TASK 작성·배정·의존 관계 조정은 자동 진행합니다. TASK 목록 승인 옵션이 켜진 업무는 목록 변경도 다시 승인받습니다.
- 관리자 직접 구현은 사용자가 업무 설정에서 허용하고 해당 범위를 승인한 경우에만 가능합니다.
- 팀원은 tars_log_progress로 진행 기록을 남기고, 질문은 tars_ask로 답을 기다리며, 외부 장애는 tars_block으로 기록합니다.
- 저장은 관리 API로 수행합니다. SQLite와 생성된 지침 파일을 직접 수정하지 않습니다. 미검증 결과를 완료로 보고하지 않습니다.`;
