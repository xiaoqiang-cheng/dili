import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyGroupRead, applyPendingGroupReads, applyStatePatch } from './state.ts';
import type { AppState, GroupReadReceipt, StatePatch } from '../shared/types.ts';

const state = (revision: number, instanceId = 'instance-a'): AppState => ({
  instanceId, revision, sessions: [], groups: [], backends: [], activities: [], defaultCwd: '/repo', demo: false,
});
const patch = (baseRevision: number, revision: number, extra: Partial<StatePatch> = {}): StatePatch => ({ instanceId: 'instance-a', baseRevision, revision, ...extra });

test('a patch without a matching instance is rejected', () => {
  assert.equal(applyStatePatch(state(3), { ...patch(3, 4), instanceId: 'other' }), null);
  assert.equal(applyStatePatch(null, patch(0, 1)), null);
});

test('a revision gap asks for a full snapshot', () => {
  assert.equal(applyStatePatch(state(3), patch(5, 6)), null);
});

test('duplicate patches keep object identity', () => {
  const current = state(3);
  assert.equal(applyStatePatch(current, patch(2, 3)), current);
});

test('a patch applies and advances the revision', () => {
  const current = state(3);
  const next = applyStatePatch(current, patch(3, 4, {
    sessions: [{ id: 's', title: 'x' } as never],
  }));
  assert.ok(next);
  assert.equal(next.revision, 4);
  assert.equal(next.sessions.length, 1);
});

test('removed activities stay removed', () => {
  const current: AppState = { ...state(1), activities: [
    { id: 'a', sessionId: null, type: 't', text: 'keep', createdAt: '' },
    { id: 'b', sessionId: null, type: 't', text: 'drop', createdAt: '' },
  ] };
  const next = applyStatePatch(current, patch(1, 2, { activities: { upsert: [], remove: ['b'] } }));
  assert.deepEqual(next?.activities.map(item => item.id), ['a']);
});

test('group read receipts do not clear newer reminders', () => {
  const current: AppState = { ...state(5), groups: [{ id: 'g', title: 'g', goal: '', unread: 3, createdAt: '', updatedAt: '' }], sessions: [
    { id: 'm', unread: 2 } as never,
  ] };
  const receipt: GroupReadReceipt = { id: 'g', title: 'g', goal: '', unread: 0, createdAt: '', updatedAt: '', members: [{ id: 'm', unread: 0, updatedAt: '' }], instanceId: 'instance-a', revision: 4 };
  assert.equal(applyGroupRead(current, receipt), current);
  assert.equal(applyGroupRead(current, { ...receipt, revision: 6 })?.groups[0].unread, 0);
});

test('pending receipts survive an older snapshot until superseded', () => {
  const receipts = new Map<string, GroupReadReceipt>();
  receipts.set('g', {
    id: 'g', title: 'g', goal: '', unread: 0, createdAt: '', updatedAt: '',
    members: [{ id: 'm', unread: 0, updatedAt: '' }], instanceId: 'instance-a', revision: 7,
  });
  const older: AppState = { ...state(5), groups: [{ id: 'g', title: 'g', goal: '', unread: 2, createdAt: '', updatedAt: '' }], sessions: [{ id: 'm', unread: 2 } as never] };
  const merged = applyPendingGroupReads(older, receipts);
  assert.equal(merged.groups[0].unread, 0);
  assert.equal(receipts.size, 1);
  applyPendingGroupReads(state(8), receipts);
  assert.equal(receipts.size, 0);
});
