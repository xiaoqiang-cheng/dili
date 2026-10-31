/**
 * Token usage derived from native history. Dili does not estimate usage: a
 * backend that reports nothing gets `null` and the UI says so. Codex reports
 * cumulative totals, so a tail-window read is still complete; Claude reports
 * per message, so a truncated window is marked `partial`.
 */
export interface SessionUsage {
  /** Totals over the readable history (or the native cumulative total). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** Tokens that made up the last assistant turn's prompt (context estimate). */
  lastTurnInputTokens: number | null;
  lastTurnOutputTokens: number | null;
  /** Completed assistant messages/turns that carried usage. */
  turns: number;
  model: string | null;
  /** True when older history was outside the read window. */
  partial: boolean;
}

export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** Share of a context window in use, or null when either side is unknown. */
export function contextShare(usage: Pick<SessionUsage, 'lastTurnInputTokens'> | null | undefined, contextWindow?: number | null): number | null {
  if (!usage || usage.lastTurnInputTokens === null || usage.lastTurnInputTokens === undefined) return null;
  if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0) return null;
  return Math.max(0, Math.min(1, usage.lastTurnInputTokens / contextWindow));
}

export function usageSummary(usage: SessionUsage | null | undefined): string {
  if (!usage) return '原生未提供';
  const parts = [`${usage.turns} 轮`, `输入 ${formatTokens(usage.inputTokens)}`, `输出 ${formatTokens(usage.outputTokens)}`];
  if (usage.partial) parts.push('最近窗口');
  return parts.join(' · ');
}
