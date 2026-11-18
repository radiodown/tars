import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Clock3, Command, RefreshCw, Sparkles, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, time } from './api';

const providers = [
  { id: 'codex', name: 'Codex', Icon: Command },
  { id: 'codex2', name: 'Codex', Icon: Command },
  { id: 'claude', name: 'Claude', Icon: Sparkles },
];
const statuses = { ready: '조회 완료', unavailable: '한도 미제공', unsupported: '조회 미지원', auth_required: '로그인 확인', not_installed: '설치 필요', rate_limited: '조회 대기', error: '조회 실패' };
const percent = value => new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1 }).format(value);
const findAccount = (accounts, id) => accounts?.find(account => (account.accountId || account.provider) === id);

function UsageLimit({ limit, provider, period = '주간', compact = false }) {
  const expired = limit?.resetsAt && new Date(limit.resetsAt).getTime() <= Date.now();
  const used = limit?.usedPercent;
  const missing = used == null;
  const label = limit?.label || '전체 모델';
  const unavailable = missing || expired;
  const tone = used >= 90 ? 'high' : used >= 70 ? 'medium' : '';
  const track = <div className="quota-track" role="progressbar" aria-label={`${provider} ${label} ${period} 사용률`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={unavailable ? undefined : Math.min(100, used)} aria-valuetext={missing ? '한도 미제공' : expired ? '초기화 후 갱신 대기' : `${percent(used)}% 사용`}>
    {!unavailable && <span style={{ width: `${Math.min(100, used)}%` }} />}
  </div>;
  if (compact) {
    const summaryLabel = label === '전체 모델' ? period : `${period} · ${label}`;
    return <div className={`floating-quota-limit weekly-limit ${tone} ${expired ? 'expired' : ''}`}>
      <span title={summaryLabel}>{summaryLabel}</span>
      {track}
      <strong title={expired ? '초기화 후 갱신 대기' : undefined}>{unavailable ? '—' : `${percent(used)}%`}</strong>
    </div>;
  }
  return <section className={`weekly-limit ${tone} ${expired ? 'expired' : ''}`}>
    <div className="weekly-label"><h3>{label}</h3><span>{period} 한도</span></div>
    <div className="weekly-value"><strong>{unavailable ? '—' : percent(used)}{!unavailable && <small>%</small>}</strong><span>{missing ? '한도 미제공' : expired ? '초기화 후 갱신 대기' : '사용'}</span></div>
    {track}
    <div className="weekly-details"><span>{missing ? `${period} 한도 정보가 제공되지 않았습니다` : expired ? '다음 조회에서 확인합니다' : `잔여 ${percent(Math.max(0, 100 - used))}%`}</span><span><Clock3 size={13} />{limit?.resetsAt ? `${time(limit.resetsAt)} 초기화` : '초기화 시간 미제공'}</span></div>
  </section>;
}

function AccountCard({ provider, account, loading, failed }) {
  const { Icon } = provider;
  const weekly = account?.weekly || [];
  const isClaude = provider.id === 'claude';
  const accountName = isClaude ? provider.name : `${provider.name} · ${provider.id}`;
  const hasLimits = weekly.length > 0 || (isClaude && account?.fiveHour);
  return <article className="panel account-quota-card" aria-label={accountName} aria-busy={loading}>
    <header><span className={`provider-logo ${isClaude ? 'claude' : 'codex'}`}><Icon size={22} /></span><div><h2>{provider.name}</h2><p>{isClaude ? '내 계정' : `계정 · ${provider.id}`}</p></div><span className="account-plan">{account?.plan || (loading ? '확인 중' : '플랜 미제공')}</span></header>
    {hasLimits ? <div className="weekly-limits">
      {isClaude && <UsageLimit limit={account?.fiveHour} provider={accountName} period="5시간" />}
      {weekly.length ? weekly.map(limit => <UsageLimit key={limit.id} limit={limit} provider={accountName} />) : <UsageLimit provider={accountName} />}
    </div> : <div className="quota-empty"><span className="quota-empty-value">—</span><strong>{loading ? '사용 한도를 불러오는 중' : failed ? '조회 실패' : statuses[account?.status] || '확인 필요'}</strong><p>{loading ? '연결된 계정의 사용률을 확인합니다.' : account?.message || '계정 정보를 불러오지 못했습니다. 다시 조회해 주세요.'}</p></div>}
    <footer><span className={`quota-status ${account?.status === 'ready' && !failed ? 'ready' : ''}`}><i />{loading ? '갱신 중' : failed ? '조회 실패' : statuses[account?.status] || '확인 대기'}</span><span>{account?.checkedAt ? `최근 조회 ${time(account.checkedAt)}` : '조회 기록 없음'}</span></footer>
    {account?.status === 'rate_limited' && <p className="quota-retry">다음 조회 가능: {time(account.nextRefreshAt)}</p>}
  </article>;
}

function useAccountUsage() {
  const queryClient = useQueryClient();
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  useEffect(() => {
    const update = () => {
      const isVisible = document.visibilityState === 'visible';
      setVisible(isVisible);
      if (!isVisible) queryClient.cancelQueries({ queryKey: ['account-usage'] });
    };
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, [queryClient]);
  const query = useQuery({
    queryKey: ['account-usage'],
    queryFn: ({ signal }) => api('/account-usage', 'GET', undefined, { signal }),
    enabled: visible,
    staleTime: 60_000,
    refetchInterval: visible ? 60_000 : false,
    refetchIntervalInBackground: false,
    retry: false,
  });
  return { query, visible };
}

export function Usage() {
  const { query, visible } = useAccountUsage();
  return <div className="page account-usage-page">
    <div className="page-heading"><div><p className="eyebrow">ACCOUNT USAGE</p><h1>사용량</h1><p>내 계정의 플랜과 주간 한도, Claude의 5시간 한도를 확인하세요.</p></div><button className="button secondary" onClick={() => query.refetch()} disabled={query.isFetching || !visible} aria-label="계정 사용 한도 새로고침"><RefreshCw size={16} />{query.isFetching ? '조회 중' : '새로고침'}</button></div>
    {query.isError && <p className="error-box" role="alert">계정 정보를 불러오지 못했습니다. 서버 연결을 확인하고 다시 조회하세요.</p>}
    <div className="account-quota-grid">{providers.map(provider => <AccountCard key={provider.id} provider={provider} account={findAccount(query.data?.accounts, provider.id)} loading={query.isFetching} failed={query.isError} />)}</div>
    <p className="usage-note">서버에서 로그인한 계정 기준입니다. 화면이 보일 때만 1분 간격으로 조회하며, 새로고침에도 최대 1분간 저장된 조회 결과를 사용합니다. 한도가 제공되지 않으면 ‘—’로 표시합니다.</p>
  </div>;
}

export function UsageSummary({ onDetails }) {
  const { query, visible } = useAccountUsage();
  const canRefresh = visible && !query.isFetching;
  return <>
    <header className="floating-usage-heading">
      <h2>사용량</h2>
      <button className="icon-button" type="button" onClick={() => { if (canRefresh) query.refetch(); }} aria-disabled={!canRefresh} aria-label="계정 사용 한도 새로고침" title="새로고침"><RefreshCw size={14} className={query.isFetching ? 'spin' : undefined} /></button>
      <button className="icon-button" type="button" popoverTarget="floating-usage-panel" popoverTargetAction="hide" aria-label="사용량 닫기" title="닫기"><X size={16} /></button>
    </header>
    <div className="floating-quota-list" aria-busy={query.isFetching}>
      {query.isError && <p className="floating-quota-message" role="alert">사용량 조회 실패</p>}
      {providers.map(({ id, name, Icon }) => {
        const account = findAccount(query.data?.accounts, id);
        const weekly = account?.weekly?.find(limit => limit.label === '전체 모델') || account?.weekly?.[0];
        const fiveHour = id === 'claude' && account?.fiveHour;
        const accountName = id === 'codex2' ? 'Codex 2' : name;
        return <section className="floating-quota-account" key={id}>
          <h3><Icon size={14} /><span>{accountName}</span>{account?.plan && <small>{account.plan}</small>}</h3>
          {fiveHour && <UsageLimit compact limit={fiveHour} provider={accountName} period="5시간" />}
          {weekly && <UsageLimit compact limit={weekly} provider={accountName} />}
          {!fiveHour && !weekly && <p className="floating-quota-message">{query.isPending ? '조회 중' : statuses[account?.status] || '—'}</p>}
        </section>;
      })}
    </div>
    <Link className="floating-usage-details" to="/usage" onClick={onDetails}>상세 사용량 <ArrowRight size={13} /></Link>
  </>;
}
