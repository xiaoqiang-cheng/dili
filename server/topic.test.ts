import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { taskTagLine } from '../shared/group-prompt.ts';
import type { ConversationTranscript } from '../shared/types.ts';
import { Store } from './store.ts';
import { TopicMirror, directTurns } from './topic-mirror.ts';

const turns = (...items: [string, 'user' | 'assistant', string, string?][]): ConversationTranscript => ({ truncated: false, messages: items.map(([id, role, text, createdAt]) => ({ id, role, text, ...(createdAt ? { createdAt } : {}) })) });

test('a topic message reaches participants as a topic, with the opening post for late joiners', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const topic = store.addGroup('登录页改版', '原帖正文', 'topic');
  assert.equal(topic.kind, 'topic');
  const early = store.addSession({ backend: 'codex', title: '设计', cwd: '/a', groupId: topic.id });
  store.addMessage({ groupId: topic.id, senderId: null, senderName: '你', kind: 'task', text: '先出两个方案', recipientIds: [early.id] });
  const first = store.deliveries()[0]!;
  assert.match(first.text, /^【话题】任务编号：T-[0-9a-f]+ · 话题「登录页改版」/);
  assert.match(first.text, /## 话题说明[\s\S]*参与者「设计」/);
  assert.match(first.text, /## 话题消息\n\n先出两个方案$/);
  // Participants keep their own directories: no shared-workspace warning.
  assert.doesNotMatch(first.text, /群工作区/);
  // The opening post itself is not repeated as background.
  assert.doesNotMatch(first.text, /话题至今的讨论/);
  store.addReply(first.id, { text: '方案 A 与 B' });
  const late = store.addSession({ backend: 'claude', title: '前端', cwd: '/b', groupId: topic.id });
  store.addMessage({ groupId: topic.id, senderId: null, senderName: '你', kind: 'task', text: '按方案 A 实现', recipientIds: [late.id] });
  const second = store.deliveries().find(item => item.sessionId === late.id)!;
  assert.match(second.text, /## 话题至今的讨论[\s\S]*你（原帖）\n先出两个方案[\s\S]*### 设计\n方案 A 与 B/);
  // Ordinary groups keep their wording.
  const group = store.addGroup('G', '目标');
  const member = store.addSession({ backend: 'codex', title: 'M', cwd: '/c', groupId: group.id });
  store.addMessage({ groupId: group.id, senderId: null, senderName: '你', kind: 'task', text: 'x', recipientIds: [member.id] });
  assert.match(store.deliveries().at(-1)!.text, /^【群聊任务】/);
});

test('direct turns skip fork history, topic tasks and agent-started turns', () => {
  const tag = 'T-abc123';
  const transcript = turns(
    ['old', 'user', '分叉前的私聊'], ['old-a', 'assistant', '旧回答'],
    ['task', 'user', `【话题】${taskTagLine(tag)}\n\n话题消息`], ['task-a', 'assistant', '话题回答'],
    ['mine', 'user', '直接在会话里问'], ['mine-a1', 'assistant', '中间进度'], ['auto', 'user', '<task-notification>done</task-notification>'], ['mine-a2', 'assistant', '最终回答'],
    ['next', 'user', '还在想'],
  );
  assert.deepEqual(directTurns(transcript, [tag]), [{ userId: 'mine', userText: '直接在会话里问', replyText: '最终回答', closed: true }]);
  // Without a visible topic turn, only turns after joining count.
  const window = turns(['a', 'user', '旧', '2026-01-01T00:00:00Z'], ['a1', 'assistant', '旧答', '2026-01-01T00:00:01Z'], ['b', 'user', '新', '2026-02-01T00:00:00Z'], ['b1', 'assistant', '新答', '2026-02-01T00:00:01Z']);
  assert.deepEqual(directTurns(window, [tag], '2026-01-15T00:00:00Z').map(turn => turn.userText), ['新']);
  assert.deepEqual(directTurns(window, [tag]), []);
});

test('turns typed in a participant session appear in the topic once and settle', async t => {
  const store = new Store(':memory:');
  const topic = store.addGroup('T', '', 'topic');
  const member = store.addSession({ backend: 'codex', title: 'A', cwd: '/a', groupId: topic.id, status: 'waiting_input' });
  store.addMessage({ groupId: topic.id, senderId: null, senderName: '你', kind: 'task', text: '原帖', recipientIds: [member.id] });
  const tag = store.deliveries()[0]!.tag!;
  let transcript = turns(['t', 'user', taskTagLine(tag)], ['t1', 'assistant', '收到'], ['u', 'user', '私聊里追问'], ['u1', 'assistant', '初稿']);
  let changes = 0;
  const mirror = new TopicMirror({ store, read: async () => transcript, turnOpen: () => false, onChange: () => { changes++; }, delayMs: 1 });
  t.after(() => { mirror.close(); store.close(); });
  const until = async (condition: () => boolean) => { for (let i = 0; i < 100; i++) { if (condition()) return; await delay(10); } assert.fail('topic mirror did not settle'); };
  mirror.statusChanged(store.session(member.id)!);
  await until(() => changes === 1);
  let messages = store.groupDetail(topic.id).messages.filter(item => item.via === member.id);
  assert.deepEqual(messages.map(item => [item.kind, item.senderName, item.text]), [['note', '你', '私聊里追问'], ['reply', 'A', '初稿']]);
  assert.equal(messages[1]!.sourceMessageId, messages[0]!.id);
  // Mirrored replies were read in the session; they do not raise topic unread.
  assert.equal(store.group(topic.id)!.unread ?? 0, 0);
  transcript = turns(['t', 'user', taskTagLine(tag)], ['t1', 'assistant', '收到'], ['u', 'user', '私聊里追问'], ['u1', 'assistant', '定稿'], ['v', 'user', '下一个问题']);
  mirror.statusChanged(store.session(member.id)!);
  await until(() => changes === 2);
  messages = store.groupDetail(topic.id).messages.filter(item => item.via === member.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[1]!.text, '定稿'); assert.ok(messages[1]!.closedAt);
  // Group members are never mirrored.
  const group = store.addGroup('G', '');
  const other = store.addSession({ backend: 'codex', title: 'B', cwd: '/b', groupId: group.id, status: 'waiting_input' });
  mirror.statusChanged(other); await delay(30);
  assert.equal(store.groupDetail(group.id).messages.length, 0);
});
