import type { AgentChatItem } from '../../shared/chat.ts';

/**
 * DeepSeek Harness history is a stream of session events, not a flat message
 * list. Keep the translation pure and bounded so both the full chat view and
 * its tests see exactly the same items.
 */

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
const MAX_TOOL_TEXT = 4_000;
const MAX_MESSAGE_TEXT = 32_000;
const clip = (value: string, limit = MAX_TOOL_TEXT): string => value.length > limit ? value.slice(0, limit - 1) + '…' : value;

function textContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.flatMap(block => {
    const part = record(block);
    return part && ['text', 'input_text', 'output_text'].includes(String(part.type)) && typeof part.text === 'string' ? [part.text] : [];
  }).join('\n');
}

/** Human-readable question text retained in the transcript after the card is gone. */
export function dshQuestionText(value: unknown): string {
  let questions = value;
  if (typeof questions === 'string') {
    try { questions = JSON.parse(questions); } catch { return ''; }
  }
  questions = record(questions)?.questions ?? questions;
  if (!Array.isArray(questions)) return '';
  const rendered = questions.flatMap((candidate, index) => {
    const item = record(candidate);
    if (!item || typeof item.question !== 'string' || !item.question.trim()) return [];
    const lines = [`${index + 1}. ${item.header ? `**${String(item.header)}**\n\n` : ''}${item.question.trim()}`];
    if (typeof item.detail === 'string' && item.detail.trim()) lines.push(`   ${item.detail.trim()}`);
    if (Array.isArray(item.options)) for (const optionValue of item.options) {
      const option = record(optionValue);
      if (!option || typeof option.label !== 'string') continue;
      lines.push(`   - ${option.label}${typeof option.description === 'string' && option.description.trim() ? ` — ${option.description.trim()}` : ''}`);
    }
    if (item.multiSelect === true) lines.push('   - 可多选');
    return [lines.join('\n')];
  });
  return rendered.length ? `**需要你回答的问题**\n\n${rendered.join('\n\n')}` : '';
}

function prettyToolArgs(value: string): string {
  try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
}

function toolResult(data: RecordValue): { callId?: string; text: string; error: boolean } {
  const result = record(data.message), source = record(result?.source);
  const callId = typeof data.callId === 'string' ? data.callId
    : typeof result?.toolCallId === 'string' ? result.toolCallId
      : typeof source?.callId === 'string' ? source.callId : undefined;
  return { callId, text: textContent(result?.content), error: data.error !== undefined || result?.isError === true };
}

export interface DshChatTurn { id: number; active: boolean }

/** The newest turn boundary decides whether native work is still running. */
export function dshChatTurn(events: unknown[]): DshChatTurn | undefined {
  let active: DshChatTurn | undefined;
  for (const value of events) {
    const event = record(value), data = record(event?.data);
    if (!event || !data) continue;
    if (event.type === 'turn/start' && Number.isSafeInteger(data.turn)) active = { id: data.turn as number, active: true };
    if (event.type === 'turn/end' && Number.isSafeInteger(data.turn)) active = { id: data.turn as number, active: false };
  }
  return active;
}

/**
 * Fold one native event log into the shared chat item shape. Tool results
 * attach to the matching call only; a missing call id is never guessed.
 * AskUserQuestion keeps a readable transcript entry instead of disappearing
 * into an opaque tool row.
 */
export function dshChatItems(events: unknown[], nativeId: string, options: { maxText?: number } = {}): AgentChatItem[] {
  const output: AgentChatItem[] = [];
  const tools = new Map<string, AgentChatItem>();
  const maxText = options.maxText ?? MAX_MESSAGE_TEXT;
  const push = (item: AgentChatItem | undefined): void => { if (item) output.push(item); };
  for (const value of events) {
    const event = record(value), data = record(event?.data);
    if (!event || !data) continue;
    if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch') {
      const call = record(data);
      const seq = String(event.seq);
      if (call?.name === 'ask_user_question') {
        const text = dshQuestionText(call.arguments);
        if (text) push({ id: `dsh:${nativeId}:${seq}`, type: 'assistant', text: clip(text, maxText), status: 'completed', ...(Number.isSafeInteger(data.turn) ? { turnId: String(data.turn) } : {}) });
        continue;
      }
      const name = typeof call?.name === 'string' && call.name.trim() ? call.name.trim() : '工具';
      const callId = typeof call?.callId === 'string' ? call.callId : `seq:${seq}`;
      const args = typeof call?.arguments === 'string' ? call.arguments : call?.arguments === undefined ? undefined : JSON.stringify(call.arguments);
      const item: AgentChatItem = {
        id: `dsh:${nativeId}:${seq}`,
        type: 'tool',
        text: args ? clip(prettyToolArgs(args)) : '',
        title: name,
        status: 'inProgress',
        ...(Number.isSafeInteger(data.turn) ? { turnId: String(data.turn) } : {}),
      };
      tools.set(callId, item);
      push(item);
      continue;
    }
    if (event.type === 'tool/result') {
      const result = toolResult(data);
      if (!result.callId) continue;
      const target = tools.get(result.callId);
      if (!target) continue;
      target.output = result.text ? clip(result.text) : target.output;
      target.status = result.error ? 'failed' : 'completed';
      continue;
    }
    if (event.surfaceOp !== 'append') continue;
    const role = event.type === 'user/message' ? 'user' : event.type === 'assistant/message' ? 'assistant' : undefined;
    const body = role === 'user' ? data : record(data.message);
    if (!role || !body || body.role !== role) continue;
    if (role === 'user' && record(body.source)?.kind !== 'user') continue;
    const text = textContent(body.content);
    if (!text.trim()) continue;
    push({
      id: `dsh:${nativeId}:${String(event.seq)}`,
      type: role,
      text: clip(text, maxText),
      status: 'completed',
      ...(Number.isSafeInteger(data.turn) ? { turnId: String(data.turn) } : {}),
    });
  }
  return output;
}
