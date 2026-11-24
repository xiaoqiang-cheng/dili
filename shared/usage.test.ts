import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextIsTight, contextShare, costSummary, formatTokens, usageSummary, type SessionUsage } from '../shared/usage.ts';

const usage: SessionUsage = {
  inputTokens: 12_345, outputTokens: 2_100, cacheReadTokens: 40_000, cacheWriteTokens: 5_000,
  totalTokens: 59_445, lastTurnInputTokens: 48_000, lastTurnOutputTokens: 900, turns: 7, model: 'claude-sonnet', partial: false,
};

test('formatTokens keeps short and long values readable', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1_234), '1.2k');
  assert.equal(formatTokens(12_345), '12k');
  assert.equal(formatTokens(1_234_567), '1.2M');
  assert.equal(formatTokens(Number.NaN), '—');
  assert.equal(formatTokens(-1), '—');
});

test('contextShare only answers with both sides known', () => {
  assert.equal(contextShare(usage, 200_000), 0.24);
  assert.equal(contextShare(usage, null), null);
  assert.equal(contextShare(usage, 0), null);
  assert.equal(contextShare({ lastTurnInputTokens: null }, 200_000), null);
  assert.equal(contextShare(null, 200_000), null);
  assert.equal(contextShare({ lastTurnInputTokens: 500_000 }, 200_000), 1);
});

test('usageSummary names every part and marks a partial window', () => {
  assert.equal(usageSummary(usage), '7 轮 · 输入 12k · 输出 2.1k');
  assert.equal(usageSummary({ ...usage, partial: true }), '7 轮 · 输入 12k · 输出 2.1k · 最近窗口');
  assert.equal(usageSummary(null), '原生未提供');
});

test('costSummary reports only native fields and never estimates', () => {
  const base = { inputTokens: 8_400_000, outputTokens: 674_000, cacheReadTokens: 399_000_000, cacheWriteTokens: 0, totalTokens: 0, lastTurnInputTokens: 966_976, lastTurnOutputTokens: 100, turns: 1002, model: null, partial: false };
  // No window in the record: size without a share.
  assert.equal(costSummary({ ...base, contextWindow: null, compactions: 1 }), '上下文 967k · 已压缩 1 次 · 缓存读 399.0M · 输入 8.4M · 输出 674k');
  // Window present: size and share.
  assert.equal(costSummary({ ...base, contextWindow: 262_144, compactions: 165 }), '上下文 967k / 262k（100%） · 已压缩 165 次 · 缓存读 399.0M · 输入 8.4M · 输出 674k');
  assert.equal(costSummary(null), '原生未提供');
});

test('costSummary omits a context line when no turn carried usage', () => {
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, lastTurnInputTokens: null, lastTurnOutputTokens: null, turns: 0, model: null, partial: false, compactions: 0 };
  assert.equal(costSummary(usage), '输入 0 · 输出 0');
});

test('contextIsTight only answers with a native window', () => {
  const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, lastTurnInputTokens: 160_000, lastTurnOutputTokens: 10, turns: 1, model: null, partial: false, contextWindow: 200_000 };
  assert.equal(contextIsTight(usage), true);
  assert.equal(contextIsTight({ ...usage, lastTurnInputTokens: 100_000 }), false);
  assert.equal(contextIsTight({ ...usage, contextWindow: null }), false);
  assert.equal(contextIsTight(null), false);
});
