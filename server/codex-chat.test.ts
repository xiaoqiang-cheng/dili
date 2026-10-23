import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Attachments } from './attachments.ts';
import { ChatSubmissions } from './chat-submissions.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';
import express from 'express';
import { CodexBridge } from './codex.ts';
import { CodexChatState, nativeChatAnswer, nativeChatRequest } from './codex-chat.ts';
import { registerAgentChat } from './chat-api.ts';
import { ConversationReader } from './conversation.ts';
import { Store } from './store.ts';

function testAttachments(t: test.TestContext, store: Store) { const directory = mkdtempSync(join(tmpdir(), 'dili-chat-images-')); t.after(() => rmSync(directory, {recursive:true,force:true})); return new Attachments(store.db,directory); }

type Message = { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
async function until(check: () => boolean) { for (let i = 0; i < 150; i++) { if (check()) return; await delay(5); } assert.fail('Native chat fixture did not reach expected state'); }
async function fixture(t: test.TestContext) {
  const threadId = randomUUID(), turnId = randomUUID(), server = new WebSocketServer({ port: 0 });
  const sockets = new Set<WebSocket>(), calls: { message: Message; socket: WebSocket }[] = [];
  let observer: WebSocket | undefined;
  let thread: Record<string, unknown> = { id: threadId, cwd: '/tmp', status: { type: 'idle' }, turns: [] };
  let intercept: ((socket: WebSocket, message: Message) => boolean) | undefined;
  server.on('connection', socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString()) as Message;
      calls.push({ message, socket });
      if (!message.method || message.id === undefined) return;
      if (message.method === 'thread/resume') observer = socket;
      if (intercept?.(socket, message)) return;
      const result = message.method === 'thread/turns/list' ? { data: [...(thread.turns as unknown[])].reverse(), nextCursor: null } : message.method === 'thread/read' || message.method === 'thread/resume' ? { thread } : message.method === 'turn/start' ? { turn: { id: turnId, status: 'inProgress', items: [] } } : {};
      socket.send(JSON.stringify({ id: message.id, result }));
    });
  });
  await new Promise<void>(accept => server.once('listening', accept));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const bridge = new CodexBridge({ manageProcess: false, remoteUrl: `ws://127.0.0.1:${address.port}`, remoteToken: 'chat-fixture' });
  t.after(async () => { await bridge.close(); for (const socket of sockets) socket.terminate(); await new Promise<void>(accept => server.close(() => accept())); });
  return { threadId, turnId, bridge, calls,
    observer: () => { assert.ok(observer); return observer; },
    setThread: (next: Record<string, unknown>) => { thread = next; },
    intercept: (handler?: typeof intercept) => { intercept = handler; },
    send: async (method: string, params: Record<string, unknown>, id?: string | number) => { assert.ok(observer); observer.send(JSON.stringify({ method, params: { threadId, ...params }, ...(id !== undefined ? { id } : {}) })); await delay(10); },
  };
}

test('Codex graphical read never resumes; prompt keeps its observer and streams native items', async t => {
  const f = await fixture(t), { bridge, threadId, turnId } = f;
  await assert.rejects(bridge.readChat(threadId), /先打开/);
  assert.equal(f.calls.length, 0);
  await bridge.start();
  assert.equal((await bridge.readChat(threadId)).connected, false);
  assert.equal(f.calls.some(call => call.message.method === 'thread/resume'), false);
  await bridge.openSession(threadId, '/tmp');
  const resume = f.calls.find(call => call.message.method === 'thread/resume');
  assert.equal(resume?.message.params?.excludeTurns, true);
  const changes: number[] = [];
  const unsubscribe = bridge.onChat((id, snapshot) => { assert.equal(id, threadId); changes.push(snapshot.revision); });
  t.after(unsubscribe);
  assert.deepEqual(await bridge.sendPrompt(threadId, '修复当前按钮'), { turnId });
  const start = f.calls.find(call => call.message.method === 'turn/start')!;
  assert.equal(start.socket, f.observer());
  assert.deepEqual(start.message.params, { threadId, input: [{ type: 'text', text: '修复当前按钮', text_elements: [] }] });
  await assert.rejects(bridge.sendPrompt(threadId, 'duplicate'), /仍在执行/);
  await f.send('item/started', { turnId, item: { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: '修复当前按钮' }] } });
  await f.send('item/started', { turnId, item: { id: 'answer', type: 'agentMessage', text: '' } });
  await f.send('item/agentMessage/delta', { turnId, itemId: 'answer', delta: '正在检查' });
  await f.send('item/agentMessage/delta', { turnId, itemId: 'answer', delta: '按钮。' });
  await f.send('item/started', { turnId, item: { id: 'cmd', type: 'commandExecution', command: 'npm test', status: 'inProgress' } });
  await f.send('item/commandExecution/outputDelta', { turnId, itemId: 'cmd', delta: 'PASS\n' });
  await f.send('item/completed', { turnId, item: { id: 'cmd', type: 'commandExecution', command: 'npm test', status: 'completed', aggregatedOutput: 'PASS\n' } });
  await f.send('item/fileChange/patchUpdated', { turnId, itemId: 'file', changes: [{ path: 'app.ts', kind: { type: 'update' }, diff: '-broken\n+fixed' }] });
  await f.send('turn/plan/updated', { turnId, explanation: '修复计划', plan: [{ step: '测试', status: 'completed' }] });
  await f.send('item/started', { turnId, item: { id: 'mcp', type: 'mcpToolCall', server: 'docs', tool: 'search', status: 'inProgress', arguments: { query: 'button' } } });
  await f.send('item/mcpToolCall/progress', { turnId, itemId: 'mcp', message: '已找到文档' });
  assert.equal(bridge.chatSnapshot(threadId)!.items.find(item => item.id === 'mcp')?.output, '已找到文档');
  await f.send('item/completed', { turnId, item: { id: 'mcp', type: 'mcpToolCall', server: 'docs', tool: 'search', status: 'completed', arguments: { query: 'button' }, result: { content: [{ type: 'text', text: '文档结果' }] } } });
  await f.send('item/completed', { turnId, item: { id: 'answer', type: 'agentMessage', text: '已修复。' } });
  await f.send('turn/completed', { turn: { id: turnId, status: 'completed', items: [] } });
  const view = bridge.chatSnapshot(threadId)!;
  assert.equal(view.connected, true); assert.equal(view.activeTurnId, null);
  assert.equal(view.items.find(item => item.id === 'answer')?.text, '已修复。');
  assert.equal(view.items.find(item => item.id === 'cmd')?.output, 'PASS\n');
  assert.equal(view.items.find(item => item.id === 'file')?.output, 'app.ts\n-broken\n+fixed');
  assert.ok(view.items.some(item => item.type === 'plan' && item.text.includes('✓ 测试')));
  assert.ok(changes.length >= 10); assert.ok(changes.every((value, index) => index === 0 || value > changes[index - 1]));
});

test('Codex native approval is explicit, bound to one observer and claimed once across tabs', async t => {
  const f = await fixture(t), { bridge, threadId, turnId } = f;
  await bridge.openSession(threadId);
  await f.send('item/commandExecution/requestApproval', { turnId, itemId: 'cmd', command: 'npm test', cwd: '/tmp', reason: '需要运行测试', availableDecisions: ['accept', 'decline'] }, 90);
  const request = bridge.chatSnapshot(threadId)!.requests[0];
  assert.equal(request.kind, 'approval'); assert.equal(request.options?.length, 2);
  assert.equal(f.calls.filter(call => !call.message.method).length, 0);
  await assert.rejects(bridge.answerChatRequest(randomUUID(), request.id, { decision: request.options![0].id }), /失效/);
  await assert.rejects(bridge.answerChatRequest(threadId, request.id, { decision: 'acceptForSession' }), /当前原生请求/);
  await assert.rejects(bridge.sendPrompt(threadId, 'while waiting'), /等待答复/);
  const answers = await Promise.allSettled([bridge.answerChatRequest(threadId, request.id, { decision: request.options![0].id }), bridge.answerChatRequest(threadId, request.id, { decision: request.options![0].id })]);
  assert.equal(answers.filter(answer => answer.status === 'fulfilled').length, 1);
  await until(() => f.calls.some(call => call.message.id === 90 && !call.message.method));
  assert.deepEqual(f.calls.filter(call => call.message.id === 90 && !call.message.method).map(call => call.message.result), [{ decision: 'accept' }]);
  assert.equal(bridge.chatSnapshot(threadId)!.requests.length, 0);
  await f.send('item/commandExecution/requestApproval', { turnId, itemId: 'cmd', command: 'npm test', availableDecisions: ['accept', 'decline'] }, 90);
  assert.equal(bridge.chatSnapshot(threadId)!.requests.length, 0, 'Replayed request cannot resurrect an already submitted answer');
  await f.send('serverRequest/resolved', { requestId: 90 });
  await f.send('item/fileChange/requestApproval', { turnId, itemId: 'file', reason: '修改文件' }, 'other-client');
  const other = bridge.chatSnapshot(threadId)!.requests[0];
  await f.send('serverRequest/resolved', { requestId: 'other-client' });
  assert.equal(bridge.chatSnapshot(threadId)!.requests.length, 0);
  await assert.rejects(bridge.answerChatRequest(threadId, other.id, { decision: 'decision-0' }), /失效/);
});

test('Codex question and permission replies use only native offered fields', async t => {
  const f = await fixture(t), { bridge, threadId, turnId } = f;
  await bridge.openSession(threadId);
  await f.send('item/tool/requestUserInput', { turnId, itemId: 'question', isBlocking: true, questions: [{ id: 'choice', header: '选择', question: '选择哪一种？', isOther: false, isSecret: false, options: [{ label: 'A', description: '第一种' }, { label: 'B', description: '第二种' }] }, { id: 'detail', header: '说明', question: '补充内容', isOther: true, isSecret: false, options: null }] }, 'question-1');
  const request = bridge.chatSnapshot(threadId)!.requests[0];
  await assert.rejects(bridge.answerChatRequest(threadId, request.id, { answers: { choice: ['C'], detail: ['补充'] } }), /选项/);
  await assert.rejects(bridge.answerChatRequest(threadId, request.id, { answers: { choice: ['A'] } }), /完整/);
  await bridge.answerChatRequest(threadId, request.id, { answers: { choice: ['B'], detail: ['我的补充'] } });
  await until(() => f.calls.some(call => call.message.id === 'question-1' && !call.message.method));
  assert.deepEqual(f.calls.find(call => call.message.id === 'question-1' && !call.message.method)!.message.result, { answers: { choice: { answers: ['B'] }, detail: { answers: ['我的补充'] } } });
  await f.send('item/permissions/requestApproval', { turnId, itemId: 'permissions', cwd: '/tmp', reason: '网络访问', permissions: { network: { enabled: true }, fileSystem: null } }, 91);
  const permissions = bridge.chatSnapshot(threadId)!.requests[0];
  await bridge.answerChatRequest(threadId, permissions.id, { decision: permissions.options![0].id });
  await until(() => f.calls.some(call => call.message.id === 91 && !call.message.method));
  assert.deepEqual(f.calls.find(call => call.message.id === 91 && !call.message.method)!.message.result, { permissions: { network: { enabled: true } }, scope: 'turn' });
});

test('Codex unsupported requests remain visible, stop interrupts, and disconnect invalidates replies', async t => {
  const f = await fixture(t), { bridge, threadId, turnId } = f;
  await bridge.openSession(threadId);
  await f.send('turn/started', { turn: { id: turnId, status: 'inProgress' } });
  await f.send('mcpServer/elicitation/request', { turnId, serverName: 'fixture' }, 'unsupported');
  const unsupported = bridge.chatSnapshot(threadId)!.requests[0];
  assert.equal(unsupported.kind, 'unsupported');
  await assert.rejects(bridge.answerChatRequest(threadId, unsupported.id, {}), /暂不支持/);
  await bridge.stopSession(threadId);
  assert.equal(bridge.chatSnapshot(threadId)!.requests.length, 0);
  assert.equal(bridge.chatSnapshot(threadId)!.activeTurnId, null);
  assert.deepEqual(f.calls.find(call => call.message.method === 'turn/interrupt')!.message.params, { threadId, turnId });
  await f.send('item/fileChange/requestApproval', { turnId, itemId: 'file' }, 'disconnected');
  const pending = bridge.chatSnapshot(threadId)!.requests[0];
  f.observer().terminate();
  await until(() => bridge.chatSnapshot(threadId)?.connected === false);
  assert.equal(bridge.chatSnapshot(threadId)!.requests.length, 0);
  await assert.rejects(bridge.answerChatRequest(threadId, pending.id, { decision: 'decision-0' }), /失效/);
  assert.equal(f.calls.some(call => !call.message.method), false);
});

test('Codex history read reconciles live deltas without overwriting completed output', async t => {
  const f = await fixture(t), { bridge, threadId, turnId } = f;
  await bridge.openSession(threadId);
  await f.send('turn/started', { turn: { id: turnId, status: 'inProgress' } });
  await f.send('item/started', { turnId, item: { id: 'a', type: 'agentMessage', text: 'old' } });
  let release: (() => void) | undefined;
  f.intercept((socket, message) => {
    if (message.method !== 'thread/turns/list') return false;
    release = () => socket.send(JSON.stringify({ id: message.id, result: { data: [{ id: turnId, status: 'inProgress', items: [{ type: 'agentMessage', id: 'a', text: 'old' }] }], nextCursor: null } }));
    return true;
  });
  const reading = bridge.readChat(threadId);
  await until(() => !!release);
  await f.send('item/agentMessage/delta', { turnId, itemId: 'a', delta: ' + live' });
  await f.send('item/completed', { turnId, item: { id: 'a', type: 'agentMessage', text: 'final answer' } });
  await f.send('turn/completed', { turn: { id: turnId, status: 'completed' } });
  release!();
  const result = await reading;
  assert.equal(result.items[0].text, 'final answer'); assert.equal(result.items[0].status, 'completed'); assert.equal(result.activeTurnId, null);
  await f.send('item/agentMessage/delta', { turnId, itemId: 'a', delta: ' stale' });
  assert.equal(bridge.chatSnapshot(threadId)!.items[0].text, 'final answer');
});

test('Codex history reconciliation folds one live prompt and its differently identified history copy', () => {
  const state = new CodexChatState(), id = randomUUID(), turnId = randomUUID();
  state.connected(id, true);
  const basis = state.get(id)!.revision;
  state.event(id, 'item/started', { turnId, item: { id: 'live-user', type: 'userMessage', content: [{ type: 'text', text: 'extends 默认填写列表怎么理解？有点容易让人困惑' }] } });
  const snapshot = state.reconcile(id, { id, turns: [{ id: turnId, status: 'inProgress', items: [{ id: 'history-user', type: 'userMessage', content: [{ type: 'text', text: 'extends 默认填写列表怎么理解？有点容易让人困惑' }] }] }] }, basis, true);
  assert.equal(snapshot.items.filter(item => item.type === 'user').length, 1);
  assert.equal(snapshot.items[0].id, 'live-user', 'the live item identity remains available for later patches');
});

test('Codex keeps a live prompt identity when history resolves before item/completed', () => {
  const state = new CodexChatState(), id = randomUUID(), turnId = randomUUID();
  const text = '发送后触发了历史刷新';

  state.event(id, 'item/started', { turnId, item: { id: 'live-user', type: 'userMessage', content: [{ type: 'text', text }] } });
  const basis = state.get(id)!.revision;
  const duringRead = state.reconcile(id, { id, turns: [{ id: turnId, status: 'inProgress', items: [
    { id: 'history-user', type: 'userMessage', content: [{ type: 'text', text }] },
  ] }] }, basis, true);
  assert.deepEqual(duringRead.items.filter(item => item.type === 'user').map(item => item.id), ['live-user']);

  state.event(id, 'item/completed', { turnId, item: { id: 'live-user', type: 'userMessage', content: [{ type: 'text', text }] } });
  assert.deepEqual(state.get(id)!.items.filter(item => item.type === 'user').map(item => item.id), ['live-user']);
});

test('Codex history reconciliation preserves a deliberate repeated prompt already present before the read', () => {
  const state = new CodexChatState(), id = randomUUID(), turnId = randomUUID();
  const text = 'repeat this prompt';
  state.reconcile(id, { id, turns: [{ id: turnId, status: 'inProgress', items: [{ id: 'first-user', type: 'userMessage', content: [{ type: 'text', text }] }] }] }, 0, true);
  const basis = state.get(id)!.revision;
  state.event(id, 'item/started', { turnId, item: { id: 'second-live-user', type: 'userMessage', content: [{ type: 'text', text }] } });
  const snapshot = state.reconcile(id, { id, turns: [{ id: turnId, status: 'inProgress', items: [
    { id: 'first-user', type: 'userMessage', content: [{ type: 'text', text }] },
    { id: 'second-history-user', type: 'userMessage', content: [{ type: 'text', text }] },
  ] }] }, basis, true);
  assert.deepEqual(snapshot.items.filter(item => item.type === 'user').map(item => item.id), ['first-user', 'second-live-user']);
});

test('Codex replays approval during resume and does not resurrect turns completed before send acknowledgment', async t => {
  const f = await fixture(t), { bridge, threadId, turnId } = f;
  f.intercept((socket, message) => {
    if (message.method === 'thread/resume') socket.send(JSON.stringify({ id: 'resume-approval', method: 'item/fileChange/requestApproval', params: { threadId, turnId, itemId: 'file' } }));
    if (message.method !== 'turn/start') return false;
    socket.send(JSON.stringify({ method: 'turn/started', params: { threadId, turn: { id: turnId } } }));
    socket.send(JSON.stringify({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } }));
    socket.send(JSON.stringify({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } }));
    return true;
  });
  await bridge.openSession(threadId);
  assert.equal(bridge.chatSnapshot(threadId)!.requests.length, 1);
  await f.send('serverRequest/resolved', { requestId: 'resume-approval' });
  await bridge.sendPrompt(threadId, 'fast response');
  assert.equal(bridge.chatSnapshot(threadId)!.activeTurnId, null);
  assert.equal((await bridge.getStatus(threadId)).status, 'waiting_input');
});

test('Codex distinguishes rejected turn starts from a connection lost after dispatch', async t => {
  const f = await fixture(t), { bridge, threadId } = f;
  await bridge.openSession(threadId);
  f.intercept((socket, message) => { if (message.method !== 'turn/start') return false; socket.send(JSON.stringify({ id: message.id, error: { code: -1, message: 'fixture rejection' } })); return true; });
  await assert.rejects(bridge.sendPrompt(threadId, 'rejected'), error => (error as Error & { deliveryUnknown: boolean }).deliveryUnknown === false);
  f.intercept((socket, message) => { if (message.method !== 'turn/start') return false; socket.terminate(); return true; });
  await assert.rejects(bridge.sendPrompt(threadId, 'uncertain'), error => (error as Error & { deliveryUnknown: boolean }).deliveryUnknown === true);
});

test('a turn completed during resume wins over the older resume response for chat and native status', async t => {
  const f = await fixture(t), { bridge, threadId, turnId } = f;
  const statuses: string[] = [];
  const remove = bridge.onStatus((_id, event) => statuses.push(event.status)); t.after(remove);
  f.intercept((socket, message) => {
    if (message.method !== 'thread/resume') return false;
    socket.send(JSON.stringify({ method: 'turn/started', params: { threadId, turn: { id: turnId } } }));
    socket.send(JSON.stringify({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } }));
    socket.send(JSON.stringify({ id: message.id, result: { thread: { id: threadId, status: { type: 'active' }, turns: [{ id: turnId, status: 'inProgress', items: [] }] } } }));
    return true;
  });
  await bridge.openSession(threadId);
  assert.equal(bridge.chatSnapshot(threadId)!.activeTurnId, null);
  assert.equal(statuses.at(-1), 'waiting_input');
});

test('concurrent graph opens share an in-flight native resume and cannot submit before it finishes', async t => {
  const f = await fixture(t), { bridge, threadId } = f;
  let release: (() => void) | undefined;
  f.intercept((socket, message) => {
    if (message.method !== 'thread/resume') return false;
    release = () => socket.send(JSON.stringify({ id: message.id, result: { thread: { id: threadId, turns: [], status: { type: 'idle' } } } }));
    return true;
  });
  const first = bridge.openSession(threadId);
  await until(() => !!release);
  let secondDone = false;
  const second = bridge.openSession(threadId).then(() => { secondDone = true; });
  await delay(15);
  assert.equal(secondDone, false);
  await assert.rejects(bridge.sendPrompt(threadId, 'too early'), /连接/);
  release!(); await Promise.all([first, second]);
  assert.equal(f.calls.filter(call => call.message.method === 'thread/resume').length, 1);
  assert.equal(bridge.chatSnapshot(threadId)!.connected, true);
});

test('a read racing an intentional stop cannot restart the native server or create a new socket', async t => {
  const f = await fixture(t), { bridge, threadId } = f;
  await bridge.start();
  const before = f.calls.length;
  let starts = 0;
  const original = bridge.start.bind(bridge);
  bridge.start = async () => { starts++; await original(); };
  const reading = bridge.readChat(threadId);
  const stopped = bridge.stop();
  await assert.rejects(reading, /已停止/);
  await stopped;
  assert.equal(starts, 0);
  assert.equal(f.calls.length, before);
  assert.equal(bridge.remoteToken, null);
});

test('Codex view bounds items and tool output, keeps internal reasoning out and preserves later history snapshots', () => {
  const state = new CodexChatState(), id = randomUUID(), turnId = randomUUID();
  state.connected(id, true);
  for (let i = 0; i < 250; i++) state.event(id, 'item/completed', { turnId, item: { id: `a-${i}`, type: 'agentMessage', text: String(i) } });
  state.event(id, 'item/completed', { turnId, item: { id: 'private', type: 'reasoning', content: ['hidden'] } });
  assert.equal(state.get(id)!.items.length, 200); assert.equal(state.get(id)!.truncated, true);
  for (let i = 0; i < 12; i++) state.event(id, 'item/completed', { turnId, item: { id: `cmd-${i}`, type: 'commandExecution', command: 'cmd', aggregatedOutput: 'x'.repeat(100_000) } });
  assert.ok(state.get(id)!.items.every(item => (item.output?.length ?? 0) <= 64_000));
  assert.ok(state.get(id)!.items.reduce((sum, item) => sum + item.text.length + (item.output?.length ?? 0) + (item.title?.length ?? 0), 0) <= 512_000);
  const before = state.get(id)!.revision;
  state.reconcile(id, { id, turns: [{ id: turnId, status: 'completed', items: [{ type: 'agentMessage', id: 'same', text: 'newer history' }] }] }, before, true);
  state.reconcile(id, { id, turns: [{ id: turnId, status: 'inProgress', items: [{ type: 'agentMessage', id: 'same', text: 'old history' }] }] }, before, true);
  assert.equal(state.get(id)!.items.find(item => item.id === 'same')?.text, 'newer history');
  assert.equal(state.get(id)!.activeTurnId, null);
});

test('native permission rejection cannot accept arbitrary grant JSON or an unoffered decision', () => {
  const request = nativeChatRequest('item/permissions/requestApproval', 1, { permissions: { network: { enabled: true }, fileSystem: null } });
  assert.deepEqual(nativeChatAnswer(request, { decision: 'decision-2' }), { permissions: {}, scope: 'turn' });
  assert.throws(() => nativeChatAnswer(request, { decision: 'accept' }), /当前原生请求/);
  const huge = nativeChatRequest('item/permissions/requestApproval', 2, { permissions: { fileSystem: { read: ['x'.repeat(130_000)] } } });
  assert.equal(huge.view.kind, 'unsupported'); assert.equal(huge.decisions.size, 0);
});

test('recent history is paginated, ordered and shared by concurrent readers instead of requesting all turns', async t => {
  const f = await fixture(t), { bridge, threadId } = f;
  await bridge.start();
  let release: (() => void) | undefined;
  f.intercept((socket, message) => {
    if (message.method !== 'thread/turns/list') return false;
    assert.deepEqual(message.params, { threadId, itemsView: 'full', sortDirection: 'desc', limit: 20 });
    release = () => socket.send(JSON.stringify({ id: message.id, result: { data: [
      { id: 'new', status: 'completed', items: [{ id: 'new-user', type: 'userMessage', content: [{ type: 'text', text: 'latest' }] }] },
      { id: 'old', status: 'completed', items: [{ id: 'old-user', type: 'userMessage', content: [{ type: 'text', text: 'older' }] }] },
    ], nextCursor: 'opaque-older-cursor' } }));
    return true;
  });
  const first = bridge.readChat(threadId), second = bridge.readChat(threadId);
  await until(() => !!release);
  assert.equal(f.calls.filter(call => call.message.method === 'thread/turns/list').length, 1);
  release!();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b); assert.deepEqual(a.items.map(item => item.text), ['older', 'latest']);
  assert.equal(a.historyCursor, 'opaque-older-cursor'); assert.equal(a.truncated, true);
  assert.equal(await bridge.readChat(threadId), a);
  assert.equal(f.calls.some(call => call.message.method === 'thread/read' && call.message.params?.includeTurns), false);
});

test('older native pages never replace live output, active turns or pending approvals', async t => {
  const f = await fixture(t), { bridge, threadId, turnId } = f;
  await bridge.openSession(threadId);
  await f.send('turn/started', { turn: { id: turnId, status: 'inProgress' } });
  await f.send('item/started', { turnId, item: { id: 'live-answer', type: 'agentMessage', text: 'live' } });
  await f.send('item/fileChange/requestApproval', { turnId, itemId: 'file' }, 'pending-approval');
  const before = bridge.chatSnapshot(threadId)!;
  f.intercept((socket, message) => {
    if (message.method !== 'thread/turns/list') return false;
    assert.equal(message.params?.cursor, 'older-cursor');
    socket.send(JSON.stringify({ id: message.id, result: { data: [{ id: 'old-turn', status: 'completed', items: [{ id: 'old-user', type: 'userMessage', content: [{ type: 'text', text: 'old request' }] }] }], nextCursor: null } }));
    return true;
  });
  const [page, samePage] = await Promise.all([bridge.readChatHistory(threadId, 'older-cursor'), bridge.readChatHistory(threadId, 'older-cursor')]);
  assert.equal(page, samePage);
  assert.equal(f.calls.filter(call => call.message.method === 'thread/turns/list').length, 1);
  assert.equal(page.items[0].text, 'old request'); assert.equal(page.nextCursor, null);
  assert.equal(bridge.chatSnapshot(threadId), before);
  assert.equal(before.activeTurnId, turnId); assert.equal(before.requests.length, 1);
  await assert.rejects(bridge.readChatHistory(threadId, ''), /游标/);
});

test('oversized history pages reduce native page size while keeping the live observer usable', async t => {
  const f = await fixture(t), { bridge, threadId } = f;
  await bridge.openSession(threadId);
  f.intercept((socket, message) => {
    if (message.method !== 'thread/turns/list') return false;
    const huge = message.params?.limit === 20;
    socket.send(JSON.stringify({ id: message.id, result: { data: [{ id: 'turn', status: 'completed', items: [{ id: 'reply', type: 'agentMessage', text: huge ? 'x'.repeat(17 * 1024 * 1024) : 'small page' }] }], nextCursor: 'next' } }));
    return true;
  });
  const snapshot = await bridge.readChat(threadId);
  assert.deepEqual(f.calls.filter(call => call.message.method === 'thread/turns/list').map(call => call.message.params?.limit), [20, 5]);
  assert.equal(snapshot.items[0].text, 'small page'); assert.equal(snapshot.connected, true);
  assert.equal(f.observer().readyState, WebSocket.OPEN);
  assert.ok(await bridge.sendPrompt(threadId, 'still works'));
});

test('failed native pagination is cooled down and never falls back to an unbounded native read', async t => {
  const f = await fixture(t), { bridge, threadId } = f;
  await bridge.start();
  f.intercept((socket, message) => {
    if (message.method !== 'thread/turns/list') return false;
    socket.send(JSON.stringify({ id: message.id, error: { code: -32601, message: 'method not found' } }));
    return true;
  });
  await assert.rejects(bridge.readChat(threadId), /method not found/);
  await assert.rejects(bridge.readChat(threadId), /method not found/);
  assert.equal(f.calls.filter(call => call.message.method === 'thread/turns/list').length, 1);
  assert.equal(f.calls.some(call => call.message.method === 'thread/read'), false);
});

test('older pagination rejects a repeated cursor instead of loading the same page forever', async t => {
  const f = await fixture(t), { bridge, threadId } = f;
  await bridge.start();
  f.intercept((socket, message) => {
    if (message.method !== 'thread/turns/list') return false;
    socket.send(JSON.stringify({ id: message.id, result: { data: [], nextCursor: message.params?.cursor } }));
    return true;
  });
  await assert.rejects(bridge.readChatHistory(threadId, 'stuck'), /没有推进/);
});

test('a returning HTTP viewer receives cached messages before the fresh native page is ready', async t => {
  const f = await fixture(t), { bridge, threadId } = f;
  await bridge.start();
  f.setThread({ id: threadId, turns: [{ id: 'history-turn', status: 'completed', items: [{ id: 'cached-user', type: 'userMessage', content: [{ type: 'text', text: 'cached first paint' }] }] }] });
  const store = new Store(':memory:');
  const contact = store.addSession({ backend: 'codex', title: 'cached fixture', cwd: '/tmp', nativeSessionId: threadId });
  const app = express();
  const api = registerAgentChat(app, { attachments: testAttachments(t, store), submissions: new ChatSubmissions(store.db), store, adapters: { codex: bridge }, conversations: new ConversationReader(), instanceId: 'http-fixture', demo: false, closing: () => false, supported: () => true, ready: () => false, busy: () => false, sessions: () => store.sessions(), broadcast: () => {}, updatePreview: () => {} });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/sessions/${contact.id}/chat`;
  const controller = new AbortController();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const original = bridge.readChat.bind(bridge);
  t.after(async () => { release(); controller.abort(); api.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });
  const seeded = await (await fetch(base)).json();
  assert.equal(seeded.items[0].text, 'cached first paint');
  let refreshing = false;
  bridge.readChat = async id => { refreshing = true; await held; return original(id); };
  const stream = await fetch(base + '/events', { signal: controller.signal });
  const reader = stream.body!.getReader();
  try {
    const first = await reader.read();
    assert.equal(refreshing, true);
    assert.match(new TextDecoder().decode(first.value), /event: state[\s\S]*cached first paint/);
  } finally { controller.abort(); reader.releaseLock(); }
});

test('metadata-only native resume retains loaded history and an observed active turn', () => {
  const state = new CodexChatState(), id = randomUUID(), turnId = randomUUID();
  state.reconcile(id, { id, turns: [{ id: turnId, status: 'inProgress', items: [{ id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'Keep my history' }] }] }] }, 0, true, 'older-cursor');
  state.connected(id, false);
  const before = state.get(id)!;
  const after = state.reconcile(id, { id, status: { type: 'active' } }, before.revision, true);
  assert.deepEqual(after.items, before.items);
  assert.equal(after.activeTurnId, turnId);
  assert.equal(after.historyCursor, 'older-cursor');
  assert.equal(after.connected, true);
  const empty = state.reconcile(id, { id, turns: [] }, after.revision, true, null);
  assert.deepEqual(empty.items, []);
  assert.equal(empty.activeTurnId, null, 'Explicit empty history remains authoritative');
});

test('graphical reconnect recovers a lost observer without clearing history or starting a turn', async t => {
  const f = await fixture(t), { bridge, threadId, turnId } = f;
  await bridge.start(); await bridge.openSession(threadId, '/tmp');
  f.setThread({ id: threadId, turns: [{ id: turnId, status: 'completed', items: [{ id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'Saved history' }] }] }] });
  const history = (await bridge.readChat(threadId)).items;
  f.observer().terminate();
  await until(() => !bridge.chatSnapshot(threadId)?.connected);
  f.setThread({ id: threadId, cwd: '/tmp', status: { type: 'idle' } });
  const store = new Store(':memory:');
  const contact = store.addSession({ backend: 'codex', title: 'reconnect fixture', cwd: '/tmp', nativeSessionId: threadId });
  store.updateSession(contact.id, { running: true });
  let busy = false;
  const app = express(); app.use(express.json());
  const api = registerAgentChat(app, { attachments: testAttachments(t, store), submissions: new ChatSubmissions(store.db), store, adapters: { codex: bridge }, conversations: new ConversationReader(), instanceId: 'reconnect-fixture', demo: false, closing: () => false, supported: () => true, ready: () => true, busy: () => busy, sessions: () => store.sessions(), broadcast: () => {}, updatePreview: () => {} });
  app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.status ?? 500).json({ error: error.message }); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  t.after(async () => { api.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });
  const connect = () => fetch(`http://127.0.0.1:${address.port}/api/sessions/${contact.id}/chat/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal((await connect()).status, 200);
  assert.equal(bridge.chatSnapshot(threadId)!.connected, true);
  assert.deepEqual(bridge.chatSnapshot(threadId)!.items, history);
  assert.equal(f.calls.filter(call => ['turn/start', 'turn/interrupt', 'thread/start'].includes(call.message.method ?? '')).length, 0);
  busy = true;
  assert.equal((await connect()).status, 409);
  busy = false; store.updateSession(contact.id, { running: false });
  assert.equal((await connect()).status, 409);
  store.updateSession(contact.id, { running: true });
  f.intercept((socket, message) => {
    if (message.method !== 'thread/read') return false;
    socket.send(JSON.stringify({ id: message.id, error: { message: 'Native read unavailable' } }));
    return true;
  });
  const unavailable = await connect();
  assert.equal(unavailable.status, 503);
  assert.match((await unavailable.json()).error, /Native read unavailable/);
  assert.equal(bridge.chatSnapshot(threadId)!.connected, false);
  assert.deepEqual(bridge.chatSnapshot(threadId)!.items, history);
  f.intercept();
  let entered = false, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const getStatus = bridge.getStatus.bind(bridge);
  bridge.getStatus = async id => { entered = true; await held; return getStatus(id); };
  t.after(() => release());
  const pending = connect();
  await until(() => entered);
  store.updateSession(contact.id, { nativeSessionId: randomUUID() });
  release();
  assert.equal((await pending).status, 409, 'A reconnect cannot claim success after its native identity changes');
});

test('Codex image-only prompts use native localImage inputs without exposing server paths in chat text', async t => {
  const f = await fixture(t);
  await f.bridge.start();
  await f.bridge.openSession(f.threadId,'/tmp');
  await f.bridge.sendPrompt(f.threadId,'',undefined,['/private/data/screenshot.png']);
  assert.deepEqual(f.calls.find(call=>call.message.method==='turn/start')?.message.params?.input,[{type:'localImage',path:'/private/data/screenshot.png'}]);
  await f.send('item/completed',{turnId:f.turnId,item:{id:'image-user',type:'userMessage',content:[{type:'localImage',path:'/private/data/screenshot.png'}]}});
  const item=f.bridge.chatSnapshot(f.threadId)!.items.find(item=>item.id==='image-user');
  assert.equal(item?.imageCount,1);
  assert.equal(item?.text,'');
});

test('steering binds to the active turn, sends native images, preserves completion and never starts a fallback turn', async t => {
  const f = await fixture(t), { bridge, threadId, turnId } = f;
  await bridge.openSession(threadId); await bridge.sendPrompt(threadId, 'initial');
  await assert.rejects(bridge.sendPrompt(threadId, 'stale', undefined, [], randomUUID()), /已变化/);
  assert.equal(f.calls.filter(call => call.message.method === 'turn/steer').length, 0);
  f.intercept((socket, message) => {
    if (message.method !== 'turn/steer') return false;
    socket.send(JSON.stringify({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } }));
    socket.send(JSON.stringify({ id: message.id, result: { turnId } })); return true;
  });
  assert.deepEqual(await bridge.sendPrompt(threadId, 'correction', undefined, ['/private/image.png'], turnId), { turnId });
  const steer = f.calls.find(call => call.message.method === 'turn/steer')!;
  assert.equal(steer.socket, f.observer());
  assert.deepEqual(steer.message.params, { threadId, expectedTurnId: turnId, input: [{ type: 'text', text: 'correction', text_elements: [] }, { type: 'localImage', path: '/private/image.png' }] });
  assert.equal(bridge.chatSnapshot(threadId)!.activeTurnId, null);
  assert.equal(f.calls.filter(call => call.message.method === 'turn/start').length, 1);
});

test('unsupported native steering rejects safely and concurrent steering is claimed once', async t => {
  const f = await fixture(t), { bridge, threadId, turnId } = f;
  await bridge.openSession(threadId); await bridge.sendPrompt(threadId, 'initial');
  f.intercept((socket, message) => {
    if (message.method !== 'turn/steer') return false;
    setTimeout(() => socket.send(JSON.stringify({ id: message.id, error: { code: -32601, message: 'unknown method' } })), 20); return true;
  });
  const results = await Promise.allSettled([1, 2].map(() => bridge.sendPrompt(threadId, 'correction', undefined, [], turnId)));
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.deliveryUnknown === false));
  assert.ok(results.some(result => result.status === 'rejected' && /不支持/.test(result.reason.message)));
  assert.equal(f.calls.filter(call => call.message.method === 'turn/steer').length, 1);
  assert.equal(f.calls.filter(call => call.message.method === 'turn/start').length, 1);
  assert.equal(bridge.chatSnapshot(threadId)!.activeTurnId, turnId);
});
