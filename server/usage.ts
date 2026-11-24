import type { Backend } from '../shared/types.ts';
import type { SessionUsage } from '../shared/usage.ts';

type Value = Record<string, unknown>;
const record = (value: unknown): Value | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : undefined;
const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/**
 * Claude history stores per-message usage. Cache tokens are part of the prompt
 * for the next turn, so the last message's total is the best context estimate.
 * Totals are only complete when the whole history was read.
 */
export function parseClaudeUsage(records: readonly unknown[], partial: boolean): SessionUsage | null {
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, turns = 0, compactions = 0;
  let lastTurnInputTokens: number | null = null, lastTurnOutputTokens: number | null = null;
  let model: string | null = null;
  const seen = new Set<string>();
  for (const raw of records) {
    const row = record(raw);
    // A compact boundary is the native proof that the context was rewritten.
    if (row?.type === 'system' && row.subtype === 'compact_boundary') compactions++;
    if (!row || row.type !== 'assistant') continue;
    const body = record(row.message);
    const usage = record(body?.usage);
    if (!body || !usage) continue;
    // A resumed log can repeat the same assistant message; count it once.
    const id = typeof body.id === 'string' ? body.id : typeof row.uuid === 'string' ? row.uuid : null;
    if (id) { if (seen.has(id)) continue; seen.add(id); }
    const inTokens = num(usage.input_tokens) ?? 0;
    const outTokens = num(usage.output_tokens) ?? 0;
    const read = num(usage.cache_read_input_tokens) ?? 0;
    const write = num(usage.cache_creation_input_tokens) ?? 0;
    input += inTokens; output += outTokens; cacheRead += read; cacheWrite += write; turns++;
    lastTurnInputTokens = inTokens + read + write;
    lastTurnOutputTokens = outTokens;
    if (typeof body.model === 'string' && body.model.trim()) model = body.model.trim();
  }
  if (!turns) return null;
  return { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, lastTurnInputTokens, lastTurnOutputTokens, turns, model, partial, contextWindow: null, compactions };
}

/**
 * Codex rollouts carry a cumulative total in every token_count event, so the
 * last one describes the whole thread even when only a tail window was read.
 * Older logs without totals fall back to summing per-turn usage.
 */
export function parseCodexUsage(records: readonly unknown[], windowTruncated: boolean): SessionUsage | null {
  let totalInput: number | null = null, totalOutput: number | null = null, totalCacheRead = 0;
  let summedInput = 0, summedOutput = 0, summedCacheRead = 0, turns = 0;
  let lastTurnInputTokens: number | null = null, lastTurnOutputTokens: number | null = null;
  let model: string | null = null, compactions = 0;
  for (const raw of records) {
    const row = record(raw);
    if (!row) continue;
    // Codex writes a `compacted` record then a `context_compacted` event.
    if (row.type === 'compacted') compactions++;
    if (row.type === 'turn_context') {
      const payload = record(row.payload);
      const candidate = typeof payload?.model === 'string' ? payload.model : '';
      if (candidate.trim()) model = candidate.trim();
      continue;
    }
    if (row.type !== 'event_msg') continue;
    const payload = record(row.payload);
    if (!payload || payload.type !== 'token_count') continue;
    const info = record(payload.info);
    const total = record(info?.total_token_usage);
    if (total) {
      totalInput = num(total.input_tokens);
      totalOutput = num(total.output_tokens);
      totalCacheRead = num(total.cached_input_tokens) ?? num(total.cache_read_input_tokens) ?? 0;
    }
    const last = record(info?.last_token_usage);
    if (last) {
      lastTurnInputTokens = num(last.input_tokens);
      lastTurnOutputTokens = num(last.output_tokens);
      summedInput += num(last.input_tokens) ?? 0;
      summedOutput += num(last.output_tokens) ?? 0;
      summedCacheRead += num(last.cached_input_tokens) ?? num(last.cache_read_input_tokens) ?? 0;
      turns++;
    }
  }
  if (totalInput !== null && totalOutput !== null) {
    const cached = totalCacheRead;
    // total_tokens already includes cached input on current Codex versions.
    const reported = totalInput + totalOutput;
    return { inputTokens: Math.max(0, totalInput - cached), outputTokens: totalOutput, cacheReadTokens: cached, cacheWriteTokens: 0, totalTokens: Math.max(reported, totalInput + totalOutput), lastTurnInputTokens, lastTurnOutputTokens, turns, model, partial: false, contextWindow: null, compactions };
  }
  if (!turns) return null;
  return { inputTokens: Math.max(0, summedInput - summedCacheRead), outputTokens: summedOutput, cacheReadTokens: summedCacheRead, cacheWriteTokens: 0, totalTokens: summedInput + summedOutput, lastTurnInputTokens, lastTurnOutputTokens, turns, model, partial: windowTruncated, contextWindow: null, compactions };
}

/**
 * Harness history has no stable usage contract today. Accept a clearly shaped
 * usage object if a version reports one; otherwise report nothing rather than
 * inventing numbers.
 *
 * dsh 0.2 records usage per assistant step next to the message
 * (`data.usage`), so the same turn carries one entry per step and the last
 * one describes the current prompt. `totalTokens` is the billed total,
 * including cache reads. Context size, window and compaction counts are
 * reported only when the native record supplies them.
 */
export function parseDshUsage(records: readonly unknown[], partial: boolean): SessionUsage | null {
  let input = 0, output = 0, cacheRead = 0, turns = 0;
  let lastTurnInputTokens: number | null = null, lastTurnOutputTokens: number | null = null;
  let contextWindow: number | null = null, compactions = 0;
  let model: string | null = null;
  for (const raw of records) {
    const event = record(raw);
    const data = record(event?.data);
    // Compaction is the native measurement of how often the context was
    // rewritten; both a summary and a prune cost a full prompt re-read.
    if (event?.type === 'compaction/summary' || event?.type === 'compaction/end' || event?.type === 'compaction/prune') compactions++;
    if (event?.type === 'request/context') contextWindow = num(data?.contextWindow) ?? contextWindow;
    if (event?.type === 'request/header') {
      const config = record(record(data?.header)?.config);
      contextWindow = num(config?.contextWindow) ?? contextWindow;
      if (typeof config?.model === 'string' && config.model.trim()) model = config.model.trim();
    }
    const body = record(data?.message) ?? data;
    const usage = record(data?.usage) ?? record(body?.usage);
    if (usage) {
      const inTokens = num(usage.inputTokens) ?? num(usage.input_tokens);
      const outTokens = num(usage.outputTokens) ?? num(usage.output_tokens);
      if (inTokens !== null && outTokens !== null) {
        input += inTokens; output += outTokens; turns++;
        cacheRead += num(usage.cacheReadTokens) ?? num(usage.cachedTokens) ?? num(usage.cache_read_input_tokens) ?? 0;
        // A step's prompt is input + cache read; the last one is the context.
        lastTurnInputTokens = inTokens + (num(usage.cacheReadTokens) ?? num(usage.cachedTokens) ?? num(usage.cache_read_input_tokens) ?? 0);
        lastTurnOutputTokens = outTokens;
        contextWindow = num(usage.contextWindow) ?? contextWindow;
      }
      if (typeof body?.source === 'object' && typeof record(body.source)?.model === 'string') model = String(record(body.source)!.model).trim() || model;
    }
    if (typeof body?.model === 'string' && body.model.trim()) model = body.model.trim();
  }
  if (!turns) return null;
  return {
    inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: 0,
    totalTokens: input + output + cacheRead, lastTurnInputTokens, lastTurnOutputTokens, turns, model, partial,
    contextWindow, compactions,
  };
}

/** Pi records model usage on each assistant step. input/output/cacheRead are
 * native provider fields; no context window is stored per message, so Dili
 * leaves it null instead of guessing. */
export function parsePiUsage(records: readonly unknown[], partial: boolean): SessionUsage | null {
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, total = 0, turns = 0;
  let lastTurnInputTokens: number | null = null, lastTurnOutputTokens: number | null = null;
  let model: string | null = null;
  for (const raw of records) {
    const entry = record(raw);
    const message = record(entry?.message);
    if (!message || message.role !== 'assistant') continue;
    const usage = record(message.usage);
    if (!usage) continue;
    const inTokens = num(usage.input) ?? num(usage.inputTokens) ?? 0;
    const outTokens = num(usage.output) ?? num(usage.outputTokens) ?? 0;
    const read = num(usage.cacheRead) ?? num(usage.cacheReadTokens) ?? 0;
    const write = num(usage.cacheWrite) ?? num(usage.cacheWriteTokens) ?? 0;
    input += inTokens; output += outTokens; cacheRead += read; cacheWrite += write; turns++;
    total += num(usage.totalTokens) ?? (inTokens + outTokens + read + write);
    lastTurnInputTokens = inTokens + read + write;
    lastTurnOutputTokens = outTokens;
    if (typeof message.model === 'string' && message.model.trim()) model = message.model.trim();
  }
  if (!turns) return null;
  return { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, totalTokens: total, lastTurnInputTokens, lastTurnOutputTokens, turns, model, partial, contextWindow: null, compactions: 0 };
}

export function parseUsage(backend: Backend, records: readonly unknown[], windowTruncated: boolean): SessionUsage | null {
  if (backend === 'claude') return parseClaudeUsage(records, windowTruncated);
  if (backend === 'codex') return parseCodexUsage(records, windowTruncated);
  if (backend === 'pi') return parsePiUsage(records, windowTruncated);
  return parseDshUsage(records, windowTruncated);
}
