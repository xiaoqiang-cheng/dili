import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, formatMessage, missingKeys, t, zh, type MessageKey } from '../shared/i18n.ts';

test('t returns the catalog value', () => {
  assert.equal(t('common.copy'), '复制');
  assert.equal(t('usage.title'), '用量');
});

test('formatMessage substitutes named placeholders', () => {
  assert.equal(formatMessage('输入 {value}', { value: '12k' }), '输入 12k');
  assert.equal(formatMessage('{a}-{b}', { a: 1, b: 2 }), '1-2');
});

test('missing parameters stay visible for debugging', () => {
  assert.equal(formatMessage('输入 {value}', { other: 1 }), '输入 {value}');
  assert.equal(formatMessage('{value}', {}), '{value}');
});

test('formatMessage does not interpret HTML', () => {
  assert.equal(formatMessage('{value}', { value: '<b>x</b>' }), '<b>x</b>');
});

test('every catalog value is non-empty and keys are unique', () => {
  const keys = Object.keys(zh) as MessageKey[];
  assert.equal(new Set(keys).size, keys.length);
  for (const key of keys) assert.ok(zh[key].trim().length > 0, key);
});

test('missingKeys reports only absent entries', () => {
  const partial: Partial<Record<MessageKey, string>> = { 'common.copy': '复制', 'usage.title': ' ' };
  const missing = missingKeys(partial);
  assert.ok(!missing.includes('common.copy'));
  assert.ok(missing.includes('usage.title'));
  assert.ok(missing.includes('debug.title'));
});

test('locale constants stay in sync', () => {
  assert.equal(DEFAULT_LOCALE, 'zh-CN');
  assert.deepEqual([...SUPPORTED_LOCALES], ['zh-CN']);
});
