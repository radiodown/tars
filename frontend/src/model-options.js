import { catalogModel, claudeEfforts, modelSettingsError } from '../../shared/model-settings.mjs';

export function reasoningOptions(provider, model, reasoning, catalog) {
  const selectedModel = catalogModel(catalog?.models, model);
  const supported = selectedModel?.reasoningEfforts;
  const efforts = Array.isArray(supported) ? supported.filter(value => value !== 'default')
    : provider === 'claude' ? claudeEfforts : ['low', 'medium', 'high'];
  const error = modelSettingsError({ provider, model, reasoning }, catalog);
  const extra = provider !== 'claude' && reasoning !== 'default' && !efforts.includes(reasoning) && !error;
  // Claude's CLI-managed default is a mode, not the lowest effort level.
  const levels = [...(provider === 'claude' ? [] : ['default']), ...efforts, ...(extra ? [reasoning] : [])];
  return { selectedModel, efforts, levels, error, unknown: !Array.isArray(supported) };
}

export function reasoningAfterModelChange(provider, model, reasoning, catalog) {
  return modelSettingsError({ provider, model, reasoning }, catalog) ? 'default' : reasoning;
}
