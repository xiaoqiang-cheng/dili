import { constants } from 'node:fs';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { open, opendir, realpath, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { zstdDecompressSync } from 'node:zlib';
import type { Backend, ConversationMessage, ConversationTranscript, Session } from '../shared/types.js';
import type { AgentChatHistoryPage } from '../shared/chat.ts';
import { validateNativeId } from './adapters.ts';

export type ConversationSession = Pick<Session, 'backend' | 'nativeSessionId' | 'forkPending' | 'cwd'>;
export interface DshHistory { events?: { event?: unknown }[]; hasMore?: boolean }
export interface ConversationOptions {
  claudeHome?: string;
  codexHome?: string;
  dshHome?: string;
  /** Must be read-only; undefined means the native service is not already running. */
  dshHistory?: (id: string) => Promise<DshHistory | undefined>;
  cacheMs?: number;
  indexMs?: number;
  maxBytes?: number;
  /** Ceiling on a DSH compressed log's file size before it is decoded whole.
   * Decoding is fast relative to typical sizes; this only guards against a
   * truly abnormal file. Larger logs fall back to DSH's own paginated history
   * API instead of decoding here. */
  maxCompressedBytes?: number;
  maxMessages?: number;
}
type RecordValue = Record<string, unknown>;
interface Line { value: RecordValue; offset: number }
interface Cached { checked: number; signature?: string; fileSize?: number; transcript: ConversationTranscript }
interface Index { checked: number; paths: Map<string, string>; databases: string[] }

const UUID = '[a-f\\d]{8}-[a-f\\d]{4}-[a-f\\d]{4}-[a-f\\d]{4}-[a-f\\d]{12}';
const MAX_TEXT = 24_000;
const MAX_TOTAL_TEXT = 512_000;
const EMPTY_NOTICE = '原生历史尚未落盘，或当前原生版本未提供可读取的文本记录。';
const record = (value: unknown): RecordValue | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
function timestamp(value: unknown): string | undefined {
  const date = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(date) && Math.abs(date) <= 8.64e15 ? new Date(date).toISOString() : undefined;
}
function textContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.flatMap(block => {
    const part = record(block);
    return part && ['text', 'input_text', 'output_text'].includes(String(part.type)) && typeof part.text === 'string' ? [part.text] : [];
  }).join('\n');
}
function questionContent(value: unknown): string {
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
function lines(text: string, offset = 0): Line[] {
  const result: Line[] = [];
  for (const line of text.split('\n')) {
    try { const value = record(JSON.parse(line)); if (value) result.push({ value, offset }); } catch { /* A torn tail or bad record cannot hide subsequent complete messages. */ }
    offset += Buffer.byteLength(line) + 1;
  }
  return result;
}
function message(id: string, role: ConversationMessage['role'], text: string, date: unknown): ConversationMessage | undefined {
  if (!text.trim()) return;
  return { id, role, text, ...(timestamp(date) ? { createdAt: timestamp(date) } : {}) };
}
function syntheticCodexUser(text: string): boolean {
  return /^(?:# AGENTS\.md instructions(?:\s|$)|<environment_context>|<permissions instructions>|<developer_instructions>|<system_instructions>|<user_instructions>|<INSTRUCTIONS>)/.test(text.trimStart());
}

function claudeMessages(rows: Line[], nativeId: string): ConversationMessage[] {
  const output: ConversationMessage[] = [];
  for (const { value: row, offset } of rows) {
    if (row.type !== 'user' && row.type !== 'assistant') continue;
    if (row.sessionId !== undefined && row.sessionId !== nativeId) continue;
    // Sidechains, compaction summaries, and tool-result wrappers are not human prompts.
    if (row.isSidechain === true || row.isMeta === true || row.isCompactSummary === true || row.toolUseResult !== undefined) continue;
    const body = record(row.message);
    if (!body || (body.role !== undefined && body.role !== row.type)) continue;
    if (row.type === 'user' && Array.isArray(body.content) && body.content.some(block => record(block)?.type === 'tool_result')) continue;
    const content = Array.isArray(body.content) ? body.content : [];
    const text = typeof body.content === 'string' ? body.content : content.flatMap(blockValue => {
      const block = record(blockValue);
      if (!block) return [];
      if (block.type === 'text' && typeof block.text === 'string') return [block.text];
      if (row.type === 'assistant' && block.type === 'tool_use' && block.name === 'AskUserQuestion') {
        const questions = questionContent(record(block.input)?.questions);
        return questions ? [questions] : [];
      }
      return [];
    }).join('\n\n');
    if (row.type === 'user' && /^(?:<local-command-|<command-name>|<system-reminder>|\[Request interrupted by user)/.test(text.trimStart())) continue;
    const hasImage = row.type === 'user' && content.some(block => record(block)?.type === 'image');
    const item = message(`claude:${nativeId}:${typeof row.uuid === 'string' ? row.uuid : offset}`, row.type, text || (hasImage ? '[图片]' : ''), row.timestamp);
    if (item) output.push(item);
  }
  return output;
}

function codexMessages(rows: Line[], nativeId: string): ConversationMessage[] {
  // Native event_msg user_message records distinguish an actual prompt from
  // AGENTS/environment instructions which also have role=user in model input.
  const hasUserEvents = rows.some(({ value }) => value.type === 'event_msg' && record(value.payload)?.type === 'user_message');
  const hasAssistantItems = rows.some(({ value }) => value.type === 'response_item' && record(value.payload)?.type === 'message' && record(value.payload)?.role === 'assistant');
  const output: ConversationMessage[] = [];
  for (const { value: row, offset } of rows) {
    const body = record(row.payload);
    if (!body) continue;
    let role: ConversationMessage['role'] | undefined, text = '';
    if (row.type === 'event_msg' && body.type === 'user_message') { role = 'user'; text = typeof body.message === 'string' ? body.message : ''; }
    else if (row.type === 'event_msg' && body.type === 'agent_message' && !hasAssistantItems) { role = 'assistant'; text = typeof body.message === 'string' ? body.message : ''; }
    else if (row.type === 'response_item' && body.type === 'message') {
      if (body.role === 'assistant') { role = 'assistant'; text = textContent(body.content); }
      else if (body.role === 'user' && !hasUserEvents) { role = 'user'; text = textContent(body.content); if (syntheticCodexUser(text)) continue; }
    }
    if (!role) continue;
    const item = message(`codex:${nativeId}:${typeof body.id === 'string' ? body.id : offset}`, role, text, row.timestamp);
    if (item) output.push(item);
  }
  return output;
}

function dshMessages(events: unknown[], nativeId: string): ConversationMessage[] {
  const output: ConversationMessage[] = [];
  for (const value of events) {
    const event = record(value), data = record(event?.data);
    if (!event || !data) continue;
    if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch') {
      const call = record(data);
      if (call?.name === 'ask_user_question') {
        const text = questionContent(call.arguments);
        const item = message(`dsh:${nativeId}:${String(event.seq)}`, 'assistant', text, event.time);
        if (item) output.push(item);
      }
      continue;
    }
    if (event.surfaceOp !== 'append') continue;
    const role = event.type === 'user/message' ? 'user' : event.type === 'assistant/message' ? 'assistant' : undefined;
    const body = role === 'user' ? data : record(data.message);
    if (!role || !body || body.role !== role) continue;
    if (role === 'user' && record(body.source)?.kind !== 'user') continue;
    const item = message(`dsh:${nativeId}:${String(event.seq)}`, role, textContent(body.content), event.time);
    if (item) output.push(item);
  }
  return output;
}

function nativeMessages(rows: Line[], session: ConversationSession): ConversationMessage[] {
  const id = session.nativeSessionId!;
  return session.backend === 'claude' ? claudeMessages(rows, id) : session.backend === 'codex' ? codexMessages(rows, id) : dshMessages(rows.map(row => row.value), id);
}

export function decodeDshFrames(buffer: Buffer, maxOutput: number): { text: string; truncated: boolean } {
  // DSH appends independent Zstandard frames. Node's convenience decoder stops
  // after the first frame (normally only the session header), so advance by
  // its consumed input bytes and keep a shared decompression budget.
  const chunks: Buffer[] = [];
  let offset = 0, total = 0, frames = 0;
  while (offset < buffer.length) {
    if (++frames > 4096 || total >= maxOutput) throw new Error('Native compressed history exceeds its decode budget');
    let decoded: { buffer: Buffer; engine: { bytesWritten: number } };
    try { decoded = zstdDecompressSync(buffer.subarray(offset), { info: true, maxOutputLength: maxOutput - total }) as unknown as typeof decoded; }
    catch (error) {
      // A concurrent append may expose a torn final frame; completed earlier
      // frames remain readable. Corruption/size errors do not get this fallback.
      if (offset > 0 && (error as NodeJS.ErrnoException).code === 'Z_BUF_ERROR') return { text: Buffer.concat(chunks, total).toString('utf8'), truncated: true };
      throw error;
    }
    const consumed = decoded.engine.bytesWritten;
    if (!Number.isSafeInteger(consumed) || consumed <= 0 || consumed > buffer.length - offset) throw new Error('Invalid native compressed frame');
    chunks.push(decoded.buffer); total += decoded.buffer.length; offset += consumed;
  }
  return { text: Buffer.concat(chunks, total).toString('utf8'), truncated: false };
}

/** A card preview is a readable excerpt of an actual saved user message. */
export function conversationPreview(transcript: ConversationTranscript): { text: string; createdAt?: string } | null {
  const user = transcript.messages.findLast(item => item.role === 'user');
  if (!user) return null;
  const normalized = user.text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(normalized);
  return { text: chars.length > 240 ? chars.slice(0, 239).join('') + '…' : normalized, ...(user.createdAt ? { createdAt: user.createdAt } : {}) };
}

/** Bounded, portable context for continuing a conversation in another agent. */
export function handoffPrompt(source: Pick<Session, 'backend' | 'title' | 'cwd' | 'id'>, transcript: ConversationTranscript, target: Backend, customSummary?: string): string {
  const label: Record<Backend, string> = { claude: 'Claude Code', codex: 'Codex', dsh: 'DeepSeek Harness' };
  const messages = transcript.messages.slice(-20);
  const body = messages.map(item => `### ${item.role === 'user' ? '用户' : 'Agent'}\n${item.text.slice(0, 6000)}`).join('\n\n');
  const summary = customSummary?.trim() || '请先检查当前工作区和文件状态，再继续完成原任务。';
  return `# 跨平台会话交接\n\n来源平台：${label[source.backend]}\n目标平台：${label[target]}\n来源会话：${source.title}\n工作目录：${source.cwd}\n\n## 当前目标与进展\n${summary}\n\n## 最近对话\n${body || '暂无可读取的历史对话。'}\n\n## 继续要求\n这是从 ${label[source.backend]} 转交来的上下文。请基于以上信息继续工作，不要假设来源工具已经执行过未核实的操作；先确认当前文件状态，再执行必要操作。`;
}

/** Read-only views of exact native identities. No native process is launched,
 * no prompt is submitted, and no transcript is copied into SessionDeck's DB. */
export class ConversationReader {
  private readonly homes: Record<Backend, string>;
  private readonly options: ConversationOptions;
  private readonly cache = new Map<string, Cached>();
  private readonly pending = new Map<string, Promise<ConversationTranscript>>();
  private readonly indexes = new Map<Backend, Index>();
  private readonly scans = new Map<Backend, Promise<Index>>();
  private readonly cursorKey = randomBytes(32);
  constructor(options: ConversationOptions = {}) {
    this.options = options;
    this.homes = {
      claude: resolve(options.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')),
      codex: resolve(options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')),
      dsh: resolve(options.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')),
    };
  }

  async read(session: ConversationSession): Promise<ConversationTranscript> {
    if (session.forkPending) return { messages: [], truncated: false, notice: 'Fork 尚未生成独立原生会话，完成初始化后即可读取。' };
    if (!session.nativeSessionId) return { messages: [], truncated: false, notice: '启动原生会话后，这里会显示已保存的对话。' };
    try { validateNativeId(session.backend, session.nativeSessionId); }
    catch { return { messages: [], truncated: false, notice: '原生会话 ID 无效，无法读取历史。' }; }
    const key = `${session.backend}:${session.nativeSessionId}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.checked < (this.options.cacheMs ?? 1500)) return cached.transcript;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const job = this.load(session, key).catch((): ConversationTranscript => ({ messages: [], truncated: false, notice: '暂时无法读取原生历史，请稍后刷新或进入原生界面查看。' })).then(transcript => {
      const latest = this.cache.get(key);
      this.cache.delete(key);
      this.cache.set(key, { ...(latest?.transcript === transcript ? latest : {}), checked: Date.now(), transcript });
      while (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value!);
      return transcript;
    }).finally(() => { this.pending.delete(key); });
    this.pending.set(key, job);
    return job;
  }

  async preview(session: ConversationSession): Promise<string | null> { return conversationPreview(await this.read(session))?.text ?? null; }

  /** Read a bounded, append-stable page without starting the native CLI. The
   * cursor names a byte boundary, never a client-supplied filesystem path. */
  async readClaudePage(nativeId: string, cursor?: string): Promise<AgentChatHistoryPage> {
    validateNativeId('claude', nativeId);
    const stale = (): never => { throw Object.assign(new Error('历史游标已失效，请刷新会话后重新加载。'), { status: 409 }); };
    type Position = { id: string; dev: number; ino: number; size: number; end: number; head: string };
    let position: Position | undefined;
    if (cursor) {
      if (cursor.length > 8192) return stale();
      const [payload, signature, extra] = cursor.split('.');
      if (!payload || !signature || !/^[A-Za-z0-9_-]+$/.test(signature) || extra !== undefined) return stale();
      const expected = createHmac('sha256', this.cursorKey).update(payload).digest('base64url');
      if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return stale();
      try { position = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return stale(); }
      if (!position || position.id !== nativeId || !Number.isSafeInteger(position.end) || position.end <= 0 || position.end > position.size) return stale();
    }
    let index = await this.index('claude');
    if (!index.paths.has(nativeId)) { this.indexes.delete('claude'); index = await this.index('claude'); }
    const path = index.paths.get(nativeId);
    const safe = path && await this.safePath('claude', path);
    const empty: AgentChatHistoryPage = { nativeSessionId: nativeId, items: [], nextCursor: null, truncated: false };
    if (!safe) return cursor ? stale() : empty;
    let file: FileHandle;
    try { file = await open(safe, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch { return cursor ? stale() : empty; }
    try {
      const info = await file.stat();
      if (!info.isFile()) return cursor ? stale() : empty;
      if (position && (info.dev !== position.dev || info.ino !== position.ino || info.size < position.size)) return stale();
      const size = position?.size ?? info.size;
      if (!size) return empty;
      const header = Buffer.alloc(Math.min(size, 4096));
      const headRead = await file.read(header, 0, header.length, 0);
      const head = createHash('sha256').update(header.subarray(0, headRead.bytesRead)).digest('base64url');
      if (position && head !== position.head) return stale();
      const end = position?.end ?? size;
      const maxBytes = Math.max(1024, Math.min(2 * 1024 * 1024, this.options.maxBytes ?? 2 * 1024 * 1024));
      const start = Math.max(0, end - maxBytes);
      // One preceding byte distinguishes a line boundary from a cut record.
      const from = start > 0 ? start - 1 : 0;
      const buffer = Buffer.alloc(end - from);
      const read = await file.read(buffer, 0, buffer.length, from);
      const bytes = buffer.subarray(0, read.bytesRead);
      const first = start > 0 ? bytes.indexOf(10) + 1 : 0;
      const last = bytes.lastIndexOf(10) + 1;
      let nextEnd = start > 0 && first > 0 && from + first < end ? from + first : start;
      let truncated = read.bytesRead !== buffer.length || last < bytes.length || (start > 0 && last <= first);
      const rows = last > first ? lines(bytes.subarray(first, last).toString('utf8'), from + first) : [];
      const items: AgentChatHistoryPage['items'] = [];
      const known = new Set<string>();
      let total = 0;
      let includedStart = nextEnd;
      for (const row of rows.toReversed()) {
        const item = claudeMessages([row], nativeId)[0];
        if (!item || known.has(item.id)) continue;
        if (total + Math.min(item.text.length, MAX_TEXT) > MAX_TOTAL_TEXT) { nextEnd = includedStart; break; }
        known.add(item.id);
        if (item.text.length > MAX_TEXT) truncated = true;
        const text = item.text.length > MAX_TEXT ? item.text.slice(0, MAX_TEXT - 1) + '…' : item.text;
        const content = record(row.value.message)?.content;
        const imageCount = item.role === 'user' && Array.isArray(content) ? content.filter(block => record(block)?.type === 'image').length : 0;
        items.unshift({ id: item.id, type: item.role, text, status: 'completed', ...(imageCount ? { imageCount } : {}) });
        total += text.length;
        includedStart = row.offset;
        // If the next row exceeds the count budget, resume before this one.
        if (items.length === 40) { nextEnd = row.offset; break; }
      }
      if (nextEnd >= end) return stale();
      let nextCursor: string | null = null;
      if (nextEnd > 0) {
        const payload = Buffer.from(JSON.stringify({ id: nativeId, dev: info.dev, ino: info.ino, size, end: nextEnd, head } satisfies Position)).toString('base64url');
        nextCursor = payload + '.' + createHmac('sha256', this.cursorKey).update(payload).digest('base64url');
      }
      return { ...empty, items, nextCursor, truncated };
    } finally { await file.close(); }
  }

  /** A transport handoff must hydrate the just-finished native turn, even if
   * an earlier poll cached the transcript before it was saved. */
  async readLatest(session: ConversationSession): Promise<ConversationTranscript> {
    const key = `${session.backend}:${session.nativeSessionId}`;
    await this.pending.get(key);
    this.cache.delete(key); this.indexes.delete(session.backend);
    return this.read(session);
  }

  private finish(messages: ConversationMessage[], truncated: boolean, updatedAt?: string): ConversationTranscript {
    const latestUser = messages.findLast(item => item.role === 'user');
    const maxMessages = Math.max(1, Math.min(200, this.options.maxMessages ?? 200));
    if (messages.length > maxMessages) { truncated = true; messages = messages.slice(-maxMessages); }
    let total = 0;
    const result: ConversationMessage[] = [];
    for (const item of messages.toReversed()) {
      if (total >= MAX_TOTAL_TEXT) { truncated = true; break; }
      const limit = Math.min(MAX_TEXT, MAX_TOTAL_TEXT - total);
      if (item.text.length > limit) { truncated = true; result.push({ ...item, text: item.text.slice(0, limit - 1) + '…' }); }
      else result.push(item);
      total += Math.min(limit, item.text.length);
    }
    result.reverse();
    // A long agent turn can contain hundreds of assistant progress messages.
    // Keep its last human request visible and eligible for the contact preview
    // even when older progress messages must leave the bounded response.
    if (latestUser && !result.some(item => item.id === latestUser.id)) {
      const user = latestUser.text.length > MAX_TEXT ? { ...latestUser, text: latestUser.text.slice(0, MAX_TEXT - 1) + '…' } : latestUser;
      while (result.length && (result.length >= maxMessages || total + user.text.length > MAX_TOTAL_TEXT)) total -= result.shift()!.text.length;
      result.unshift(user);
      truncated = true;
    }
    return { messages: result, truncated, ...(updatedAt ? { updatedAt } : {}), ...(truncated ? { notice: '当前显示最近的部分对话，完整记录可在原生界面查看。' } : {}) };
  }

  private async load(session: ConversationSession, key: string): Promise<ConversationTranscript> {
    const nativeId = session.nativeSessionId!;
    if (session.backend === 'dsh' && this.options.dshHistory) {
      try {
        const history = await this.options.dshHistory(nativeId);
        if (history && Array.isArray(history.events)) {
          const messages = dshMessages(history.events.map(item => item.event), nativeId);
          return this.finish(messages, history.hasMore === true, messages.at(-1)?.createdAt);
        }
      } catch { /* The service may be restarting; the saved exact log is still usable. */ }
    }
    const index = await this.index(session.backend);
    // A resumed Codex writer can rotate to a new segment without changing the
    // thread ID. Its native database is authoritative and must be rechecked
    // even when the directory index still contains the previous segment.
    const path = (session.backend === 'codex' ? await this.codexPath(index, nativeId) : undefined) ?? index.paths.get(nativeId);
    if (!path) return { messages: [], truncated: false, notice: EMPTY_NOTICE };
    const safe = await this.safePath(session.backend, path);
    if (!safe) return { messages: [], truncated: false, notice: EMPTY_NOTICE };
    const file = await open(safe, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile()) return { messages: [], truncated: false, notice: EMPTY_NOTICE };
      const signature = `${safe}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
      const cached = this.cache.get(key);
      if (cached?.signature === signature) return cached.transcript;
      const maxBytes = Math.max(1024, Math.min(2 * 1024 * 1024, this.options.maxBytes ?? 2 * 1024 * 1024));
      let contents: string, offset = 0, truncated = false;
      if (path.endsWith('.zstd')) {
        // The whole compressed log is decoded, not just a tail window: a
        // Zstandard frame cannot be entered at an arbitrary byte offset like
        // plain text can. Decoding is fast relative to typical log sizes
        // (tens of milliseconds for single-digit megabytes); the signature
        // check above already skips re-decoding an unchanged file, and
        // finish() below still bounds the returned message count and text.
        // Only a log past this generous ceiling is left to DSH's own running,
        // paginated history API instead of decoding it here.
        const maxCompressedBytes = Math.max(maxBytes, this.options.maxCompressedBytes ?? 64 * 1024 * 1024);
        if (info.size > maxCompressedBytes) return { messages: [], truncated: true, notice: '原生压缩历史较大，请先打开 DeepSeek 原生界面，再刷新对话。' };
        const buffer = Buffer.alloc(info.size);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        try { const decoded = decodeDshFrames(buffer.subarray(0, bytesRead), Math.max(MAX_TOTAL_TEXT, maxCompressedBytes * 4)); contents = decoded.text; truncated = decoded.truncated; }
        catch { return { messages: [], truncated: true, notice: '原生压缩历史暂时无法读取，请打开 DeepSeek 原生界面后刷新。' }; }
      } else {
        const size = Math.min(info.size, maxBytes);
        offset = Math.max(0, info.size - size);
        const buffer = Buffer.alloc(size);
        const { bytesRead } = await file.read(buffer, 0, size, offset);
        const bytes = buffer.subarray(0, bytesRead);
        contents = bytes.toString('utf8');
        if (offset) {
          truncated = true;
          const next = bytes.indexOf(10);
          offset += next + 1;
          contents = next < 0 ? '' : bytes.subarray(next + 1).toString('utf8');
        }
      }
      const rows = lines(contents, offset);
      // Verify the immutable native header independently of the tail window.
      if (session.backend !== 'claude') {
        let header: RecordValue | undefined;
        if (offset === 0) header = rows[0]?.value;
        else {
          const head = Buffer.alloc(Math.min(info.size, 128 * 1024));
          const read = await file.read(head, 0, head.length, 0);
          try { header = record(JSON.parse(head.subarray(0, read.bytesRead).toString('utf8').split('\n')[0])); } catch { /* invalid native header */ }
        }
        if (session.backend === 'codex' ? header?.type !== 'session_meta' || record(header.payload)?.id !== nativeId : header?.type !== 'session' || header.id !== nativeId) return { messages: [], truncated: false, notice: '原生历史身份不匹配，未读取此记录。' };
      }
      const messages = nativeMessages(rows, session);
      if (offset && !messages.some(item => item.role === 'user')) {
        // Progress/tool output can push the last prompt out of the tail byte
        // window. Reuse it for append-only changes, otherwise search backward
        // with bounded chunks instead of loading the entire rollout in RAM.
        const appendOnly = cached?.signature?.startsWith(`${safe}:${info.dev}:${info.ino}:`) && cached.fileSize !== undefined && info.size > cached.fileSize && info.size - cached.fileSize < maxBytes;
        const user = (appendOnly ? cached?.transcript.messages.findLast(item => item.role === 'user') : undefined)
          ?? await this.userBefore(file, offset, session);
        if (user) messages.unshift(user);
      }
      const transcript = this.finish(messages, truncated, info.mtime.toISOString());
      this.cache.set(key, { checked: Date.now(), signature, fileSize: info.size, transcript });
      return transcript;
    } finally { await file.close(); }
  }

  private async userBefore(file: FileHandle, end: number, session: ConversationSession): Promise<ConversationMessage | undefined> {
    let carry: Buffer = Buffer.alloc(0), budget = 64 * 1024 * 1024;
    while (end > 0 && budget > 0) {
      const size = Math.min(end, budget, 256 * 1024), start = end - size;
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await file.read(buffer, 0, size, start);
      if (bytesRead !== size) return; // The native log changed underneath us.
      const block = Buffer.concat([buffer, carry]);
      const boundary = start === 0 ? 0 : block.indexOf(10) + 1;
      if (boundary || start === 0) {
        const rows = lines(block.subarray(boundary).toString('utf8'), start + boundary);
        const user = nativeMessages(rows, session).findLast(item => item.role === 'user');
        if (user) return user;
      }
      const prefix = boundary ? block.subarray(0, boundary) : block;
      // Skip oversized records (usually embedded tool/media data), retaining
      // the same maximum record budget as the ordinary tail read.
      carry = prefix.length <= 2 * 1024 * 1024 ? prefix : Buffer.alloc(0);
      end = start; budget -= size;
    }
    return;
  }

  private async safePath(backend: Backend, path: string): Promise<string | undefined> {
    try {
      const root = await realpath(this.homes[backend]);
      const absolute = resolve(path);
      const resolved = await realpath(absolute);
      // Refuse final and intermediate symlinks, including native metadata that
      // points to a path outside the configured native home.
      if (resolved !== absolute && resolved !== join(root, relative(this.homes[backend], absolute))) return;
      const part = relative(root, resolved);
      if (!part || part.startsWith('..') || isAbsolute(part)) return;
      return absolute;
    } catch { return; }
  }

  private async codexPath(index: Index, nativeId: string): Promise<string | undefined> {
    for (const path of index.databases) {
      const safe = await this.safePath('codex', path);
      if (!safe) continue;
      let db: DatabaseSync | undefined;
      try {
        db = new DatabaseSync(safe, { readOnly: true });
        const row = db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(nativeId) as { rollout_path?: unknown } | undefined;
        if (typeof row?.rollout_path !== 'string') continue;
        const candidate = resolve(row.rollout_path);
        const part = relative(this.homes.codex, candidate);
        if (!/^(?:sessions|archived_sessions)[/\\]/.test(part) || !new RegExp(`(?:^|-)${nativeId}(?:_${UUID})?\\.jsonl$`, 'i').test(basename(candidate))) continue;
        const checked = await this.safePath('codex', candidate);
        if (checked) return checked;
      } catch { /* migration or older index: inspect the next native index */ }
      finally { db?.close(); }
    }
    return;
  }

  private async index(backend: Backend): Promise<Index> {
    const current = this.indexes.get(backend);
    if (current && Date.now() - current.checked < (this.options.indexMs ?? 30_000)) return current;
    const pending = this.scans.get(backend);
    if (pending) return pending;
    const job = this.scan(backend).then(index => { this.indexes.set(backend, index); return index; }).finally(() => this.scans.delete(backend));
    this.scans.set(backend, job);
    return job;
  }

  private async scan(backend: Backend): Promise<Index> {
    const home = this.homes[backend], result: Index = { checked: Date.now(), paths: new Map(), databases: [] };
    const folders = backend === 'claude' ? [{ path: join(home, 'projects'), depth: 0 }] : backend === 'codex' ? [{ path: home, depth: -1 }] : [{ path: join(home, 'sessions'), depth: 0 }];
    let budget = 12_000, directoryBudget = 1500;
    const deadline = Date.now() + 2000;
    while (folders.length && budget > 0 && directoryBudget-- > 0 && Date.now() < deadline) {
      const folder = folders.shift()!;
      try {
        const directory = await opendir(folder.path);
        const children: { path: string; depth: number }[] = [];
        for await (const entry of directory) {
          if (--budget <= 0 || Date.now() >= deadline) break;
          const path = join(folder.path, entry.name);
          if (entry.isDirectory()) {
            const limit = backend === 'claude' ? 1 : backend === 'codex' ? 4 : 2;
            if (folder.depth < limit && (folder.depth !== -1 || ['sessions', 'archived_sessions'].includes(entry.name))) children.push({ path, depth: folder.depth + 1 });
          } else if (entry.isFile()) {
            if (backend === 'codex' && folder.depth === -1 && /^state_\d+\.sqlite$/.test(entry.name)) result.databases.push(path);
            let id: string | undefined;
            if (backend === 'claude') id = entry.name.match(new RegExp(`^(${UUID})\\.jsonl$`, 'i'))?.[1];
            else if (backend === 'codex') id = entry.name.match(new RegExp(`(?:^|-)(${UUID})(?:_${UUID})?\\.jsonl$`, 'i'))?.[1];
            // dsh 0.1: sessions/<slug>/session-<uuid>/session.jsonl(.zstd);
            // dsh 0.2 / dsh-tui: sessions/<slug>/<uuid>/session.v4.jsonl.zstd.
            else if (/^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(entry.name) && new RegExp(`^(?:session-)?${UUID}$`, 'i').test(basename(dirname(path)))) id = basename(dirname(path));
            if (id) {
              const previous = result.paths.get(id);
              // Codex segment names start with their creation timestamp; the
              // optional writer UUID is not a separate native thread.
              if (backend !== 'codex' || !previous || basename(path) > basename(previous)) result.paths.set(id, path);
            }
          }
        }
        children.sort((a, b) => b.path.localeCompare(a.path));
        folders.unshift(...children);
      } catch { /* Native roots may not exist before the first session. */ }
    }
    result.databases.sort((a, b) => Number(basename(b).match(/\d+/)?.[0]) - Number(basename(a).match(/\d+/)?.[0]));
    result.databases.length = Math.min(8, result.databases.length);
    return result;
  }
}
