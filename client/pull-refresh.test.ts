import test from 'node:test';
import assert from 'node:assert/strict';
import { PULL_THRESHOLD, pullDistance, startsPull } from './pull-refresh.ts';

test('the indicator lags the finger, stops at a limit and never goes negative', () => {
  assert.equal(pullDistance(-20), 0);
  assert.equal(pullDistance(40), 20);
  assert.ok(pullDistance(PULL_THRESHOLD * 2) >= PULL_THRESHOLD);
  assert.equal(pullDistance(10_000), pullDistance(20_000));
});

test('only a mostly downward move from the top starts a pull', () => {
  assert.equal(startsPull(true, 2, 10), true);
  assert.equal(startsPull(false, 2, 10), false);
  assert.equal(startsPull(true, 20, 10), false);
  assert.equal(startsPull(true, 0, -10), false);
  assert.equal(startsPull(true, 0, 0), false);
});
