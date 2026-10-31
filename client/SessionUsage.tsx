import { useEffect, useState } from 'react';
import { api } from './api';
import { formatTokens, type SessionUsage } from '../shared/usage';
import { t } from '../shared/i18n';

export interface UsageResult { usage: SessionUsage | null; note?: string }
type UsageSession = { id: string; backend: string; nativeSessionId: string | null; lastActivity: string; forkPending: boolean };

const cache = new Map<string, { value: UsageResult; at: number }>();
const TTL = 30_000;
const CACHE_LIMIT = 50;

function cacheKey(session: UsageSession): string {
  // lastActivity deliberately stays out of the key: a busy session would
  // otherwise refetch on every status tick. The TTL bounds staleness instead.
  return `${session.id}:${session.nativeSessionId ?? ''}:${session.forkPending}`;
}

/** Reads the current transcript's usage, coalescing re-renders of a busy session. */
export function useSessionUsage(session: UsageSession | null): UsageResult | null {
  const key = session ? cacheKey(session) : '';
  const id = session?.id ?? '';
  const [value, setValue] = useState<UsageResult | null>(() => (key ? cache.get(key)?.value ?? null : null));
  useEffect(() => {
    if (!session || !id || !key) return;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < TTL) { setValue(cached.value); return; }
    let live = true;
    api<UsageResult>(`/sessions/${encodeURIComponent(id)}/usage`)
      .then(result => {
        cache.set(key, { value: result, at: Date.now() });
        while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
        if (live) setValue(result);
      })
      .catch(cause => { if (live) setValue({ usage: null, note: cause instanceof Error ? cause.message : '无法读取用量' }); });
    return () => { live = false; };
  }, [id, key]);
  return value;
}

export function usageText(usage: SessionUsage): string {
  const parts = [t('usage.turns', { n: usage.turns }), t('usage.input', { value: formatTokens(usage.inputTokens) }), t('usage.output', { value: formatTokens(usage.outputTokens) })];
  if (usage.cacheReadTokens > 0) parts.push(t('usage.cacheRead', { value: formatTokens(usage.cacheReadTokens) }));
  if (usage.lastTurnInputTokens !== null && usage.lastTurnInputTokens > 0) parts.push(t('usage.context', { value: formatTokens(usage.lastTurnInputTokens) }));
  if (usage.partial) parts.push(t('usage.partial'));
  return parts.join(' · ');
}

export default function SessionUsageLine({ session }: { session: UsageSession }) {
  const result = useSessionUsage(session);
  if (!result) return <div><span>{t('usage.title')}</span><small className="usage-pending">{t('usage.pending')}</small></div>;
  if (!result.usage) return <div><span>{t('usage.title')}</span><small className="usage-missing" title={result.note}>{t('usage.unknown')}</small></div>;
  return <div><span>{t('usage.title')}</span><small className="usage-value" title={`${result.note ?? '来自本地原生历史'}${result.usage.partial ? '；仅统计最近读取的历史窗口，累计值以原生界面为准' : ''}`}>{usageText(result.usage)}</small></div>;
}
