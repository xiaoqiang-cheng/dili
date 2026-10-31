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

test('parseUsage dispatches per backend', () => {
  assert.equal(parseUsage('claude', claudeRows, false)?.turns, 2);
  assert.equal(parseUsage('codex', codexRows, false)?.turns, 2);
  assert.equal(parseUsage('dsh', [], false), null);
});
