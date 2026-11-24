import assert from 'node:assert/strict';
import test from 'node:test';
import { PI_SESSION_FILE, piEntryItems, piEntryMessages, piSessionName, piUsage } from './pi-session.ts';

const entries = [
  { type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'Please inspect the tree' }] } },
  { type: 'message', id: 'a1', message: { role: 'assistant', content: [
    { type: 'text', text: 'I will list files.' },
    { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls' } },
  ], usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 17 }, model: 'mock-model' } },
  { type: 'toolResult', id: 'r1', message: { role: 'toolResult', toolCallId: 'call_1', toolName: 'bash', content: [{ type: 'text', text: 'a\nb' }], isError: false } },
  { type: 'message', id: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], usage: { input: 3, output: 1 }, model: 'mock-model' } },
];

test('Pi entries become stable chat items and merge tool results', () => {
  const result = piEntryItems(entries, 'abc');
  assert.deepEqual(result.items.map(item => [item.type, item.title, item.status, item.text, item.output]), [
    ['user', undefined, 'completed', 'Please inspect the tree', undefined],
    ['assistant', undefined, 'completed', 'I will list files.', undefined],
    ['tool', 'bash', 'completed', '{\n  "command": "ls"\n}', 'a\nb'],
    ['assistant', undefined, 'completed', 'Done.', undefined],
  ]);
  assert.equal(result.truncated, false);
  // Native ids are stable across refreshes and namespaced by the session.
  assert.equal(piEntryItems(entries, 'abc').items[2]!.id, 'pi:abc:a1:tool:call_1');
});

test('Pi user image turns count images without exposing binary data', () => {
  const result = piEntryItems([{ type: 'message', id: 'u', message: { role: 'user', content: [
    { type: 'text', text: 'Look' }, { type: 'image', data: 'SECRET_BASE64', mimeType: 'image/png' },
  ] } }], 'id');
  assert.equal(result.items[0]!.imageCount, 1);
  assert.equal(result.items[0]!.text, 'Look');
});

test('Pi bounded items keep the newest messages and report truncation', () => {
  const many = Array.from({ length: 8 }, (_, index) => ({ type: 'message', id: `m${index}`, message: { role: 'user', content: [{ type: 'text', text: String(index) }] } }));
  const result = piEntryItems(many, 'id', 3);
  assert.deepEqual(result.items.map(item => item.text), ['5', '6', '7']);
  assert.equal(result.truncated, true);
});

test('Pi transcript view retains tool cards for the read-only pane', () => {
  const messages = piEntryMessages(entries, 'abc').messages;
  assert.equal(messages.length, 4);
  assert.equal(messages[2]!.tool?.name, 'bash');
  assert.equal(messages[2]!.tool?.status, 'ok');
  assert.equal(messages[3]!.text, 'Done.');
});

test('Pi session names use the latest native rename', () => {
  assert.equal(piSessionName([{ type: 'session_info', name: 'old' }, { type: 'session_info', name: ' new ' }]), 'new');
  assert.equal(piSessionName([{ type: 'session_info' }]), undefined);
});

test('Pi usage uses native provider fields and never invents a context window', () => {
  const usage = piUsage(entries);
  assert.equal(usage?.inputTokens, 13);
  assert.equal(usage?.outputTokens, 5);
  assert.equal(usage?.cacheReadTokens, 2);
  assert.equal(usage?.cacheWriteTokens, 1);
  assert.equal(usage?.totalTokens, 21);
  assert.equal(usage?.turns, 2);
  assert.equal(usage?.model, 'mock-model');
});

test('Pi session filenames carry the native UUID', () => {
  assert.match('2026-01-02T03-04-05-000Z_123e4567-e89b-42d3-a456-426614174000.jsonl', PI_SESSION_FILE);
  assert.match('2026-01-02T03-04-05-000Z_018f4f8a-7b3c-7c9e-8a2f-1234567890ab.jsonl', PI_SESSION_FILE);
  assert.doesNotMatch('session.jsonl', PI_SESSION_FILE);
  assert.doesNotMatch('123e4567-e89b-42d3-a456-426614174000.jsonl', PI_SESSION_FILE);
});
