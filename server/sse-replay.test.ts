import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SseReplayBuffer } from './sse-replay.ts';

const chunk = (revision: number) => `id: ${revision}\nevent: patch\ndata: {"revision":${revision}}\n\n`;

test('replays exactly the missing patches', () => {
  const buffer = new SseReplayBuffer();
  buffer.push(2, 0, chunk(2));
  buffer.push(5, 2, chunk(5));
  buffer.push(9, 5, chunk(9));
  assert.deepEqual(buffer.after(0), [chunk(2), chunk(5), chunk(9)]);
  assert.deepEqual(buffer.after(2), [chunk(5), chunk(9)]);
  assert.deepEqual(buffer.after(5), [chunk(9)]);
});

test('a gap forces a full snapshot', () => {
  const buffer = new SseReplayBuffer();
  buffer.push(5, 2, chunk(5));
  assert.equal(buffer.after(0), null);
  assert.equal(buffer.after(4), null);
});

test('a client already current asks for the snapshot when nothing is retained', () => {
  const buffer = new SseReplayBuffer();
  assert.equal(buffer.after(10), null);
  buffer.push(12, 10, chunk(12));
  assert.deepEqual(buffer.after(12), null);
  assert.deepEqual(buffer.after(10), [chunk(12)]);
});

test('invalid revision values fall back to a snapshot', () => {
  const buffer = new SseReplayBuffer();
  assert.equal(buffer.after(-1), null);
  assert.equal(buffer.after(Number.NaN), null);
  assert.equal(buffer.after(1.5), null);
});

test('out-of-order and duplicate publishes are ignored', () => {
  const buffer = new SseReplayBuffer();
  buffer.push(4, 2, chunk(4));
  buffer.push(4, 2, 'duplicate');
  buffer.push(3, 1, 'stale');
  assert.equal(buffer.size, 1);
  assert.equal(buffer.latestRevision, 4);
});

test('the window is bounded by count and bytes', () => {
  const buffer = new SseReplayBuffer(3, 10_000);
  for (let revision = 1; revision <= 6; revision++) buffer.push(revision, revision - 1, chunk(revision));
  assert.equal(buffer.size, 3);
  assert.deepEqual(buffer.after(3), [chunk(4), chunk(5), chunk(6)]);
  assert.equal(buffer.after(2), null);

  const tiny = new SseReplayBuffer(100, 200);
  for (let revision = 1; revision <= 10; revision++) tiny.push(revision, revision - 1, chunk(revision));
  assert.ok(tiny.size < 10);
  assert.equal(tiny.after(0), null);
});

test('a single oversized chunk is dropped instead of buffered', () => {
  const buffer = new SseReplayBuffer(10, 50);
  buffer.push(1, 0, 'x'.repeat(100));
  assert.equal(buffer.size, 0);
});
