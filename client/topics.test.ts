import test from 'node:test';
import assert from 'node:assert/strict';
import type { BackendInfo, Group, GroupMessage, Session } from '../shared/types.ts';
import { canJoinTopic, continuesPrevious, forkTitle, sortTopics, topicCategories, topicDirectory, topicPreview } from './topics.ts';
import { readWorkspaceRoute, workspaceHash } from './navigation.ts';

const topic = (id: string, overrides: Partial<Group> = {}): Group => ({ id, kind: 'topic', title: id, goal: '', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', ...overrides });

test('topics sort pinned first, then by latest activity, and preview the newest message', () => {
  const sorted = sortTopics([topic('old'), topic('busy', { lastMessage: { text: 'x', senderName: 'A', at: '2026-11-03T00:00:00Z' } }), topic('pinned', { pinned: true })]);
  assert.deepEqual(sorted.map(item => item.id), ['pinned', 'busy', 'old']);
  assert.equal(topicPreview(sorted[1]!), 'A：x');
  assert.equal(topicPreview(topic('t', { goal: '  原帖\n正文 ' })), '原帖 正文');
  assert.equal(topicPreview(topic('t')), '还没有回复');
});

test('only contacts with a settled native session and fork support can join', () => {
  const backends = [{ id: 'codex', label: 'Codex', capabilities: { fork: true } }, { id: 'dsh', label: 'DeepSeek Harness', capabilities: { fork: false } }] as unknown as BackendInfo[];
  const contact = { backend: 'codex', nativeSessionId: 'n', forkPending: false } as Session;
  assert.deepEqual(canJoinTopic(contact, backends), { ok: true });
  assert.equal(canJoinTopic({ ...contact, nativeSessionId: null }, backends).ok, false);
  assert.equal(canJoinTopic({ ...contact, forkPending: true }, backends).ok, false);
  assert.equal(canJoinTopic({ ...contact, backend: 'dsh' }, backends).ok, false);
  assert.equal(forkTitle('A', 'B'), 'A · B');
  assert.equal(forkTitle('A'.repeat(100), 'B'.repeat(100)).length, 120);
});

test('topic routes round-trip through the hash', () => {
  assert.equal(readWorkspaceRoute('#/topics').view, 'topics');
  assert.equal(readWorkspaceRoute('#/topics/abc-1').view, 'topic:abc-1');
  assert.equal(workspaceHash({ view: 'topic:abc-1', selectedId: 's1' }), '#/topics/abc-1?session=s1');
  assert.equal(readWorkspaceRoute('#/topics/bad id').view, 'contacts');
});

test('channels group by the directory their participants work in', () => {
  const at = (hours: number) => new Date(Date.UTC(2026, 10, 1, hours)).toISOString();
  const member = (groupId: string, cwd: string, archived = false) => ({ id: `${groupId}-${cwd}`, groupId, cwd, archived }) as Session;
  const topics = [
    topic('a', { lastMessage: { text: '', senderName: '', at: at(1) } }),
    topic('b', { lastMessage: { text: '', senderName: '', at: at(5) } }),
    topic('c', { lastMessage: { text: '', senderName: '', at: at(3) } }),
    topic('lonely', { lastMessage: { text: '', senderName: '', at: at(9) } }),
    topic('own', { workspace: '/work/other/api' }),
  ];
  const sessions = [member('a', '/home/x/dili'), member('b', '/home/x/dili'), member('b', '/tmp/y'), member('b', '/home/x/dili'), member('c', '/srv/site'), member('c', '/srv/old', true)];
  const categories = topicCategories(topics, sessions);
  assert.deepEqual(categories.map(category => [category.label, category.topics.map(item => item.id)]), [
    ['x/dili', ['b', 'a']], ['srv/site', ['c']], ['other/api', ['own']], ['未分类', ['lonely']],
  ]);
  assert.equal(topicDirectory({}, []), '');
  // Same short name in two places: show the full paths.
  const twins = topicCategories([topic('p'), topic('q')], [member('p', '/a/x/app'), member('q', '/b/x/app')]);
  assert.deepEqual(twins.map(category => category.label).sort(), ['/a/x/app', '/b/x/app']);
});

test('consecutive messages from one sender within five minutes merge', () => {
  const message = (senderId: string | null, minute: number, extra: Partial<GroupMessage> = {}) => ({ senderId, senderName: senderId ?? '你', kind: 'reply' as const, createdAt: new Date(Date.UTC(2026, 10, 1, 0, minute)).toISOString(), ...extra });
  assert.equal(continuesPrevious(undefined, message('a', 0)), false);
  assert.equal(continuesPrevious(message('a', 0), message('a', 4)), true);
  assert.equal(continuesPrevious(message('a', 0), message('a', 6)), false);
  assert.equal(continuesPrevious(message('a', 0), message('b', 1)), false);
  assert.equal(continuesPrevious(message(null, 0, { kind: 'task' }), message(null, 1, { kind: 'note' })), false);
  assert.equal(continuesPrevious(message('a', 0), message('a', 1, { via: 's' })), false);
});
