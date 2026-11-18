import { useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronRight, Code2, RotateCcw, Search, Zap } from 'lucide-react';
import { api } from './api';
import { Field } from './ui';
import { useWorkspace } from './App';
import { reasoningOptions, reasoningAfterModelChange } from './model-options';

const effortLabels = { default: 'Default', none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max', ultra: 'Ultra' };
const effortDepths = { default: 0, none: 0, minimal: .05, low: .15, medium: .35, high: .55, xhigh: .72, max: .88, ultra: 1 };
const stars = [
  [12, 34, 4], [37, 68, 3], [65, 28, 5], [83, 62, 3],
  [26, 24, 3], [53, 54, 4], [73, 77, 3], [92, 25, 4],
  [19, 76, 3], [46, 19, 3], [60, 82, 3], [78, 40, 4],
];

export function ModelFields({ initial = {} }) {
  const { data } = useWorkspace();
  const [profiles, setProfiles] = useState(initial.sessionProfiles || {});
  const [provider, setProvider] = useState(initial.provider || 'codex');
  const [codexAccount, setCodexAccount] = useState(initial.codexAccount || 'codex');
  const [model, setModel] = useState(initial.model || '');
  const [custom, setCustom] = useState(false);
  const [reasoning, setReasoning] = useState(initial.reasoning || 'default');
  const [menuOpen, setMenuOpen] = useState(false);
  const [search, setSearch] = useState('');
  const controlId = useId();
  const picker = useRef(null);
  const trigger = useRef(null);
  const searchInput = useRef(null);
  const customInput = useRef(null);
  useEffect(() => {
    if (!menuOpen) return;
    searchInput.current?.focus();
    const dismiss = event => {
      if (!picker.current?.contains(event.target)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [menuOpen]);
  useEffect(() => { if (custom) customInput.current?.focus(); }, [custom]);
  const account = provider === 'codex' ? codexAccount : null;
  const accounts = data.providers.find(item => item.name === 'codex')?.accounts || [];
  const catalog = useQuery({
    queryKey: ['model-catalog', provider, account], queryFn: ({ signal }) => api(`/models/${provider}${account ? `?account=${encodeURIComponent(account)}` : ''}`, 'GET', undefined, { signal }),
    staleTime: 60_000, retry: false, refetchOnWindowFocus: false,
  });
  const models = catalog.data?.models || [];
  const { selectedModel, efforts, levels, error: settingError, unknown } = reasoningOptions(provider, model, reasoning, catalog.data);
  const unsupported = Boolean(settingError);
  const automatic = provider === 'claude' && reasoning === 'default';
  const index = Math.max(0, levels.indexOf(reasoning));
  const progress = levels.length > 1 ? index / (levels.length - 1) : 0;
  const depth = unsupported ? 0 : effortDepths[reasoning] ?? progress;
  const starCount = Math.round(Math.max(0, (depth - .4) / .6) * stars.length);
  const quickEffort = efforts[0] || 'default';
  const effortLabel = automatic ? 'CLI 설정 사용' : effortLabels[reasoning] || reasoning;
  const modelLabel = selectedModel?.label || model || (custom ? '모델 ID 직접 입력' : 'CLI 기본 모델');
  const choices = [
    { id: '', label: 'CLI 기본 모델' },
    ...(model && !models.some(item => item.id === model) ? [{ id: model, label: model }] : []),
    ...models,
  ].filter(item => `${item.label} ${item.id}`.toLowerCase().includes(search.trim().toLowerCase()));
  const message = catalog.isPending ? '모델 목록을 불러오는 중…'
    : catalog.error?.status === 404 ? '실행 중인 백엔드에 모델 목록 기능이 아직 반영되지 않았습니다. run에서 백엔드를 재시작한 뒤 목록을 다시 조회하세요.'
    : catalog.isError ? '목록을 불러오지 못했습니다. 기본 모델 또는 직접 입력을 사용할 수 있습니다.' : catalog.data?.message;
  function changeProvider(value) {
    setProvider(value);
    setModel('');
    setCustom(false);
    setMenuOpen(false);
    setSearch('');
    setReasoning('default');
  }
  function chooseModel(value) {
    if (models.find(item => item.id === value)?.disabled) return;
    setModel(value);
    setReasoning(reasoningAfterModelChange(provider, value, reasoning, catalog.data));
    setCustom(false);
    setMenuOpen(false);
    trigger.current?.focus();
  }
  function navigateModels(event) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...event.currentTarget.querySelectorAll('[data-model-choice]:not(:disabled)')];
    if (!buttons.length) return;
    const current = buttons.indexOf(event.target);
    if (current < 0 && ['Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : current < 0 ? event.key === 'ArrowDown' ? 0 : buttons.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  }
  return <div className="model-fields">
    <Field label="AI 도구"><select name="provider" value={provider} onChange={event => changeProvider(event.target.value)}><option value="codex">Codex</option><option value="claude">Claude</option></select></Field>
    {provider === 'codex' && <Field label="Codex 실행 계정" hint="선택한 로컬 명령의 로그인 계정으로 실행합니다. 모델 목록도 이 계정 기준으로 조회합니다."><select name="codexAccount" value={codexAccount} onChange={event => { setCodexAccount(event.target.value); setMenuOpen(false); setSearch(''); }}>{['codex', 'codex2'].map(id => <option key={id} value={id}>{id}{id === 'codex' ? ' · 기본 계정' : ' · 두 번째 계정'}{accounts.find(item => item.id === id)?.installed === false ? ' · 실행 명령 없음' : ''}</option>)}</select></Field>}
    <div className="model-control-label" id={`${controlId}-label`}>모델 · 추론 깊이</div>
    <div className={`model-picker ${unsupported ? 'has-error' : ''}`} style={{ '--effort-hue': 214 + depth * 54 }} ref={picker} role="group" aria-labelledby={`${controlId}-label`} onKeyDown={event => {
      if (event.key === 'Escape' && menuOpen) {
        event.preventDefault();
        event.stopPropagation();
        setMenuOpen(false);
        trigger.current?.focus();
      }
    }}>
      <div className="model-power-control">
        <div className="model-power-heading">
          <button type="button" className={`model-power-quick ${reasoning === quickEffort ? 'active' : ''}`} disabled={!efforts.length} aria-label={`빠른 추론으로 전환: ${effortLabels[quickEffort] || quickEffort}`} title={`빠른 추론 · ${effortLabels[quickEffort] || quickEffort}`} onClick={() => setReasoning(quickEffort)}><Zap size={15} aria-hidden="true" /></button>
          <div className="model-power-current"><strong>{effortLabel}</strong><button ref={trigger} type="button" className="model-picker-trigger" title={modelLabel} aria-label={`모델 선택: ${modelLabel}`} aria-expanded={menuOpen} aria-controls={`${controlId}-menu`} onClick={() => { setSearch(''); setMenuOpen(value => !value); }}><span>{modelLabel}</span><ChevronRight size={12} /></button></div>
          <button type="button" className="model-power-reset" aria-label="추론 깊이를 기본 설정으로 되돌리기" title="CLI 설정 사용" disabled={reasoning === 'default'} onClick={() => setReasoning('default')}><RotateCcw size={15} /></button>
        </div>
        {automatic ? <div className="model-effort-auto"><span>{efforts.length ? '깊이를 지정하지 않고 CLI 설정을 따릅니다.' : '이 모델은 추론 단계 설정을 지원하지 않습니다.'}</span>{efforts.length > 0 && <button type="button" className="text-button" onClick={() => setReasoning(efforts.includes('high') ? 'high' : efforts[0])}>직접 선택</button>}</div>
          : <div className="model-effort-range" style={{ '--effort-position': progress }}>
          <div className="model-effort-track" aria-hidden="true"><span className="model-effort-fill"><span className="model-effort-stars">{stars.map(([x, y, size], star) => <i key={star} style={{ left: `${x}%`, top: `${y}%`, width: size, height: size, opacity: star < starCount ? .8 : 0 }} />)}</span></span></div>
          <div className="model-effort-ticks" aria-hidden="true">{levels.map((value, position) => <i key={value} className={position <= index ? 'filled' : ''} />)}</div>
          <input className="model-effort-slider" type="range" min={0} max={Math.max(1, levels.length - 1)} step={1} value={index} disabled={levels.length <= 1 && !unsupported}
            aria-label="추론 깊이" aria-valuetext={`${effortLabel}${unsupported ? ' · 이 모델에서 미지원' : ''}`} aria-describedby={`${controlId}-hint`} aria-invalid={unsupported || undefined}
            ref={element => { element?.setCustomValidity(settingError || ''); }}
            onChange={event => setReasoning(levels[Number(event.target.value)] || 'default')} />
          <span className="model-effort-thumb" aria-hidden="true" />
        </div>}
      </div>
      {menuOpen && <div className="model-picker-menu" id={`${controlId}-menu`} onKeyDown={navigateModels}>
        <div className="model-picker-search"><Search size={14} aria-hidden="true" /><input ref={searchInput} type="search" aria-label="모델 검색" placeholder="모델 이름 또는 ID 검색" value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); if (choices.length === 1) chooseModel(choices[0].id); } }} /></div>
        <ul className="model-picker-options" aria-label="모델 목록">{choices.map(item => <li key={item.id || 'cli-default'}><button type="button" data-model-choice disabled={item.disabled} className={item.id === model && !custom ? 'selected' : ''} aria-pressed={item.id === model && !custom} onClick={() => chooseModel(item.id)}><span><strong>{item.label}</strong><small>{item.disabled ? '현재 사용 불가' : item.id || 'CLI에 저장된 모델 사용'}</small></span>{item.id === model && !custom && <Check size={15} aria-hidden="true" />}</button></li>)}</ul>
        {!choices.length && <p className="model-picker-empty">일치하는 모델이 없습니다.</p>}
        <button type="button" className="model-picker-custom" onClick={() => { setCustom(true); setMenuOpen(false); if (custom) customInput.current?.focus(); }}><Code2 size={14} />모델 ID 직접 입력</button>
      </div>}
    </div>
    <p className={`model-effort-hint ${unsupported ? 'invalid' : ''}`} id={`${controlId}-hint`} role={unsupported ? 'alert' : undefined}>{settingError || (reasoning === 'default' ? 'CLI 기본 설정은 최저 추론 단계가 아닙니다. 모델명을 눌러 모델을 변경하세요.' : provider === 'claude' && unknown ? '이 모델의 지원 단계는 확인되지 않았습니다. 선택값은 실행 시 CLI 설정에 따라 적용됩니다.' : '슬라이더로 추론 깊이를 조절하고, 모델명을 눌러 모델을 변경하세요.')}</p>
    <details className="session-profiles"><summary>작업 종류별 모델·추론 설정</summary><p className="muted">설정하지 않은 종류는 위 기본 프로필을 사용합니다.</p>
      {Object.entries({ chat: '대화', plan: '협의·설계', work: '구현', review: '검토', report: '보고' }).map(([key, label]) => <div className="form-grid" key={key}>
        <label><input type="checkbox" checked={Boolean(profiles[key])} onChange={event => setProfiles(current => { const next = { ...current }; if (event.target.checked) next[key] = { model, reasoning }; else delete next[key]; return next; })} />{label} 별도 설정</label>
        {profiles[key] && <><Field label={`${label} 모델`}><input value={profiles[key].model} maxLength={100} placeholder="CLI 기본 모델" onChange={event => setProfiles(current => ({ ...current, [key]: { ...current[key], model: event.target.value } }))} /></Field>
          <Field label={`${label} 추론`}><select value={profiles[key].reasoning} onChange={event => setProfiles(current => ({ ...current, [key]: { ...current[key], reasoning: event.target.value } }))}>{Object.entries(effortLabels).map(([value, title]) => <option value={value} key={value}>{title}</option>)}</select></Field></>}
      </div>)}
      <input type="hidden" name="sessionProfiles" value={JSON.stringify(profiles)} />
    </details>
    <input type="hidden" name="reasoning" value={reasoning} />
    {custom ? <Field label="모델 ID"><input ref={customInput} name="model" value={model} onChange={event => setModel(event.target.value)} required maxLength={100} pattern=".*\S.*" placeholder="사용할 모델의 정확한 ID" /></Field>
      : <input type="hidden" name="model" value={model} />}
    <div className="model-catalog-note" role="status"><p>{message}</p>{(catalog.isError || catalog.data?.status === 'unavailable') && <button type="button" className="text-button" disabled={catalog.isFetching} onClick={() => catalog.refetch()}>목록 다시 조회</button>}</div>
  </div>;
}
