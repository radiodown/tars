const approvals = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval']);
export function codexInteraction(method, params, item) {
  if (['item/tool/requestUserInput', 'tool/requestUserInput'].includes(method)) return {
    kind: 'question', title: 'Codex 질문', questions: params.questions || [], decisions: ['accept', 'cancel'],
  };
  if (method === 'mcpServer/elicitation/request') return {
    kind: 'elicitation', title: `${params.serverName || 'MCP'} 입력 요청`, message: params.message,
    schema: params.requestedSchema, url: params.url, decisions: ['accept', 'decline', 'cancel'],
  };
  if (!approvals.has(method)) return null;
  const decisions = params.availableDecisions?.filter(value => typeof value === 'string')
    || (params.kind === 'humanCommand' ? ['accept', 'decline', 'cancel'] : ['accept', 'acceptForSession', 'decline', 'cancel']);
  return { kind: 'approval', title: method.includes('fileChange') ? '파일 수정 승인' : method.includes('permissions') ? '추가 권한 승인' : '명령 실행 승인',
    message: params.reason, command: params.command, cwd: params.cwd, changes: item?.changes,
    permissions: params.permissions || params.additionalPermissions, decisions };
}

export function codexResponse(method, params, response) {
  if (method.includes('requestUserInput')) return { answers: Object.fromEntries(Object.entries(response.answers || {}).map(([key, answers]) => [key, { answers }])) };
  if (method === 'mcpServer/elicitation/request') return { action: response.decision, content: response.decision === 'accept' ? response.content || null : null };
  if (method === 'item/permissions/requestApproval') return { permissions: response.decision.startsWith('accept') ? params.permissions || {} : {}, scope: response.decision === 'acceptForSession' ? 'session' : 'turn' };
  return { decision: response.decision };
}

const sessionUpdates = suggestions => (suggestions || []).filter(update => update.type === 'addRules' && update.behavior === 'allow' && update.rules?.length)
  .map(update => ({ ...update, destination: 'session' }));

export function claudeInteraction(toolName, input, suggestions = []) {
  if (toolName === 'AskUserQuestion') return { kind: 'question', title: 'Claude 질문', decisions: ['accept', 'decline', 'cancel'],
    questions: (input.questions || []).map((question, index) => ({ ...question, id: String(index) })) };
  return { kind: 'approval', title: `${toolName} 실행 승인`, command: input.command, message: input.description,
    details: input, permissions: sessionUpdates(suggestions), decisions: ['accept', ...(sessionUpdates(suggestions).length ? ['acceptForSession'] : []), 'decline', 'cancel'] };
}

export function claudeResponse(toolName, input, response, suggestions = []) {
  if (!['accept', 'acceptForSession'].includes(response.decision)) return { behavior: 'deny', message: '사용자가 실행을 거절했습니다.', interrupt: response.decision === 'cancel' };
  if (toolName === 'AskUserQuestion') return { behavior: 'allow', updatedInput: { ...input,
    answers: Object.fromEntries((input.questions || []).map((question, index) => [question.question, response.answers[String(index)].join(', ')])) } };
  return { behavior: 'allow', updatedInput: input, ...(response.decision === 'acceptForSession' ? { updatedPermissions: sessionUpdates(suggestions) } : {}) };
}
