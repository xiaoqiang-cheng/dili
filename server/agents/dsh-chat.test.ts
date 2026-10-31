import test from 'node:test';
import assert from 'node:assert/strict';
import { DshChatAdapter, type DshChatNative, type DshStatusLike } from './dsh-chat.ts';
import type { DshHistory } from '../conversation.ts';
import type { DshChatSettings } from '../dsh.ts';

const id = 'session-11111111-1111-4111-8111-111111111111';
const date = Date.parse('2026-10-31T08:00:00.000Z');
const message = (seq: number, role: 'user' | 'assistant', text: string) => {
  const body = { role, source: { kind: role === 'user' ? 'user' : 'model' }, content: [{ type: 'text', text }] };
  return { type: `${role}/message`, seq, time: date + seq, surfaceOp: 'append', data: role === 'user' ? body : { turn: 4, step: seq, message: body } };
};

class FakeNative implements DshChatNative {
  readyState = true;
  events: unknown[] = [];
  promptError: Error | undefined;
  prompts: string[] = [];
  answers: { callId: string; answers: { id: string; selected: string[]; custom?: string }[] }[] = [];
  questions: { callId: string; questions: unknown[]; state?: 'open' | 'continued' }[] = [];
  approvals: { id: string; toolName?: string; reason?: string }[] = [];
  status: DshStatusLike = { status: 'running', detail: '运行中' };
  async start() {}
  async readHistory(): Promise<DshHistory | undefined> { return { events: this.events.map(event => ({ event })), hasMore: false }; }
  async prompt(_id: string, text: string) { if (this.promptError) throw this.promptError; this.prompts.push(text); }
  async stopSession() { this.status = { status: 'idle' }; }
  async getStatus(): Promise<DshStatusLike> { return this.status; }
  pendingRequests() { return { questions: this.questions, approvals: this.approvals }; }
  async answerQuestion(_id: string, callId: string, answers: { id: string; selected: string[]; custom?: string }[]) { this.answers.push({ callId, answers }); }
  settings: DshChatSettings = { model: 'discover/deepseek-v4-flash', models: [{ id: 'discover/deepseek-v4-flash', label: 'deepseek-v4-flash' }, { id: 'discover/deepseek-v4-pro', label: 'deepseek-v4-pro' }], permission: 'workspace-write', permissions: [{ id: 'read-only', label: 'read-only' }, { id: 'workspace-write', label: 'workspace-write' }] };
  settingsUpdates: { field: string; value: string }[] = [];
  async readChatSettings() { return this.settings; }
  async updateChatSettings(_id: string, field: 'model' | 'permission', value: string) { this.settingsUpdates.push({ field, value }); this.settings = { ...this.settings, [field]: value }; }
  listeners: ((id: string, event: unknown) => void)[] = [];
  onStatusChange() { return () => {}; }
  onSessionEvent(listener: (id: string, event: unknown) => void) { this.listeners.push(listener); return () => {}; }
  emit(event: unknown) { for (const listener of this.listeners) listener(id, event); }
}

test('dsh chat adapter reads bounded history and keeps the native active turn explicit', async () => {
  const native = new FakeNative();
  native.events = [message(1, 'user', '检查登录'), message(2, 'assistant', '已检查'), { type: 'turn/start', seq: 3, data: { turn: 4 } }];
  const adapter = new DshChatAdapter(native);
  const snapshot = await adapter.readChat(id);
  assert.equal(snapshot.nativeSessionId, id);
  assert.equal(snapshot.connected, true);
  assert.equal(snapshot.activeTurnId, '4');
  assert.deepEqual(snapshot.items.map(item => [item.type, item.text]), [['user', '检查登录'], ['assistant', '已检查']]);
  assert.equal(snapshot.truncated, false);
  adapter.close();
});

test('dsh chat send maps the next native turn to a stable synthetic turn id', async () => {
  const native = new FakeNative();
  const adapter = new DshChatAdapter(native);
  const sent = await adapter.sendPrompt(id, '继续修');
  assert.equal(native.prompts[0], '继续修');
  native.events = [
    message(1, 'user', '继续修'),
    { type: 'turn/start', seq: 2, data: { turn: 4 } },
    message(3, 'assistant', '正在修'),
  ];
  const snapshot = await adapter.readChat(id);
  assert.equal(snapshot.activeTurnId, sent.turnId);
  assert.equal(snapshot.items.find(item => item.type === 'assistant')?.turnId, sent.turnId);
  adapter.close();
});


test('dsh chat publishes live text deltas and lets the durable message replace that bubble', async () => {
  const native = new FakeNative();
  native.events = [message(1, 'user', '写一段'), { type: 'turn/start', seq: 2, data: { turn: 4 } }];
  const adapter = new DshChatAdapter(native);
  await adapter.readChat(id);
  native.emit({ type: 'assistant/live-chunk', data: { attemptId: 'attempt-1', turn: 4, step: 1, chunk: { type: 'text-delta', text: '你' } } });
  native.emit({ type: 'assistant/live-chunk', data: { attemptId: 'attempt-1', turn: 4, step: 1, chunk: { type: 'text-delta', text: '好' } } });
  const live = adapter.chatSnapshot(id)!.items.find(item => item.id.startsWith('dsh:live:'));
  assert.equal(live?.type, 'assistant');
  assert.equal(live?.type === 'assistant' ? live.text : '', '你好');
  native.events.push(message(3, 'assistant', '你好，世界'), { type: 'turn/end', seq: 4, data: { reason: { kind: 'completed' } } });
  const final = await adapter.readChat(id);
  const assistant = final.items.findLast(item => item.type === 'assistant');
  assert.equal(assistant?.type === 'assistant' ? assistant.text : '', '你好，世界');
  assert.deepEqual(assistant && 'replaces' in assistant ? assistant.replaces : undefined, [live!.id]);
  assert.equal(final.items.filter(item => item.id.startsWith('dsh:live:')).length, 0);
  adapter.close();
});
test('dsh chat questions submit selected options and free text with the native answer shape', async () => {
  const native = new FakeNative();
  native.questions = [{ callId: 'call-q', questions: [{ id: 'q1', header: '接口', question: '保留旧接口吗？', options: [{ label: '保留' }, { label: '删除' }] }] }];
  const adapter = new DshChatAdapter(native);
  const snapshot = await adapter.readChat(id);
  assert.equal(snapshot.requests[0].kind, 'question');
  assert.equal(snapshot.requests[0].id, 'call-q');
  assert.equal(snapshot.requests[0].questions?.[0].isOther, true);
  await adapter.answerChatRequest(id, 'call-q', { answers: { q1: ['删除'] } });
  assert.deepEqual(native.answers[0], { callId: 'call-q', answers: [{ id: 'q1', selected: ['删除'] }] });
  await adapter.answerChatRequest(id, 'call-q', { answers: { q1: ['先保留到 v2'] } });
  assert.deepEqual(native.answers[1], { callId: 'call-q', answers: [{ id: 'q1', selected: [], custom: '先保留到 v2' }] });
  adapter.close();
});

test('dsh chat keeps approvals and multi-select questions honest instead of faking buttons', async () => {
  const native = new FakeNative();
  native.questions = [{ callId: 'call-multi', questions: [{ id: 'q1', question: '选择多个', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }] }];
  native.approvals = [{ id: 'approval-1', toolName: 'bash', reason: 'rm -rf' }];
  const adapter = new DshChatAdapter(native);
  const snapshot = await adapter.readChat(id);
  assert.deepEqual(snapshot.requests.map(request => [request.kind, request.id]), [['unsupported', 'call-multi'], ['unsupported', 'approval-1']]);
  assert.match(snapshot.requests[1].description ?? '', /原生界面/);
  await assert.rejects(adapter.answerChatRequest(id, 'approval-1', { decision: 'allowed-once' }), /审批只能在/);
  assert.equal(native.answers.length, 0);
  adapter.close();
});

test('dsh chat settings fall back to read-only when the native catalog is unavailable', async () => {
  const legacy = new FakeNative();
  Object.defineProperty(legacy, 'readChatSettings', { value: undefined });
  Object.defineProperty(legacy, 'updateChatSettings', { value: undefined });
  const adapter = new DshChatAdapter(legacy);
  const settings = await adapter.readChatSettings(id);
  assert.equal(settings.model, null);
  assert.deepEqual(settings.models, []);
  assert.equal(settings.permission, null);
  assert.match(settings.disabledReason ?? '', /原生界面/);
  await assert.rejects(adapter.updateChatSettings(id, { version: settings.version, field: 'model', value: 'x' }), /只能.*原生界面修改/);
  adapter.close();
});

test('dsh chat exposes native model and permission choices with versioned writes', async () => {
  const native = new FakeNative();
  const adapter = new DshChatAdapter(native, { writerWritable: () => true });
  const first = await adapter.readChatSettings(id);
  assert.equal(first.model, 'discover/deepseek-v4-flash');
  assert.deepEqual(first.models.map(item => item.label), ['deepseek-v4-flash', 'deepseek-v4-pro']);
  assert.equal(first.permission, 'workspace-write');
  assert.equal(first.disabledReason, undefined);
  const next = await adapter.updateChatSettings(id, { version: first.version, field: 'model', value: 'discover/deepseek-v4-pro' });
  assert.equal(native.settingsUpdates[0]?.field, 'model');
  assert.equal(next.model, 'discover/deepseek-v4-pro');
  assert.notEqual(next.version, first.version);
  await assert.rejects(adapter.updateChatSettings(id, { version: first.version, field: 'permission', value: 'read-only' }), /已变化/);
  adapter.close();
});

test('dsh chat disables settings while dsh-tui owns the session', async () => {
  const adapter = new DshChatAdapter(new FakeNative(), { writerWritable: () => false });
  const settings = await adapter.readChatSettings(id);
  assert.match(settings.disabledReason ?? '', /dsh-tui/);
  await assert.rejects(adapter.sendPrompt(id, '不应发送'), /dsh-tui/);
  await assert.rejects(adapter.updateChatSettings(id, { version: settings.version, field: 'permission', value: 'read-only' }), /dsh-tui/);
  adapter.close();
});

test('dsh chat does not boot a stopped contact and surfaces a native start failure', async () => {
  const native = new FakeNative();
  native.readyState = false;
  let starts = 0;
  native.start = async () => { starts++; throw new Error('原生服务未安装'); };
  const stopped = new DshChatAdapter(native);
  await assert.rejects(stopped.readChat(id), /原生服务尚未启动/);
  assert.equal(starts, 0);
  stopped.close();
  const adapter = new DshChatAdapter(native, { shouldStart: () => true });
  await assert.rejects(adapter.readChat(id), /原生服务未安装/);
  assert.equal(starts, 1);
  adapter.close();
});
