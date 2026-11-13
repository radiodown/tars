// Claude Code's effort vocabulary is distinct from Codex's model-advertised values.
export const claudeEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];

export function catalogModel(models = [], model = '') {
  // An empty model means no --model flag, not Claude's "default" account alias.
  if (!model) return null;
  return models.find(item => item.id === model)
    || models.find(item => item.resolvedModel === model) || null;
}

export function modelSettingsError(member, catalog) {
  const reasoning = member.reasoning || 'default';
  if (member.provider === 'claude' && reasoning !== 'default' && !claudeEfforts.includes(reasoning)) {
    return `Claude는 ${reasoning} 추론을 지원하지 않습니다. CLI 기본 설정 또는 지원하는 단계를 선택하세요.`;
  }
  const model = catalogModel(catalog?.models, member.model);
  if (model?.disabled) return '선택한 모델은 현재 CLI 또는 계정에서 사용할 수 없습니다.';
  if (reasoning !== 'default' && Array.isArray(model?.reasoningEfforts) && !model.reasoningEfforts.includes(reasoning)) {
    return `${model.label}에서 ${reasoning} 추론을 지원하지 않습니다. CLI 기본 설정 또는 지원하는 단계를 선택하세요.`;
  }
  return null;
}
