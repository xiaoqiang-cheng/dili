import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextShare, formatTokens, usageSummary, type SessionUsage } from '../shared/usage.ts';

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
