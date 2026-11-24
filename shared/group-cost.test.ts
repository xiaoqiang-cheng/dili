import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupCost } from './group-cost.ts';

const usage = (totalTokens: number, partial = false) => ({
  inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 0,
  totalTokens, lastTurnInputTokens: 115, lastTurnOutputTokens: 5, turns: 1, model: 'm', partial,
});

const members = [
  { id: 's-a', title: '开发A', usage: usage(1000) },
  { id: 's-b', title: '开发B', usage: usage(2000, true) },
  // dsh before its usage record was readable, or any backend that reports nothing.
  { id: 's-c', title: '开发C', usage: null },
];

const deliveries: { id: string; sessionId: string; tag?: string; briefing?: boolean; createdAt: string; replyMessageId?: string }[] = [
  { id: 'd2', sessionId: 's-b', tag: 'T-bbbb2222', createdAt: '2026-11-01T02:00:00.000Z', replyMessageId: 'm2' },
  { id: 'd1', sessionId: 's-a', tag: 'T-aaaa1111', createdAt: '2026-11-01T01:00:00.000Z', replyMessageId: 'm1' },
  { id: 'd3', sessionId: 's-c', tag: 'T-cccc3333', createdAt: '2026-11-01T03:00:00.000Z' },
  { id: 'd0', sessionId: 's-a', briefing: true, createdAt: '2026-11-01T00:00:00.000Z' },
];

const messages = [
  { id: 'm1', groupId: 'g1', senderId: 's-a', senderName: '开发A', kind: 'reply' as const },
  { id: 'm2', groupId: 'g1', senderId: 's-b', senderName: '开发B', kind: 'reply' as const },
];

test('tasks are listed oldest first and keep the native tag', () => {
  const cost = groupCost('g1', messages, deliveries, members);
  assert.deepEqual(cost.tasks.map(task => task.key), ['d0', 'T-aaaa1111', 'T-bbbb2222', 'T-cccc3333']);
  assert.equal(cost.tasks[0]!.kind, 'briefing');
  assert.equal(cost.tasks[1]!.memberName, '开发A');
});

test('a member that reports nothing is counted as unknown, never estimated', () => {
  const cost = groupCost('g1', messages, deliveries, members);
  const unknown = cost.tasks.find(task => task.deliveryId === 'd3')!;
  assert.equal(unknown.totalTokens, null);
  assert.equal(cost.unknown, 1);
  // Only the three reporting tasks contribute (1000 + 1000 briefing + 2000), so
  // the sum cannot pretend to be the group total while one task is unknown.
  assert.equal(cost.totalTokens, 4000);
});

test('a partial native window marks the whole group as partial', () => {
  const cost = groupCost('g1', messages, deliveries, members);
  assert.equal(cost.partial, true);
  assert.equal(cost.tasks.find(task => task.deliveryId === 'd2')!.partial, true);
});

test('members are summarised by how many tasks each carried', () => {
  const cost = groupCost('g1', messages, deliveries, members);
  assert.deepEqual(cost.members, [
    { id: 's-a', name: '开发A', tasks: 2 },
    { id: 's-b', name: '开发B', tasks: 1 },
    { id: 's-c', name: '开发C', tasks: 1 },
  ]);
});

test('no reporting members means no number at all', () => {
  const cost = groupCost('g1', messages, deliveries, [members[2]!]);
  assert.equal(cost.totalTokens, null);
  assert.equal(cost.unknown, 4);
  assert.equal(cost.partial, false);
});

test('an empty group has no cost rather than a zero', () => {
  const cost = groupCost('g1', [], [], []);
  assert.equal(cost.totalTokens, null);
  assert.deepEqual(cost.tasks, []);
  assert.equal(cost.unknown, 0);
});

test('messages from another group are not used to attribute a sender', () => {
  const cost = groupCost('g1', [{ id: 'm9', groupId: 'other', senderId: 's-z', senderName: '别人', kind: 'reply' as const }], [], members);
  assert.deepEqual(cost.tasks, []);
  const withReply = groupCost('g1', [{ id: 'm9', groupId: 'other', senderId: 's-z', senderName: '别人', kind: 'reply' as const }], [
    { id: 'd9', sessionId: 'unknown', tag: 'T-99999999', createdAt: '2026-11-01T00:00:00.000Z', replyMessageId: 'm9' },
  ], members);
  // The sender name only comes from this group's own reply, so it falls back to the id.
  assert.equal(withReply.tasks[0]!.memberName, 'unknown…');
});
