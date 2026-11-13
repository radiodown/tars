import { fileURLToPath } from 'node:url';
import { backendPort } from '../../network.config.mjs';

// Apply only to processes launched by TARS, never to the user's CLI config files.
export const ACCESS_VERSION = 'full-access-v1';
export const CODEX_THREAD_ACCESS = { approvalPolicy: 'never', sandbox: 'danger-full-access' };
export const CODEX_TURN_ACCESS = { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } };
export const TARS_TOOL_NAMES = ['tars_get_state', 'tars_register_work', 'tars_create_department', 'tars_create_member', 'tars_api'];
export const agentApiBase = () => process.env.TARS_AGENT_API_BASE || `http://127.0.0.1:${backendPort}`;
export function agentMcpConfig() {
  return { command: process.execPath, args: [fileURLToPath(new URL('./agent-mcp.js', import.meta.url))],
    env: { TARS_AGENT_API_BASE: agentApiBase() } };
}
export function codexAccessConfig() {
  const mcp = agentMcpConfig();
  return {
    approval_policy: 'never', sandbox_mode: 'danger-full-access',
    'mcp_servers.tars.command': mcp.command, 'mcp_servers.tars.args': mcp.args,
    'mcp_servers.tars.env.TARS_AGENT_API_BASE': mcp.env.TARS_AGENT_API_BASE,
    'mcp_servers.tars.enabled': true, 'mcp_servers.tars.required': true,
    ...Object.fromEntries(TARS_TOOL_NAMES.map(name => [`mcp_servers.tars.tools.${name}.approval_mode`, 'approve'])),
  };
}
export function claudeAccessArgs() {
  return ['--permission-mode', 'bypassPermissions', '--tools', 'default',
    '--settings', JSON.stringify({ sandbox: { enabled: false } }),
    '--mcp-config', JSON.stringify({ mcpServers: { tars: agentMcpConfig() } })];
}
export function permissionResponse(method, params) {
  if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) {
    return { decision: 'acceptForSession' };
  }
  if (method === 'item/permissions/requestApproval') return { permissions: params.permissions || {}, scope: 'session' };
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
export const DEFAULT_INSTRUCTIONS = `${PREVIOUS_REGISTRATION_INSTRUCTIONS}\n- 팀장·CEO는 협의안과 작업 범위를 먼저 제출하고 사용자 승인을 기다립니다. 승인 전에는 작업을 실행하거나 소스를 수정하지 않습니다. 문서·작업 범위가 바뀌면 새 승인을 받습니다.\n- 사용자의 승인·의견은 업무 흐름에서 해당 버전에 기록되며 원래 AI의 후속 실행으로 전달됩니다. 작업 결과 보고 후에도 사용자 확인 대기와 최종 완료를 구분합니다.`;
export const LEGACY_DEFAULT_INSTRUCTIONS = '사용자의 요청 범위와 프로젝트 지침을 우선합니다.\n\n- 필요한 자료만 읽고 작업 결과와 차단 사항을 짧게 보고합니다.\n- 확인하지 않은 결과는 미검증으로 표시합니다.\n- 명시적으로 요청하지 않은 테스트, 빌드, 컴파일, 실행 검증은 수행하지 않습니다.\n- 기존 작업을 보존하고 커밋, 푸시, 배포는 별도 지시가 있을 때만 수행합니다.\n- 팀장은 설계와 위임에 집중하고 팀원은 배정된 범위만 수행합니다.\n- 토큰 사용량을 추측하거나 만들어내지 않습니다.';

export const agentAccessInstructions = `모든 TARS 에이전트는 같은 최대 실행 권한을 사용합니다. 역할과 세션 종류는 읽기·쓰기·명령 실행·네트워크·도구 사용을 제한하지 않습니다. 요청 범위에 필요한 구현, 검증, 조직 변경과 작업 실행을 수행하세요. 제공 도구의 하위 에이전트도 사용할 수 있습니다. 사용자가 이미 승인한 실행에 같은 승인을 다시 요구하지 마세요. 사용자가 명시한 계획만·수정 금지·승인 후 실행 조건은 그대로 지킵니다. 사용자는 대화로 업무를 지시합니다. 대화마다 업무를 생성하지 마세요. 목표와 범위가 정해지면 CEO·팀장이 tars_register_work로 등록하고, 기존 업무의 후속 협의는 requestId로 연결하세요. 질문과 현황 조회는 대화로 답하세요. CEO·팀장은 사용자에게 작업 등록을 요구하지 말고 요청과 설계 문서, 하위 작업, 검토 결과를 연결하세요. 아직 검토하지 않은 설계나 결과를 완료로 보고하지 마세요. 협의안은 목적·범위·합의·제약·미결·완료 기준을 포함해 작성하고 관리 API로 저장하세요. 최초 협의안과 범위 변경은 사용자 승인이 필요합니다. 승인 전에는 협의·설계·작업 초안 작성만 하고 구현·작업 실행을 시작하지 마세요. 업무 흐름의 승인·의견 응답으로 후속 실행이 예약되므로 기다리는 동안 반복 호출하지 마세요. 결과 보고 후 사용자 확인까지 기다리세요.

TARS 조직·업무 관리 도구: tars_get_state로 최신 조직과 작업을 확인하고, tars_create_department로 부서를, tars_create_member로 팀장·팀원을 실제 등록합니다. 기존 부서와 팀장을 확인해 중복 등록하지 마세요. 계정·모델 ID·추론 깊이는 사용자 설정을 그대로 사용합니다. tars_api로 기존 관리 API를 호출해 프로필·문서·작업을 수정하고 작업을 실행할 수 있습니다. SQLite나 생성된 지침 파일을 직접 편집하지 말고 관리 API를 사용해 검증·문서 버전·상태 갱신을 유지하세요. API 오류를 완료로 보고하지 말고 원인을 알려주세요. 변경 후 tars_get_state로 저장된 결과를 확인하세요.`;
