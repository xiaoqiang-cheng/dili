import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDLE_SLEEP_ENV, idleSleepMinutes, shouldSleep } from './idle-sleep.ts';

const now = Date.parse('2026-10-31T12:00:00.000Z');
const session = (overrides: Record<string, unknown> = {}) => ({
  running: true, archived: false, forkPending: false, status: 'idle', lastActivity: '2026-10-31T10:00:00.000Z', ...overrides,
}) as Parameters<typeof shouldSleep>[0];

test('idle sleep is off unless configured with a positive integer', () => {
  assert.equal(idleSleepMinutes({}), 0);
  assert.equal(idleSleepMinutes({ [IDLE_SLEEP_ENV]: '' }), 0);
  assert.equal(idleSleepMinutes({ [IDLE_SLEEP_ENV]: 'abc' }), 0);
  assert.equal(idleSleepMinutes({ [IDLE_SLEEP_ENV]: '-5' }), 0);
  assert.equal(idleSleepMinutes({ [IDLE_SLEEP_ENV]: '0' }), 0);
  assert.equal(idleSleepMinutes({ [IDLE_SLEEP_ENV]: '90' }), 90);
  assert.equal(idleSleepMinutes({ [IDLE_SLEEP_ENV]: '999999' }), 0);
});

test('only a settled idle process qualifies', () => {
  assert.equal(shouldSleep(session(), now, 60), true);
  assert.equal(shouldSleep(session(), now, 180), false);
  assert.equal(shouldSleep(session({ status: 'waiting_input' }), now, 60), false);
  assert.equal(shouldSleep(session({ status: 'waiting_approval' }), now, 60), false);
  assert.equal(shouldSleep(session({ status: 'running' }), now, 60), false);
  assert.equal(shouldSleep(session({ status: 'error' }), now, 60), false);
  assert.equal(shouldSleep(session({ status: 'unknown' }), now, 60), false);
});

test('archived, forked and stopped contacts never sleep', () => {
  assert.equal(shouldSleep(session({ archived: true }), now, 60), false);
  assert.equal(shouldSleep(session({ forkPending: true }), now, 60), false);
  assert.equal(shouldSleep(session({ running: false }), now, 60), false);
  assert.equal(shouldSleep(session(), now, 0), false);
});

test('an invalid timestamp is not evidence of idleness', () => {
  assert.equal(shouldSleep(session({ lastActivity: 'not-a-date' }), now, 60), false);
});
