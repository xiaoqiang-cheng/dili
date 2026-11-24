import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeUsage, parseCodexUsage, parseDshUsage, parseUsage } from './usage.ts';

const claudeRows = [
  { type: 'assistant', uuid: 'u1', message: { id: 'm1', model: 'claude-sonnet', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 } } },
  { type: 'user', uuid: 'u2', message: { role: 'user', content: 'hi' } },
  { type: 'assistant', uuid: 'u3', message: { id: 'm2', model: 'claude-sonnet', usage: { input_tokens: 40, output_tokens: 10, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 } } },
  // A resumed log can repeat a saved message; it must be counted once.
  { type: 'assistant', uuid: 'u3', message: { id: 'm2', model: 'claude-sonnet', usage: { input_tokens: 40, output_tokens: 10, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 } } },
];

test('Claude usage sums messages and reports the last context', () => {
  const usage = parseClaudeUsage(claudeRows, true);
  assert.ok(usage);
  assert.equal(usage.turns, 2);
  assert.equal(usage.inputTokens, 140);
  assert.equal(usage.outputTokens, 30);
  assert.equal(usage.cacheReadTokens, 3000);
  assert.equal(usage.cacheWriteTokens, 50);
  assert.equal(usage.totalTokens, 3220);
  assert.equal(usage.lastTurnInputTokens, 2040);
  assert.equal(usage.lastTurnOutputTokens, 10);
  assert.equal(usage.model, 'claude-sonnet');
  assert.equal(usage.partial, true);
});

test('Claude usage is absent without assistant usage', () => {
  assert.equal(parseClaudeUsage([{ type: 'assistant', message: { content: 'x' } }], false), null);
});

const codexRows = [
  { type: 'turn_context', payload: { model: 'gpt-5-codex' } },
  { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 500, cached_input_tokens: 200, output_tokens: 50 }, last_token_usage: { input_tokens: 300, cached_input_tokens: 100, output_tokens: 30 } } } },
  { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1500, cached_input_tokens: 700, output_tokens: 120 }, last_token_usage: { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 70 } } } },
];

test('Codex cumulative totals describe the whole thread even from a tail window', () => {
  const usage = parseCodexUsage(codexRows, true);
  assert.ok(usage);
  assert.equal(usage.inputTokens, 800);
  assert.equal(usage.cacheReadTokens, 700);
  assert.equal(usage.outputTokens, 120);
  assert.equal(usage.totalTokens, 1620);
  assert.equal(usage.lastTurnInputTokens, 1000);
  assert.equal(usage.lastTurnOutputTokens, 70);
  assert.equal(usage.turns, 2);
  assert.equal(usage.model, 'gpt-5-codex');
  assert.equal(usage.partial, false);
});

test('Codex without totals falls back to summing turns', () => {
  const usage = parseCodexUsage([
    { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, output_tokens: 10 } } } },
    { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 200, cached_input_tokens: 50, output_tokens: 20 } } } },
  ], true);
  assert.ok(usage);
  assert.equal(usage.inputTokens, 250);
  assert.equal(usage.cacheReadTokens, 50);
  assert.equal(usage.outputTokens, 30);
  assert.equal(usage.partial, true);
});

test('Codex without token events reports nothing', () => {
  assert.equal(parseCodexUsage([{ type: 'event_msg', payload: { type: 'user_message', message: 'hi' } }], false), null);
});

test('Harness usage is only reported when a version includes it', () => {
  assert.equal(parseDshUsage([{ type: 'assistant/message', data: { message: { role: 'assistant', content: [] } } }], false), null);
  const usage = parseDshUsage([{ type: 'assistant/message', data: { message: { usage: { inputTokens: 12, outputTokens: 3 } } } }], false);
  assert.equal(usage?.totalTokens, 15);
  assert.equal(usage?.turns, 1);
});

test('Harness 0.2 usage sits beside the message and carries cache and context', () => {
  // Shape observed in a real dsh 0.2 session log.
  const rows = [
    { type: 'request/context', data: { contextWindow: 200_000 } },
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 983, outputTokens: 201, totalTokens: 6944, cacheReadTokens: 5760 } } },
    { type: 'assistant/message', data: { turn: 1, step: 2, message: { role: 'assistant', content: [], source: { model: 'deepseek-v4-flash' } }, usage: { inputTokens: 200, outputTokens: 50, totalTokens: 1200, cacheReadTokens: 950 } } },
  ];
  const usage = parseDshUsage(rows, false);
  assert.ok(usage);
  assert.equal(usage.turns, 2);
  assert.equal(usage.inputTokens, 1183);
  assert.equal(usage.outputTokens, 251);
  assert.equal(usage.cacheReadTokens, 6710);
  // Billed total includes the cached prompt, matching the native totalTokens.
  assert.equal(usage.totalTokens, 1183 + 251 + 6710);
  // The last step's prompt is its own input plus the cached prefix.
  assert.equal(usage.lastTurnInputTokens, 1150);
  assert.equal(usage.lastTurnOutputTokens, 50);
  assert.equal(usage.contextWindow, 200_000);
  assert.equal(usage.model, 'deepseek-v4-flash');
  assert.equal(usage.partial, false);
});

test('Harness counts every native compaction, including prunes', () => {
  const rows = [
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [] }, usage: { inputTokens: 1, outputTokens: 1 } } },
    { type: 'compaction/start', data: { compactionId: 'a' } },
    { type: 'compaction/summary', data: { compactionId: 'a', summary: [] } },
    { type: 'compaction/end', data: { compactionId: 'a' } },
    { type: 'compaction/prune', data: { shadowedTokenCount: 2844 } },
    { type: 'compaction/prune', data: { shadowedTokenCount: 3267 } },
  ];
  assert.equal(parseDshUsage(rows, false)?.compactions, 4);
});

test('Claude and Codex expose native compaction counts and no invented window', () => {
  const claude = parseClaudeUsage([
    { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 966976, postTokens: 9515 } },
    ...claudeRows,
  ], false);
  assert.equal(claude?.compactions, 1);
  assert.equal(claude?.contextWindow, null);
  const codex = parseCodexUsage([
    { type: 'compacted', payload: { message: 'summary' } },
    { type: 'event_msg', payload: { type: 'context_compacted' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, output_tokens: 10 } } } },
  ], false);
  assert.equal(codex?.compactions, 1);
  assert.equal(codex?.contextWindow, null);
});

test('parseUsage dispatches per backend', () => {
  assert.equal(parseUsage('claude', claudeRows, false)?.turns, 2);
  assert.equal(parseUsage('codex', codexRows, false)?.turns, 2);
  assert.equal(parseUsage('dsh', [], false), null);
});

test('Pi usage prefers the native total and falls back to native components', () => {
  const usage = parseUsage('pi', [
    { type: 'message', message: { role: 'assistant', model: 'pi-model', usage: { input: 10, output: 2, cacheRead: 1, cacheWrite: 3, totalTokens: 99 } } },
    { type: 'message', message: { role: 'assistant', usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 } } },
  ], false);
  assert.equal(usage?.turns, 2);
  assert.equal(usage?.inputTokens, 15);
  assert.equal(usage?.outputTokens, 3);
  assert.equal(usage?.cacheReadTokens, 1);
  assert.equal(usage?.cacheWriteTokens, 3);
  assert.equal(usage?.totalTokens, 105);
  assert.equal(usage?.contextWindow, null);
});
