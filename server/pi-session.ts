import type { AgentChatItem } from '../shared/chat.ts';
import type { ConversationMessage, ConversationTool } from '../shared/types.ts';

/** The native session file is the source of truth in both RPC and TUI mode.
 * These helpers deliberately accept unknown JSON: Pi evolves its transcript
 * schema, but message roles and content blocks have stayed stable. */
interface PiContentBlock { type?: unknown; text?: unknown; thinking?: unknown; data?: unknown; mimeType?: unknown; id?: unknown; name?: unknown; arguments?: unknown }
interface PiMessage { role?: unknown; content?: unknown; timestamp?: unknown; toolCallId?: unknown; toolName?: unknown; isError?: unknown; usage?: unknown }
interface PiEntry { type?: unknown; id?: unknown; timestamp?: unknown; message?: PiMessage; name?: unknown; summary?: unknown }

// Pi session files use UUIDv7 for new sessions; keep the filename matcher
// version-agnostic so discovery and history do not lose new contacts.
export const PI_SESSION_FILE = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const finite = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function blocks(content: unknown): PiContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  const rows: PiContentBlock[] = [];
  for (const value of content) { const item = record(value); if (item) rows.push(item as PiContentBlock); }
  return rows;
}
function textOf(content: unknown): string {
  return blocks(content).filter(block => block.type === 'text' || block.type === 'input_text' || block.type === 'output_text')
    .map(block => typeof block.text === 'string' ? block.text : '').join('');
}
function imageCount(content: unknown): number {
  return blocks(content).filter(block => block.type === 'image' || block.type === 'input_image').length;
}
function toolCalls(content: unknown): { id: string; name: string; args: unknown }[] {
  return blocks(content).filter(block => block.type === 'toolCall').flatMap(block => typeof block.id === 'string' && typeof block.name === 'string'
    ? [{ id: block.id, name: block.name, args: block.arguments }] : []);
}
function argsText(args: unknown): string {
  if (typeof args === 'string') return args;
  try { return JSON.stringify(args ?? {}, null, 2); } catch { return ''; }
}
function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

export interface PiItemsResult { items: AgentChatItem[]; truncated: boolean }

/** Map a native entry list to Dili's bounded chat items. Tool calls are merged
 * with their later toolResult entry so a restart never shows a stuck spinner. */
export function piEntryItems(entries: readonly unknown[], nativeId: string, maxItems = 250): PiItemsResult {
  const rows: PiEntry[] = [];
  for (const value of entries) { const item = record(value); if (item) rows.push(item as unknown as PiEntry); }
  const results = new Map<string, { text: string; isError: boolean }>();
  for (const entry of rows) {
    const message = entry.message;
    if (entry.type !== 'toolResult' && message?.role !== 'toolResult') continue;
    const callId = typeof message?.toolCallId === 'string' ? message.toolCallId : typeof entry.id === 'string' ? entry.id : undefined;
    if (!callId) continue;
    results.set(callId, { text: textOf(message?.content), isError: message?.isError === true });
  }
  const items: AgentChatItem[] = [];
  let truncated = false;
  const push = (item: AgentChatItem) => { items.push(item); if (items.length > maxItems) { items.shift(); truncated = true; } };
  for (const entry of rows) {
    const message = entry.message;
    if (!message || (entry.type !== 'message' && entry.type !== 'custom_message')) continue;
    const role = message.role;
    if (role === 'user') {
      const text = textOf(message.content);
      if (text || imageCount(message.content)) push({ id: `pi:${nativeId}:${String(entry.id ?? items.length)}`, type: 'user', text: clip(text, 30_000), ...(imageCount(message.content) ? { imageCount: imageCount(message.content) } : {}), status: 'completed' });
      continue;
    }
    if (role !== 'assistant') continue;
    const text = textOf(message.content);
    if (text) push({ id: `pi:${nativeId}:${String(entry.id ?? items.length)}:text`, type: 'assistant', text: clip(text, 60_000), status: 'completed' });
    for (const call of toolCalls(message.content)) {
      const result = results.get(call.id);
      push({ id: `pi:${nativeId}:${String(entry.id ?? items.length)}:tool:${call.id}`, type: 'tool',
        text: clip(argsText(call.args), 20_000), title: call.name, ...(result?.text ? { output: clip(result.text, 40_000) } : {}),
        status: result ? (result.isError ? 'failed' : 'completed') : 'inProgress' });
    }
  }
  return { items, truncated };
}

/** A transcript view for the read-only conversation pane and import previews. */
export function piEntryMessages(entries: readonly unknown[], nativeId: string): { messages: ConversationMessage[]; truncated: boolean } {
  const { items, truncated } = piEntryItems(entries, nativeId, 400);
  const messages: ConversationMessage[] = [];
  for (const item of items) {
    if (item.type === 'user' || item.type === 'assistant') messages.push({ id: item.id, role: item.type, text: item.text });
    else if (item.type === 'tool') {
      const tool: ConversationTool = { callId: item.id.split(':tool:').at(-1) ?? item.id, name: item.title ?? 'tool', ...(item.text ? { args: item.text } : {}), ...(item.output ? { result: item.output } : {}), status: item.status === 'inProgress' ? 'running' : item.status === 'failed' ? 'error' : 'ok' };
      messages.push({ id: item.id, role: 'assistant', text: '', tool });
    }
  }
  return { messages, truncated };
}

export function piSessionName(entries: readonly unknown[]): string | undefined {
  let name: string | undefined;
  for (const entry of entries) {
    const row = record(entry);
    if (row?.type !== 'session_info') continue;
    if (typeof row.name === 'string' && row.name.trim()) name = row.name.trim();
  }
  return name;
}

export interface PiSessionMeta { id: string; cwd: string; title?: string; createdAt?: string; updatedAt?: string }
/** Read only the two ends of a session file: the header carries identity and
 * cwd, while the latest session_info carries a native rename. */
export async function readPiSessionMeta(path: string, read: (path: string, start: number, length: number) => Promise<string>, size: number, mtime: Date): Promise<PiSessionMeta | undefined> {
  const head = await read(path, 0, Math.min(size, 256 * 1024));
  const headLines = head.split('\n').filter(Boolean);
  let header: Record<string, unknown> | undefined;
  try { header = record(headLines[0] ? JSON.parse(headLines[0]) : null); } catch { return undefined; }
  if (!header || header.type !== 'session' || !Number.isInteger(header.version) || typeof header.id !== 'string' || typeof header.cwd !== 'string') return;
  const tailOffset = Math.max(0, size - 256 * 1024);
  const tail = tailOffset ? await read(path, tailOffset, size - tailOffset) : head;
  const entries: unknown[] = [];
  const tailLines = tail.split('\n');
  for (let index = tailOffset ? 1 : 0; index < tailLines.length; index++) {
    const text = tailLines[index];
    if (!text) continue;
    try { entries.push(JSON.parse(text)); } catch { /* torn tail while Pi is appending */ }
  }
  return { id: header.id, cwd: header.cwd, ...(piSessionName(entries) ? { title: piSessionName(entries) } : {}), ...(typeof header.timestamp === 'string' ? { createdAt: header.timestamp } : {}), updatedAt: mtime.toISOString() };
}

export function piUsage(entries: readonly unknown[]): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number; turns: number; model: string | null } | null {
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, total = 0, turns = 0, model: string | null = null, seen = false;
  for (const entry of entries) {
    const message = record(entry)?.message as PiMessage | undefined;
    if (!message || message.role !== 'assistant') continue;
    const usage = record(message.usage);
    if (!usage) continue;
    seen = true; turns++;
    input += finite(usage.input) ?? finite(usage.inputTokens) ?? 0;
    output += finite(usage.output) ?? finite(usage.outputTokens) ?? 0;
    cacheRead += finite(usage.cacheRead) ?? finite(usage.cacheReadTokens) ?? 0;
    cacheWrite += finite(usage.cacheWrite) ?? finite(usage.cacheWriteTokens) ?? 0;
    total += finite(usage.totalTokens) ?? ((finite(usage.input) ?? finite(usage.inputTokens) ?? 0) + (finite(usage.output) ?? finite(usage.outputTokens) ?? 0) + (finite(usage.cacheRead) ?? finite(usage.cacheReadTokens) ?? 0) + (finite(usage.cacheWrite) ?? finite(usage.cacheWriteTokens) ?? 0));
    const messageModel = (message as unknown as Record<string, unknown>).model;
    if (typeof messageModel === 'string') model = messageModel;
  }
  if (!seen) return null;
  return { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, totalTokens: total, turns, model };
}
