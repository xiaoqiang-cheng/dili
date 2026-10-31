import test from 'node:test';
import assert from 'node:assert/strict';
import { dshChatItems, dshChatTurn, dshQuestionText } from './dsh-chat-items.ts';

const nativeId = 'session-11111111-1111-4111-8111-111111111111';
const date = Date.parse('2026-10-31T08:00:00.000Z');
const message = (seq: number, role: 'user' | 'assistant', text: string, source = role === 'user' ? 'user' : 'model') => {
  const body = { role, source: { kind: source }, content: [{ type: 'text', text }] };
  return { type: `${role}/message`, seq, time: date + seq, surfaceOp: 'append', data: role === 'user' ? body : { turn: 1, step: seq, message: body } };
};
const call = (seq: number, callId: string, name: string, args: unknown) => ({ type: 'tool/call', seq, time: date + seq, data: { turn: 1, step: seq, callId, name, arguments: JSON.stringify(args) } });
const result = (seq: number, callId: string, text: string, error = false) => ({ type: 'tool/result', seq, time: date + seq, data: { turn: 1, step: seq, message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text }], isError: error }, surfaceOp: 'append' } });

test('dsh chat items fold text and tool calls in order without leaking replacement context', () => {
  const items = dshChatItems([
    message(1, 'user', '请检查登录'),
    message(2, 'assistant', '我先看代码。'),
    call(3, 'call-1', 'bash', { command: 'rg login' }),
    result(4, 'call-1', 'src/login.ts'),
    { ...message(5, 'user', 'hidden plugin input'), data: { role: 'user', source: { kind: 'plugin' }, content: [{ type: 'text', text: 'hidden' }] } },
    { ...message(6, 'assistant', 'hidden compact copy'), surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 } },
  ], nativeId);
  assert.deepEqual(items.map(item => [item.type, item.title ?? item.text, item.status]), [
    ['user', '请检查登录', 'completed'],
    ['assistant', '我先看代码。', 'completed'],
    ['tool', 'bash', 'completed'],
  ]);
  assert.match(items[2].text, /"command": "rg login"/);
  assert.match(items[2].output ?? '', /src\/login\.ts/);
  assert.equal(items[2].turnId, '1');
});

test('dsh chat items keep ask_user_question readable and merge only matching tool results', () => {
  const question = JSON.stringify({ questions: [{ id: 'q1', header: '接口', question: '是否保留旧接口？', detail: '会影响客户端。', options: [{ label: '保留' }, { label: '删除', description: '需要迁移' }] }] });
  const items = dshChatItems([
    call(1, 'question-1', 'ask_user_question', JSON.parse(question)),
    call(2, 'call-2', 'read', { path: 'missing' }),
    result(3, 'call-2', 'not found', true),
    result(4, 'unknown', 'must not attach'),
  ], nativeId);
  assert.equal(items.length, 2);
  assert.equal(items[0].type, 'assistant');
  assert.match(items[0].text, /是否保留旧接口/);
  assert.match(items[0].text, /删除 — 需要迁移/);
  assert.equal(items[1].type, 'tool');
  assert.equal(items[1].status, 'failed');
  assert.equal(items[1].output, 'not found');
});

test('dsh question text handles malformed and multiline input honestly', () => {
  assert.equal(dshQuestionText('not json'), '');
  assert.equal(dshQuestionText({ questions: [{ header: 'A', question: '第一行\n第二行', multiSelect: true, options: [{ label: 'X' }] }] }), '**需要你回答的问题**\n\n1. **A**\n\n第一行\n第二行\n   - X\n   - 可多选');
});

test('dsh turn boundary exposes a running turn without inventing completion', () => {
  assert.deepEqual(dshChatTurn([{ type: 'turn/start', data: { turn: 3 } }]), { id: 3, active: true });
  assert.deepEqual(dshChatTurn([{ type: 'turn/start', data: { turn: 3 } }, { type: 'turn/end', data: { turn: 3 } }]), { id: 3, active: false });
  assert.equal(dshChatTurn([{ type: 'tool/call', data: { turn: 3 } }]), undefined);
});

test('dsh chat item text stays bounded', () => {
  const items = dshChatItems([message(1, 'assistant', 'x'.repeat(20))], nativeId, { maxText: 8 });
  assert.equal(items[0].text, 'xxxxxxx…');
});
