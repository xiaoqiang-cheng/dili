import assert from 'node:assert/strict';
import test from 'node:test';
import { HistoryCache, historyRefresh } from './history-refresh';
const tick = () => new Promise(resolve => setImmediate(resolve));

test('slow refresh is retained and repeated updates coalesce into one follow-up', async () => {
  let release!: () => void;
  let calls = 0, completed = 0;
  const worker = historyRefresh(async () => {
    calls++;
    if (calls === 1) await new Promise<void>(resolve => { release = resolve; });
    completed++;
  }, () => assert.fail('unexpected error'));
  worker.request(); worker.request(); worker.request();
  assert.equal(calls, 1);
  release(); await tick();
  assert.equal(completed, 2); assert.equal(calls, 2);
  worker.stop(); worker.request(); await tick(); assert.equal(calls, 2);
});

test('navigation cancels queued work and errors allow later retry', async () => {
  let release!: () => void;
  let calls = 0, errors = 0;
  const worker = historyRefresh(async () => {
    calls++;
    await new Promise<void>(resolve => { release = resolve; });
    throw new Error('offline');
  }, () => errors++);
  worker.request(); worker.request(); worker.stop(); release(); await tick();
  assert.equal(calls, 1); assert.equal(errors, 0);
  const retry = historyRefresh(async () => { throw new Error('offline'); }, () => errors++);
  retry.request(); await tick(); retry.request(); await tick();
  assert.equal(errors, 2);
});

test('history cache separates instances, bounds memory and replaces oversized entries', () => {
  const cache = new HistoryCache<string>();
  cache.put('instance-a/group', 'history');
  assert.equal(cache.get('instance-b/group'), null);
  for (let n = 0; n < 9; n++) cache.put(String(n), 'entry');
  assert.equal(cache.get('instance-a/group'), null);
  cache.put('8', 'x'.repeat(500_001)); assert.equal(cache.get('8'), null);
});
