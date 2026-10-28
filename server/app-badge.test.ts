import test from 'node:test';
import assert from 'node:assert/strict';
import { badgeCount } from '../client/app-badge.ts';
import type { Group, Session } from '../shared/types.ts';

const session = (patch: Partial<Session>) => ({ id: Math.random().toString(), archived: false, status: 'waiting_input', unread: 1, groupId: null, ...patch }) as Session;
const group = (patch: Partial<Group>) => ({ id: Math.random().toString(), title: 'g', goal: '', unread: 0, ...patch }) as Group;

test('the app badge counts personal reminders, group replies and blocked members, never a member turn twice', () => {
  assert.equal(badgeCount(null), 0);
  assert.equal(badgeCount({
    sessions: [
      session({ unread: 2 }), // personal contact waiting: 2
      session({ status: 'running', unread: 3 }), // running is not a reminder
      session({ archived: true, unread: 4 }),
      session({ groupId: 'g1', unread: 1 }), // member finished a turn: counted as the group reply
      session({ groupId: 'g1', status: 'waiting_approval', unread: 1 }), // member blocked on approval: 1
      session({ groupId: 'g1', status: 'error', unread: 1 }), // member error: 1
    ],
    groups: [group({ unread: 3 }), group({ unread: 5, archived: true }), group({})],
  }), 2 + 1 + 1 + 3);
});
