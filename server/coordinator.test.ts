import test from 'node:test';
import assert from 'node:assert/strict';
import type { BackendInfo } from '../shared/types.ts';
import { Store } from './store.ts';
import { Coordinator } from './coordinator.ts';
import { ImHub, chunks, parseCommand, plainText, type ImAdapter, type ImBinding } from './im/hub.ts';

type Body = { model: string; messages: { role: string; content?: string; tool_calls?: unknown[] }[]; tools?: { function: { name: string } }[] };
/** A scripted OpenAI-compatible endpoint: each call returns the next reply. */
function fakeModel(script: ((body: Body) => { content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] })[]) {
  const calls: Body[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://llm.example/v1/chat/completions');
    assert.equal((init.headers as Record<string, string>).authorization, 'Bearer test-key');
    const body = JSON.parse(String(init.body)) as Body;
    calls.push(body);
    const next = script.shift();
    if (!next) return new Response('no more', { status: 500 });
    return Response.json({ choices: [{ message: { role: 'assistant', ...next(body) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}
const backends = [{ id: 'codex', label: 'Codex', installed: true, capabilities: { fork: true } }] as unknown as BackendInfo[];
function setup(script: Parameters<typeof fakeModel>[0], api: { baseUrl: string; apiKey: string } | null = { baseUrl: 'https://llm.example/v1', apiKey: 'test-key' }) {
  const store = new Store(':memory:');
  const model = fakeModel(script);
  const delivered: string[] = [];
  const coordinator = new Coordinator({ store, api: async () => api, backends: () => backends, defaultCwd: () => '/tmp', readTranscript: async () => ({ messages: [{ id: 'm', role: 'assistant', text: '进度：完成一半' }], truncated: false }), deliver: async id => { delivered.push(id); store.updateDelivery(id, 'sent'); }, onChange() {}, fetcher: model.fetcher });
  return { store, coordinator, model, delivered };
}

test('the coordinator answers a topic message with topic context and tools, then counts once as new', async t => {
  const { store, coordinator, model } = setup([
    () => ({ content: '', tool_calls: [{ id: 'c1', function: { name: 'read_message', arguments: '{"n":1}' } }] }),
    body => { assert.match(String(body.messages.at(-1)!.content), /原帖全文/); return { content: '原帖说要先做登录页 [#1]。' }; },
  ]);
  t.after(() => store.close());
  const topic = store.addGroup('登录页', '原帖全文', 'topic');
  store.addMessage({ groupId: topic.id, kind: 'note', senderId: null, senderName: '你', recipientIds: [], text: '原帖全文' });
  const asked = store.addMessage({ groupId: topic.id, kind: 'note', senderId: null, senderName: '你', recipientIds: [], text: '我们之前说先做什么？' });
  coordinator.trigger(topic.id, { type: 'message', messageId: asked.id });
  await coordinator.idle(topic.id);
  const first = model.calls[0]!;
  assert.equal(first.model, 'deepseek-v4-flash');
  assert.match(String(first.messages[0]!.content), /不能执行命令/);
  assert.match(String(first.messages[1]!.content), /标题：登录页[\s\S]*\[#2\] 你（发言）：我们之前说先做什么？[\s\S]*用户说：我们之前说先做什么？/);
  assert.deepEqual(first.tools!.map(tool => tool.function.name).sort(), ['dispatch_task', 'list_contacts', 'list_topics', 'propose_participant', 'read_message', 'read_messages', 'read_participant_history']);
  const answer = store.groupDetail(topic.id).messages.at(-1)!;
  assert.deepEqual([answer.agent, answer.kind, answer.senderName, answer.text, !!answer.pending], ['coordinator', 'reply', '嘀哩', '原帖说要先做登录页 [#1]。', false]);
  assert.equal(answer.sourceMessageId, asked.id);
  assert.equal(store.group(topic.id)!.unread, 1);
  assert.equal(store.group(topic.id)!.lastMessage?.senderName, '嘀哩');
});

test('dispatching delivers a coordinator task, and settled replies trigger one summary', async t => {
  const ids: { member?: string; outsider?: string } = {};
  const { store, coordinator, model, delivered } = setup([
    () => ({ content: '', tool_calls: [{ id: 'bad', function: { name: 'dispatch_task', arguments: JSON.stringify({ participant_ids: [ids.outsider], text: 'x' }) } }, { id: 'ok', function: { name: 'dispatch_task', arguments: JSON.stringify({ participant_ids: [ids.member], text: '实现登录页' }) } }] }),
    body => { const results = body.messages.filter(item => item.role === 'tool').map(item => String(item.content)); assert.match(results[0]!, /只能派给当前话题的参与者/); assert.match(results[1]!, /前端：已发送/); return { content: '已交给前端。' }; },
    body => { assert.match(String(body.messages[1]!.content), /系统通知：你派给 前端 的任务/); return { content: '前端完成了：登录页已上线。' }; },
  ]);
  t.after(() => store.close());
  const topic = store.addGroup('T', '', 'topic');
  ids.member = store.addSession({ backend: 'codex', title: '前端', cwd: '/a', groupId: topic.id }).id;
  ids.outsider = store.addSession({ backend: 'codex', title: '别人', cwd: '/b' }).id;
  const asked = store.addMessage({ groupId: topic.id, kind: 'note', senderId: null, senderName: '你', recipientIds: [], text: '让前端做登录页' });
  coordinator.trigger(topic.id, { type: 'message', messageId: asked.id });
  await coordinator.idle(topic.id);
  const task = store.groupDetail(topic.id).messages.find(item => item.kind === 'task')!;
  assert.deepEqual([task.agent, task.senderName, task.recipientIds, task.awaitSummary], ['coordinator', '嘀哩', [ids.member], true]);
  assert.equal(delivered.length, 1);
  assert.match(store.delivery(delivered[0]!)!.text, /^【话题】/);
  // Not settled yet: no summary.
  coordinator.repliesChanged(); await coordinator.idle(topic.id);
  assert.equal(model.calls.length, 2);
  store.addReply(delivered[0]!, { text: '登录页已上线' });
  coordinator.repliesChanged(); coordinator.repliesChanged();
  await coordinator.idle(topic.id);
  assert.equal(model.calls.length, 3);
  assert.equal(store.groupDetail(topic.id).messages.at(-1)!.text, '前端完成了：登录页已上线。');
  assert.equal(store.message(task.id)!.awaitSummary, undefined);
});

test('without a configured API the coordinator says how to set one up; model errors are reported', async t => {
  const missing = setup([], null);
  t.after(() => missing.store.close());
  const topic = missing.store.addGroup('T', '', 'topic');
  const asked = missing.store.addMessage({ groupId: topic.id, kind: 'note', senderId: null, senderName: '你', recipientIds: [], text: '在吗' });
  missing.coordinator.trigger(topic.id, { type: 'message', messageId: asked.id });
  await missing.coordinator.idle(topic.id);
  const answer = missing.store.groupDetail(topic.id).messages.at(-1)!;
  assert.match(answer.text, /配置 API/); assert.equal(answer.failed, true);
  // Group chats never get a coordinator.
  const group = missing.store.addGroup('G', '');
  missing.coordinator.trigger(group.id, { type: 'message', messageId: asked.id });
  await missing.coordinator.idle(group.id);
  assert.equal(missing.store.groupDetail(group.id).messages.length, 0);
  const broken = setup([]);
  t.after(() => broken.store.close());
  const other = broken.store.addGroup('T', '', 'topic');
  const question = broken.store.addMessage({ groupId: other.id, kind: 'note', senderId: null, senderName: '你', recipientIds: [], text: '在吗' });
  broken.coordinator.trigger(other.id, { type: 'message', messageId: question.id });
  await broken.coordinator.idle(other.id);
  assert.match(broken.store.groupDetail(other.id).messages.at(-1)!.text, /嘀哩暂时无法回复：模型接口返回 500/);
});

test('proposals wait for the user; only real contacts and installed backends qualify', async t => {
  const { store, coordinator } = setup([
    () => ({ content: '', tool_calls: [
      { id: 'a', function: { name: 'propose_participant', arguments: JSON.stringify({ contact_id: 'nope', reason: 'r' }) } },
      { id: 'b', function: { name: 'propose_participant', arguments: JSON.stringify({ backend: 'claude', title: '设计', reason: 'r' }) } },
      { id: 'c', function: { name: 'propose_participant', arguments: JSON.stringify({ backend: 'codex', title: '后端', reason: '需要写接口' }) } },
    ] }),
    body => { const results = body.messages.filter(item => item.role === 'tool').map(item => String(item.content)); assert.match(results[0]!, /没有这个会话/); assert.match(results[1]!, /后端无效或未安装/); assert.match(results[2]!, /已创建提议 P-[0-9a-f]{4}/); return { content: '我提议新建「后端」，请批准。' }; },
  ]);
  t.after(() => store.close());
  const topic = store.addGroup('T', '', 'topic');
  const asked = store.addMessage({ groupId: topic.id, kind: 'note', senderId: null, senderName: '你', recipientIds: [], text: '需要后端' });
  coordinator.trigger(topic.id, { type: 'message', messageId: asked.id });
  await coordinator.idle(topic.id);
  const proposal = store.groupDetail(topic.id).messages.find(item => item.proposal)!.proposal!;
  assert.deepEqual([proposal.status, proposal.create], ['pending', { backend: 'codex', title: '后端', cwd: '/tmp' }]);
  assert.equal(store.sessions().length, 0);
});

test('IM chats pair with a code, then reach the coordinator in their topic; commands stay deterministic', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const bindings = new Map<string, ImBinding>();
  const triggered: { topic: string; messageId: string }[] = [];
  const sent: string[] = [];
  let now = Date.parse('2026-11-15T00:00:00Z');
  const hub = new ImHub({ store, coordinator: { trigger: (topic, trigger) => { if (trigger.type === 'message') triggered.push({ topic, messageId: trigger.messageId }); } },
    binding: kind => bindings.get(kind) ?? { owners: [], chats: {} }, saveBinding: (kind, binding) => bindings.set(kind, binding),
    decideProposal: async () => { throw new Error('提议不存在'); }, onChange() {}, now: () => now });
  const adapter: ImAdapter = { kind: 'feishu', send: async (_chat, text) => { sent.push(text); } };
  hub.register(adapter);
  const inbound = (text: string, id: string, sender = 'ou_owner') => hub.receive({ channel: 'feishu', chatId: 'oc_1', senderId: sender, messageId: id, text });
  await inbound('你好', 'm0');
  assert.equal(sent.length, 0); assert.equal(triggered.length, 0);
  const code = hub.newPairCode('feishu');
  await inbound(code, 'm1');
  assert.deepEqual(bindings.get('feishu')!.owners, ['ou_owner']);
  assert.match(sent.at(-1)!, /已绑定/);
  await inbound('帮我看看登录页进度', 'm2');
  await inbound('帮我看看登录页进度', 'm2');
  assert.equal(triggered.length, 1);
  const topic = store.group(triggered[0]!.topic)!;
  assert.deepEqual([topic.kind, topic.title], ['topic', '飞书 · 嘀哩']);
  assert.equal(store.message(triggered[0]!.messageId)!.channel, 'feishu');
  await inbound('/新话题 发布计划', 'm3');
  assert.match(sent.at(-1)!, /已新建并切换到：发布计划/);
  await inbound('/话题', 'm4');
  assert.match(sent.at(-1)!, /\d\. 发布计划（当前）/);
  await inbound('同意 P-ABCD', 'm5');
  assert.equal(sent.at(-1), '提议不存在');
  // A stranger, or a group message without a mention, is ignored.
  await inbound('hi', 'm6', 'ou_stranger');
  await hub.receive({ channel: 'feishu', chatId: 'oc_2', senderId: 'ou_owner', messageId: 'm7', text: 'hi', group: true, mentioned: false });
  assert.equal(triggered.length, 1);
  // An expired code pairs no one.
  const late = hub.newPairCode('feishu'); now += 11 * 60_000;
  await inbound(late, 'm8', 'ou_late');
  assert.deepEqual(bindings.get('feishu')!.owners, ['ou_owner']);
  // Answers go back to chats whose current topic it is.
  const current = bindings.get('feishu')!.chats.oc_1!.topicId;
  await hub.coordinatorAnswered(current, { text: '**完成**\n# 标题' } as never, [{ type: 'message', messageId: 'x', channel: 'feishu' }]);
  assert.equal(sent.at(-1), '完成\n标题');
});

test('IM text helpers parse commands and fit transport limits', () => {
  assert.deepEqual(parseCommand('同意 p-3F9A'), { type: 'decide', proposalId: 'P-3f9a', approve: true });
  assert.deepEqual(parseCommand('拒绝P-3f9a'), { type: 'decide', proposalId: 'P-3f9a', approve: false });
  assert.deepEqual(parseCommand('/切换 2'), { type: 'switch', target: '2' });
  assert.equal(parseCommand('普通消息'), null);
  assert.equal(plainText('看 [文档](https://x.y/z) 和 `code`'), '看 文档 https://x.y/z 和 code');
  const parts = chunks('a'.repeat(1000) + '\n\n' + 'b'.repeat(1500), 1800);
  assert.equal(parts.length, 2); assert.ok(parts.every(part => part.length <= 1800));
});
