import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relativeTime, shortPath } from './format.ts';

const now = Date.parse('2026-10-31T12:00:00.000Z');

test('relativeTime covers every bucket', () => {
  assert.equal(relativeTime('2026-10-31T11:59:40.000Z', now), '刚刚');
  assert.equal(relativeTime('2026-10-31T11:05:00.000Z', now), '55 分钟前');
  assert.equal(relativeTime('2026-10-31T09:00:00.000Z', now), '3 小时前');
  assert.equal(relativeTime('2026-10-28T12:00:00.000Z', now), '3 天前');
});

test('relativeTime clamps future timestamps and rejects invalid ones', () => {
  assert.equal(relativeTime('2026-11-01T00:00:00.000Z', now), '刚刚');
  assert.equal(relativeTime('not-a-date', now), '—');
});

test('shortPath keeps the last two segments', () => {
  assert.equal(shortPath('/home/me/project/src'), 'project/src');
  assert.equal(shortPath('/home/me/project/'), 'me/project');
  assert.equal(shortPath('/'), '/');
  assert.equal(shortPath('project'), 'project');
});
