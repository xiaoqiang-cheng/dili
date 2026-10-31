import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTACT_RENDER_STEP, buildContacts, compareContacts, contactTier, visibleContacts, type ContactEntry } from './contact-order.ts';
import type { Group, Session } from '../shared/types.ts';

const iso = (hoursAgo: number) => new Date(Date.UTC(2026, 9, 31, 12 - hoursAgo)).toISOString();

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id, backend: 'codex', title: id, cwd: `/repo/${id}`, nativeSessionId: null, groupId: null, parentId: null,
    forkPending: false, status: 'idle', statusSource: 'process', statusDetail: '', lastActivity: iso(1),
    createdAt: iso(24), updatedAt: iso(1), archived: false, pinned: false, unread: 0, running: false, origin: 'created',
    ...overrides,
  };
}

function group(id: string, overrides: Partial<Group> = {}): Group {
  return { id, title: id, goal: '', createdAt: iso(24), updatedAt: iso(1), ...overrides };
}

const query = (sessions: Session[], groups: Group[] = [], overrides: Partial<Parameters<typeof buildContacts>[0]> = {}) => ({
  sessions, groups, mode: 'contacts' as const, backend: 'all' as const, status: 'all' as const, query: '', sort: 'input' as const, ...overrides,
});

test('tiers follow pinned, reminder, running, waiting, rest', () => {
  const entries: ContactEntry[] = [
    { kind: 'session', id: 'idle', session: session('idle') },
    { kind: 'session', id: 'waiting', session: session('waiting', { status: 'waiting_input', statusSource: 'native' }) },
    { kind: 'session', id: 'running', session: session('running', { status: 'running', running: true }) },
    { kind: 'session', id: 'red', session: session('red', { status: 'waiting_approval', unread: 2 }) },
    { kind: 'session', id: 'pinned', session: session('pinned', { pinned: true }) },
  ];
  assert.deepEqual(entries.map(contactTier), [4, 3, 2, 1, 0]);
  assert.deepEqual(buildContacts(query(entries.map(entry => (entry as Extract<ContactEntry, { kind: 'session' }>).session))).map(entry => entry.id), ['pinned', 'red', 'running', 'waiting', 'idle']);
});

test('pinned entries stay first regardless of sort', () => {
  const sessions = [session('b', { pinned: true }), session('a'), session('c')].map(item => ({ ...item, lastUserInputAt: item.id === 'a' ? iso(0) : iso(5) }));
  const sorted = buildContacts(query(sessions, [], { sort: 'input' }));
  assert.equal(sorted[0].id, 'b');
});

test('groups are tiered by pinned, unread and running members', () => {
  const members = [session('m', { groupId: 'g-run', status: 'running', running: true })];
  const entries: ContactEntry[] = [
    { kind: 'group', id: 'g-idle', group: group('g-idle'), members: [] },
    { kind: 'group', id: 'g-run', group: group('g-run'), members },
    { kind: 'group', id: 'g-unread', group: group('g-unread', { unread: 1 }), members: [] },
    { kind: 'group', id: 'g-pin', group: group('g-pin', { pinned: true }), members: [] },
  ];
  assert.deepEqual(entries.map(contactTier), [4, 2, 1, 0]);
});

test('group members with approvals raise group attention even without unread messages', () => {
  const members = [session('m', { groupId: 'g', status: 'waiting_approval', unread: 1 })];
  const [entry] = buildContacts(query(members, [group('g')]));
  assert.equal(entry.kind, 'group');
  assert.equal(contactTier(entry), 1);
});

test('archive mode shows only archived sessions and groups', () => {
  const sessions = [session('live'), session('old', { archived: true })];
  const groups = [group('g-live'), group('g-old', { archived: true })];
  assert.deepEqual(buildContacts(query(sessions, groups)).map(entry => entry.id), ['g-live', 'live']);
  assert.deepEqual(buildContacts(query(sessions, groups, { mode: 'archive' })).map(entry => entry.id).sort(), ['g-old', 'old']);
});

test('contact mode hides group members, attention mode shows only reminders', () => {
  const members = [session('member', { groupId: 'g', status: 'running', running: true }), session('red', { status: 'error', unread: 1 })];
  const contacts = buildContacts(query(members, [group('g', { unread: 0 })]));
  assert.ok(contacts.some(entry => entry.id === 'member') === false);
  const attentionList = buildContacts(query(members, [group('g')], { mode: 'attention' }));
  assert.deepEqual(attentionList.map(entry => entry.id), ['red']);
});

test('filters by backend, status and query', () => {
  const sessions = [
    session('claude', { backend: 'claude', title: '登录实现', lastUserInput: '修复 iOS 键盘' }),
    session('codex', { backend: 'codex', title: '审查方案', cwd: '/work/review' }),
  ];
  assert.deepEqual(buildContacts(query(sessions, [], { backend: 'claude' })).map(entry => entry.id), ['claude']);
  assert.deepEqual(buildContacts(query(sessions, [], { query: 'iOS' })).map(entry => entry.id), ['claude']);
  assert.deepEqual(buildContacts(query(sessions, [], { query: 'Review' })).map(entry => entry.id), ['codex']);
  assert.deepEqual(buildContacts(query(sessions, [], { status: 'unread' })).map(entry => entry.id), []);
});

test('sort modes order by input, creation and natural name', () => {
  const sessions = [
    session('a', { title: '任务 10', createdAt: iso(5), lastUserInputAt: iso(3) }),
    session('b', { title: '任务 2', createdAt: iso(2), lastUserInputAt: iso(1) }),
    session('c', { title: '任务 1', createdAt: iso(1) }),
  ];
  assert.deepEqual(buildContacts(query(sessions, [], { sort: 'input' })).map(entry => entry.id), ['b', 'a', 'c']);
  assert.deepEqual(buildContacts(query(sessions, [], { sort: 'created' })).map(entry => entry.id), ['c', 'b', 'a']);
  assert.deepEqual(buildContacts(query(sessions, [], { sort: 'name' })).map(entry => entry.id), ['c', 'b', 'a']);
});

test('visibleContacts renders a bounded first page', () => {
  const entries = Array.from({ length: CONTACT_RENDER_STEP + 40 }, (_, index): ContactEntry => ({ kind: 'session', id: `s${index}`, session: session(`s${index}`) }));
  assert.equal(visibleContacts(entries, 0).length, CONTACT_RENDER_STEP);
  assert.equal(visibleContacts(entries, CONTACT_RENDER_STEP + 40).length, CONTACT_RENDER_STEP + 40);
  assert.equal(visibleContacts(entries, 10).length, CONTACT_RENDER_STEP);
});

test('compareContacts is a total order and breaks ties deterministically', () => {
  const a: ContactEntry = { kind: 'session', id: 'a', session: session('a', { title: '同名', createdAt: iso(5) }) };
  const b: ContactEntry = { kind: 'session', id: 'b', session: session('b', { title: '同名', createdAt: iso(20) }) };
  assert.equal(compareContacts(a, a, 'name'), 0);
  // Same displayed name sorts as a tie, then falls back to creation time.
  assert.equal(compareContacts(a, b, 'name'), 0);
  assert.ok(compareContacts(b, a, 'created') > 0);
  assert.equal(Math.sign(compareContacts(a, b, 'input')) + Math.sign(compareContacts(b, a, 'input')), 0);
});
