import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentChatAnswer, AgentChatChoice, AgentChatItem, AgentChatRequest, AgentChatSettings, AgentChatSettingsUpdate, AgentChatSnapshot } from '../shared/chat.ts';
import type { SessionStatus } from '../shared/types.ts';
import { findExecutable } from './adapters.ts';
import { OwnedProcess } from './owned-process.ts';
import { piEntryItems } from './pi-session.ts';
import { effortChoices as sharedEffortChoices } from '../shared/effort.ts';

/** A Pi session is identified by a UUID. Pi also accepts dotted/underscored
 * ids for its own imports, but Dili only creates and resumes UUIDs. */
// Pi mints UUIDv7 for new sessions, so accept every RFC 4122 version rather
// than the older v4-only pattern.
export const PI_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PiOpenSession {
  /** Existing native identity, or null when Dili should allocate one. */
  nativeSessionId: string | null;
  /** Parent id when this contact is a pending native fork. */
  forkFrom?: string | null;
  cwd: string;
  title: string;
}
export interface PiNativeSession { nativeSessionId: string; sessionFile: string | null; sessionName: string | null; model: string | null; thinkingLevel: string | null }
export interface PiNativeStatus { status: SessionStatus; detail: string; timestamp: string; attentionKey?: string }
export interface PiBridgeOptions { executable?: string; env?: NodeJS.ProcessEnv; startupTimeoutMs?: number; requestTimeoutMs?: number }
type PiModel = { id: string; name?: string; provider: string; reasoning?: boolean; contextWindow?: number };
type PiPending = { command: string; resolve: (data: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type PiUiPending = { uiId: string; request: AgentChatRequest; method: string; timeout?: NodeJS.Timeout };

interface PiConnection {
  nativeId: string;
  child: ChildProcessWithoutNullStreams;
  owned: OwnedProcess;
  exit: Promise<void>;
  closed: boolean;
  ready: boolean;
  stdout: string;
  stderr: string;
  sequence: number;
  pending: Map<string, PiPending>;
  requests: Map<string, PiUiPending>;
  revision: number;
  connected: boolean;
  activeTurnId: string | null;
  expectedTurnId: string | null;
  queuedTurnIds: string[];
  turnEnded: boolean;
  settledCount: number;
  status: SessionStatus;
  detail: string;
  sessionFile: string | null;
  sessionName: string | null;
  model: PiModel | null;
  thinkingLevel: string | null;
  settingsVersion: string | null;
  rawEntries: unknown[];
  lastEntryId: string | null;
  entryItems: AgentChatItem[];
  truncated: boolean;
  liveText: { id: string; text: string } | null;
  liveTools: Map<string, AgentChatItem>;
  liveUser: AgentChatItem | null;
  /** Entry id at the moment the live prompt was accepted; only a user entry
   * after this anchor may retire the optimistic item. */
  liveUserAnchor: string | null;
  refreshing: boolean;
  refreshAgain: boolean;
  refreshTimer: NodeJS.Timeout | null;
  disposed: boolean;
}

function now() { return new Date().toISOString(); }
function textContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(item => item && typeof item === 'object' && (item as { type?: unknown }).type === 'text' && typeof (item as { text?: unknown }).text === 'string' ? (item as { text: string }).text : '').join('');
}
const IMAGE_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const clipText = (value: string, max: number) => value.length > max ? value.slice(0, max - 1) + '…' : value;

/** Dili is the only UI and control plane for Pi. This bridge speaks Pi's
 * documented RPC protocol over stdio; the native session file remains the
 * authority for history, and closing a process never deletes a session. */
export class PiBridge {
  private readonly connections = new Map<string, PiConnection>();
  private readonly statusListeners = new Set<(nativeId: string, status: PiNativeStatus) => void>();
  private readonly chatListeners = new Set<(nativeId: string) => void>();
  private readonly options: PiBridgeOptions;
  constructor(options: PiBridgeOptions = {}) { this.options = options; }

  onStatus(listener: (nativeId: string, status: PiNativeStatus) => void): () => void { this.statusListeners.add(listener); return () => this.statusListeners.delete(listener); }
  onChat(listener: (nativeId: string) => void): () => void { this.chatListeners.add(listener); return () => this.chatListeners.delete(listener); }
  has(nativeId: string | null | undefined): boolean { return !!nativeId && !!this.connections.get(nativeId)?.ready; }

  getStatus(nativeId: string): PiNativeStatus {
    const connection = this.connections.get(nativeId);
    if (!connection) return { status: 'stopped', detail: 'Pi 会话未启动', timestamp: now() };
    return { status: connection.status, detail: connection.detail, timestamp: now() };
  }

  async open(session: PiOpenSession): Promise<PiNativeSession> {
    const executable = this.options.executable ?? await findExecutable('pi');
    if (!executable) throw new Error('未找到 Pi 原生命令，请安装 @earendil-works/pi-coding-agent 后刷新检测');
    let expected = session.nativeSessionId;
    if (session.forkFrom) expected = randomUUID();
    if (!expected) expected = randomUUID();
    if (!PI_UUID.test(expected)) throw new Error('Pi 原生会话 ID 格式无效');
    if (session.forkFrom && !PI_UUID.test(session.forkFrom)) throw new Error('Pi Fork 来源会话 ID 格式无效');
    const existing = this.connections.get(expected);
    if (existing) {
      if (existing.disposed) {
        // A previous close is still reaping the process. Wait for its exit
        // rather than spawning a second writer for the same native id.
        await Promise.race([existing.exit, delay(2000)]);
        if (existing.child.exitCode === null) throw new Error('Pi 旧进程仍在退出，请稍后重试');
      } else await this.close(expected);
      if (this.connections.get(expected) === existing) this.connections.delete(expected);
    }

    const args = ['--mode', 'rpc'];
    if (session.forkFrom) args.push('--fork', session.forkFrom, '--session-id', expected, '--name', session.title);
    // `--session-id` resumes the current directory's session with this id and
    // creates one if it does not exist yet. An empty Pi session has no file
    // until its first message, so `--session <file>` would fail a handoff back
    // to chat; the id form keeps the same identity across both cases.
    else if (session.nativeSessionId) args.push('--session-id', expected);
    else args.push('--session-id', expected, '--name', session.title);
    // A native agent may run arbitrary tools; it never needs Dili's owner token.
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...this.options.env };
    delete childEnv.SESSIONDECK_TOKEN;
    const child = spawn(executable, args, {
      cwd: session.cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let exitResolve!: () => void;
    const exit = new Promise<void>(resolve => { exitResolve = resolve; });
    child.once('exit', exitResolve);
    child.once('error', exitResolve);
    if (child.pid === undefined) { child.kill(); throw new Error('无法启动 Pi 原生进程'); }
    const owned = new OwnedProcess(child.pid, exit, signal => { child.kill(signal); });
    const connection: PiConnection = {
      nativeId: expected, child, owned, exit, closed: false, ready: false, stdout: '', stderr: '', sequence: 0,
      pending: new Map(), requests: new Map(), revision: 0, connected: false, activeTurnId: null, expectedTurnId: null, queuedTurnIds: [], turnEnded: false, settledCount: 0,
      status: 'unknown', detail: '正在连接 Pi 原生会话', sessionFile: null, sessionName: null, model: null, thinkingLevel: null, settingsVersion: null,
      rawEntries: [], lastEntryId: null, entryItems: [], truncated: false, liveText: null, liveTools: new Map(), liveUser: null, liveUserAnchor: null, refreshing: false, refreshAgain: false, refreshTimer: null, disposed: false,
    };
    this.connections.set(expected, connection);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consume(connection, chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { connection.stderr = (connection.stderr + chunk).slice(-16_384); });
    child.on('exit', (code, signal) => this.exited(connection, code, signal));
    child.on('error', error => this.failed(connection, error));

    try {
      const state = await this.request(connection, { type: 'get_state' }, this.options.startupTimeoutMs ?? 20_000) as Record<string, unknown>;
      if (typeof state?.sessionId !== 'string' || state.sessionId !== expected) throw new Error(`Pi 返回的会话身份不一致（期望 ${expected}，实际 ${String(state?.sessionId ?? '未知')}）`);
      connection.sessionFile = typeof state.sessionFile === 'string' ? state.sessionFile : null;
      connection.sessionName = typeof state.sessionName === 'string' ? state.sessionName : null;
      connection.thinkingLevel = typeof state.thinkingLevel === 'string' ? state.thinkingLevel : null;
      const model = state.model && typeof state.model === 'object' ? state.model as PiModel : null;
      connection.model = model;
      // Long Pi sessions can be much larger than one JSONL RPC frame. Read a
      // bounded tail of the native file first; the RPC remains the fallback and
      // the authority for live incremental updates.
      const fromFile = await this.recentEntries(connection.sessionFile);
      if (fromFile?.length) this.setEntries(connection, fromFile);
      else if (connection.sessionFile && await stat(connection.sessionFile).then(info => info.size > 8 * 1024 * 1024, () => false)) {
        // A single record larger than the tail budget cannot be parsed; do not
        // pull an unbounded whole-session frame into the RPC reader.
        connection.entryItems = []; connection.truncated = true;
      } else {
        const entries = await this.request(connection, { type: 'get_entries' }, this.options.requestTimeoutMs ?? 15_000).catch(() => undefined) as { entries?: unknown[] } | undefined;
        if (entries?.entries) this.setEntries(connection, entries.entries);
      }
      connection.ready = true; connection.connected = true;
      this.setStatus(connection, 'idle', session.forkFrom ? 'Pi Fork 会话已就绪' : 'Pi 图形对话已就绪');
      return { nativeSessionId: expected, sessionFile: connection.sessionFile, sessionName: connection.sessionName, model: connection.model?.id ?? null, thinkingLevel: connection.thinkingLevel };
    } catch (error) {
      await this.dispose(connection);
      const detail = connection.stderr.trim();
      throw new Error(`Pi 会话未能启动：${error instanceof Error ? error.message : String(error)}${detail ? `（${detail.split('\n').at(-1)}）` : ''}`);
    }
  }

  /** Read only a bounded JSONL tail; malformed/partial lines are ignored. */
  private async recentEntries(path: string | null): Promise<unknown[] | undefined> {
    if (!path) return undefined;
    let file;
    try { file = await open(path, 'r'); } catch { return undefined; }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size === 0) return [];
      const size = Math.min(info.size, 2 * 1024 * 1024);
      let offset = Math.max(0, info.size - size);
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await file.read(buffer, 0, size, offset);
      let text = buffer.subarray(0, bytesRead).toString('utf8');
      if (offset > 0) { const newline = text.indexOf('\n'); if (newline < 0) return []; text = text.slice(newline + 1); }
      const entries: unknown[] = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { const value = JSON.parse(line); if (value && typeof value === 'object') entries.push(value); } catch { /* partial tail */ }
      }
      return entries.slice(-1000);
    } finally { await file.close(); }
  }

  async close(nativeId: string): Promise<void> {
    const connection = this.connections.get(nativeId);
    if (!connection) return;
    await this.dispose(connection);
  }

  async closeAll(): Promise<void> { await Promise.all([...this.connections.values()].map(connection => this.dispose(connection))); }

  snapshotSync(nativeId: string): AgentChatSnapshot {
    return this.view(this.require(nativeId));
  }

  async snapshot(nativeId: string): Promise<AgentChatSnapshot> {
    return this.snapshotSync(nativeId);
  }

  async refresh(nativeId: string): Promise<AgentChatSnapshot> {
    const connection = this.require(nativeId);
    await this.scheduleRefresh(connection, true);
    return this.view(connection);
  }

  async sendPrompt(nativeId: string, text: string, images: string[] = [], expectedTurnId?: string): Promise<{ turnId: string }> {
    const rejected = (message: string): Error => Object.assign(new Error(message), { deliveryUnknown: false });
    const connection = this.require(nativeId);
    if (!connection.ready || connection.closed) throw rejected('Pi 会话尚未连接，请先打开图形对话');
    if (typeof text !== 'string' || (!text.trim() && !images.length) || text.length > 32_000 || text.includes('\0')) throw rejected('消息不能为空且最多 32000 字符');
    if (images.length > 8) throw rejected('每条消息最多 8 张图片');
    if (connection.requests.size) throw rejected('Pi 正在等待你的确认或回答，请先处理');
    if (expectedTurnId && connection.activeTurnId !== expectedTurnId) throw rejected('当前任务已变化或完成，请刷新后重新发送');
    const payloadImages = await Promise.all(images.map(async path => {
      const mimeType = IMAGE_MIME[extname(path).toLowerCase()];
      if (!mimeType) throw rejected('Pi 只接受 PNG、JPEG、WebP 或 GIF 图片');
      try { return { type: 'image' as const, data: (await readFile(path)).toString('base64'), mimeType }; }
      catch { throw rejected('图片已失效，请重新上传'); }
    }));
    const turnId = randomUUID();
    const anchor = connection.lastEntryId;
    const settledBefore = connection.settledCount;
    const queued = !!connection.activeTurnId;
    connection.expectedTurnId = queued ? null : turnId;
    if (queued) connection.queuedTurnIds.push(turnId);
    // Pi's RPC stream accepts a queued follow-up while a turn is running. Dili
    // queues in its own composer, so a second delivery is explicit and native.
    const command = { type: 'prompt', message: text, ...(payloadImages.length ? { images: payloadImages } : {}), ...(queued ? { streamingBehavior: 'followUp' as const } : {}) };
    try {
      await this.request(connection, command);
    } catch (error) {
      connection.expectedTurnId = null;
      if (queued) connection.queuedTurnIds = connection.queuedTurnIds.filter(id => id !== turnId);
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { deliveryUnknown: true });
    }
    connection.liveUser = { id: `pi:${nativeId}:live-user:${turnId}`, type: 'user', text, ...(payloadImages.length ? { imageCount: payloadImages.length } : {}), status: 'completed' };
    connection.liveUserAnchor = anchor;
    if (!connection.activeTurnId && connection.settledCount === settledBefore) {
      connection.activeTurnId = turnId;
      this.setStatus(connection, 'running', 'Pi 正在处理');
    } else if (!connection.activeTurnId) {
      // The native turn completed before its RPC acceptance reached us. Do not
      // resurrect a settled turn just because the response arrived late.
      this.setStatus(connection, 'idle', 'Pi 图形对话已就绪');
    } else {
      // A queued follow-up gets its own id; the current turn remains active.
      this.setStatus(connection, 'running', 'Pi 已接收补充任务，将在当前任务后处理');
    }
    void this.scheduleRefresh(connection, true);
    return { turnId };
  }

  async abort(nativeId: string): Promise<void> {
    const connection = this.require(nativeId);
    if (!connection.activeTurnId) return;
    connection.queuedTurnIds = [];
    connection.detail = '正在停止 Pi 当前任务';
    this.setStatus(connection, 'running', connection.detail);
    await this.request(connection, { type: 'abort' }).catch(() => undefined);
  }

  async setName(nativeId: string, name: string): Promise<void> {
    const connection = this.require(nativeId);
    await this.request(connection, { type: 'set_session_name', name });
    connection.sessionName = name;
    this.changed(connection);
  }

  async answerRequest(nativeId: string, requestId: string, answer: AgentChatAnswer): Promise<void> {
    const connection = this.require(nativeId);
    const pending = connection.requests.get(requestId);
    if (!pending) throw new Error('此 Pi 请求已失效或已由另一个窗口处理，请刷新会话');
    let response: Record<string, unknown>;
    if (pending.method === 'confirm') {
      const decision = answer.decision;
      if (decision !== 'yes' && decision !== 'no') throw new Error('请选择允许或拒绝');
      response = { type: 'extension_ui_response', id: pending.uiId, confirmed: decision === 'yes' };
    } else {
      const values = answer.answers ?? {};
      const first = Object.values(values)[0]?.[0];
      if (typeof first !== 'string' || !first.trim()) throw new Error('请填写回答后再提交');
      response = { type: 'extension_ui_response', id: pending.uiId, value: first };
    }
    connection.requests.delete(requestId);
    if (pending.timeout) clearTimeout(pending.timeout);
    this.sendRaw(connection, response);
    this.setStatus(connection, connection.activeTurnId ? 'running' : 'idle', connection.activeTurnId ? 'Pi 正在处理' : 'Pi 图形对话已就绪');
    this.changed(connection);
  }

  async readSettings(nativeId: string): Promise<AgentChatSettings> {
    const connection = this.require(nativeId);
    const [models, levels] = await Promise.all([
      this.request(connection, { type: 'get_available_models' }).then(data => (data as { models?: PiModel[] }).models ?? []).catch(() => []),
      this.request(connection, { type: 'get_available_thinking_levels' }).then(data => (data as { levels?: string[] }).levels ?? []).catch(() => []),
    ]);
    const modelChoices: AgentChatChoice[] = models.map(model => ({ id: `${model.provider}/${model.id}`, label: model.name ? `${model.name} · ${model.provider}` : `${model.id} · ${model.provider}`, ...(model.reasoning ? { description: '原生支持思考强度' } : {}) }));
    const current = connection.model ? `${connection.model.provider}/${connection.model.id}` : null;
    const effortChoices: AgentChatChoice[] = sharedEffortChoices(levels.map(level => ({ id: level })));
    const busy = !!connection.activeTurnId || connection.requests.size > 0;
    const version = randomUUID();
    connection.settingsVersion = version;
    return {
      nativeSessionId: nativeId,
      version,
      model: current,
      models: modelChoices,
      permission: null,
      permissionLabel: 'Pi 使用原生工具策略，没有统一的审批模式',
      permissions: [],
      permissionReason: 'Pi 的权限由原生工具允许列表和扩展决定；Dili 不伪造审批模式。',
      effort: connection.thinkingLevel,
      efforts: effortChoices,
      effortLabel: effortChoices.length ? 'Pi 原生思考强度，随模型能力变化' : '当前模型没有可切换的思考强度',
      ...(effortChoices.length ? {} : { effortReason: '当前 Pi 模型没有可切换的思考强度' }),
      ...(modelChoices.length ? {} : { modelReason: 'Pi 没有报告可用模型，请先在原生设置中配置提供方' }),
      ...(busy ? { disabledReason: 'Pi 正在处理任务或等待回答，完成后再修改设置' } : {}),
      scope: '作用于当前 Pi 原生会话；模型与思考强度来自 Pi 原生目录并通过 RPC 立即生效。',
    };
  }

  async updateSettings(nativeId: string, update: AgentChatSettingsUpdate): Promise<AgentChatSettings> {
    const connection = this.require(nativeId);
    if (connection.settingsVersion && update.version !== connection.settingsVersion) throw Object.assign(new Error('Pi 设置已在另一个窗口更新，请刷新后重试'), { status: 409 });
    if (connection.activeTurnId) throw Object.assign(new Error('Pi 正在处理任务，请先完成或停止后再修改设置'), { status: 409 });
    if (connection.requests.size) throw Object.assign(new Error('Pi 正在等待回答，请先处理'), { status: 409 });
    if (update.field === 'model') {
      const data = await this.request(connection, { type: 'get_available_models' }) as { models?: PiModel[] };
      const model = (data.models ?? []).find(item => `${item.provider}/${item.id}` === update.value);
      if (!model) throw new Error('Pi 没有提供这个模型，请刷新后重试');
      await this.request(connection, { type: 'set_model', provider: model.provider, modelId: model.id });
      const state = await this.request(connection, { type: 'get_state' }) as Record<string, unknown>;
      const applied = state?.model && typeof state.model === 'object' ? state.model as PiModel : undefined;
      if (!applied || applied.provider !== model.provider || applied.id !== model.id) throw new Error('Pi 没有确认模型切换，请刷新后重试');
      connection.model = applied;
    } else if (update.field === 'effort') {
      if (!update.value) throw new Error('请选择 Pi 原生思考强度');
      await this.request(connection, { type: 'set_thinking_level', level: update.value });
      const state = await this.request(connection, { type: 'get_state' }) as Record<string, unknown>;
      if (state?.thinkingLevel !== update.value) throw new Error('Pi 没有确认思考强度切换，请刷新后重试');
      connection.thinkingLevel = update.value;
    } else throw new Error('Pi 没有统一的权限模式，请调整原生工具配置');
    this.changed(connection);
    return this.readSettings(nativeId);
  }

  private require(nativeId: string): PiConnection {
    const connection = this.connections.get(nativeId);
    if (!connection || connection.closed) throw new Error('Pi 原生会话未连接，请先启动图形对话');
    return connection;
  }

  private view(connection: PiConnection): AgentChatSnapshot {
    const items = [...connection.entryItems];
    const toolIds = new Set(items.flatMap(item => item.type === 'tool' ? [item.id] : []).map(id => id.split(':tool:').at(-1)));
    // The user's new prompt belongs before the tools it caused, even while the
    // native get_entries refresh is still in flight.
    if (connection.liveUser) items.push(connection.liveUser);
    for (const tool of connection.liveTools.values()) if (!toolIds.has(tool.id.split(':tool:').at(-1))) items.push(tool);
    if (connection.liveText?.text && !this.hasSavedAssistant(connection, connection.liveText.text)) items.push({ id: connection.liveText.id, type: 'assistant', text: connection.liveText.text, status: connection.activeTurnId ? 'inProgress' : 'completed' });
    return {
      nativeSessionId: connection.nativeId,
      revision: ++connection.revision,
      connected: connection.connected && connection.ready,
      activeTurnId: connection.activeTurnId,
      items,
      requests: [...connection.requests.values()].map(item => item.request),
      truncated: connection.truncated,
      historyCursor: null,
      ...(connection.truncated ? { notice: '只显示最近的 Pi 原生消息；完整记录保留在原生会话中。' } : {}),
    };
  }

  private setStatus(connection: PiConnection, status: SessionStatus, detail: string) {
    connection.status = status; connection.detail = detail;
    for (const listener of this.statusListeners) { try { listener(connection.nativeId, { status, detail, timestamp: now() }); } catch { /* a listener must not break the process reader */ } }
    this.changed(connection);
  }
  private changed(connection: PiConnection) {
    if (connection.disposed) return;
    for (const listener of this.chatListeners) { try { listener(connection.nativeId); } catch { /* UI listeners are best-effort */ } }
  }

  private setEntries(connection: PiConnection, entries: unknown[], append = false) {
    if (append) connection.rawEntries.push(...entries);
    else { connection.rawEntries = entries; connection.lastEntryId = null; }
    // The RPC has no reverse pagination; retain a bounded raw window while the
    // native file keeps the complete transcript for the terminal/reader.
    if (connection.rawEntries.length > 5000) connection.rawEntries = connection.rawEntries.slice(-5000);
    // The first JSONL record is the session header and has the session UUID
    // as `id`, not a resumable entry id. A `since=<header id>` would silently
    // return no entries forever, so only real records may advance the cursor.
    for (let index = connection.rawEntries.length - 1; index >= 0; index--) {
      const item = connection.rawEntries[index] as { id?: unknown; type?: unknown } | undefined;
      if (item?.type !== 'session' && typeof item?.id === 'string') { connection.lastEntryId = item.id; break; }
    }
    const mapped = piEntryItems(connection.rawEntries, connection.nativeId);
    connection.entryItems = mapped.items;
    connection.truncated = mapped.truncated;
    if (connection.liveText && this.hasSavedAssistant(connection, connection.liveText.text)) connection.liveText = null;
    const savedTools = new Set(mapped.items.filter(item => item.type === 'tool').map(item => item.id.split(':tool:').at(-1)));
    for (const callId of connection.liveTools.keys()) if (savedTools.has(callId)) connection.liveTools.delete(callId);
    if (connection.liveUser && this.livePromptSaved(connection)) { connection.liveUser = null; connection.liveUserAnchor = null; }
  }

  /** Retire the optimistic prompt only when the native window contains the
   * corresponding saved user entry, not merely an older user message. */
  private livePromptSaved(connection: PiConnection): boolean {
    const live = connection.liveUser;
    if (!live) return false;
    let started = !connection.liveUserAnchor;
    for (const raw of connection.rawEntries) {
      const entry = raw as { id?: unknown; type?: unknown; message?: { role?: unknown; content?: unknown } };
      if (!started) { if (entry?.id === connection.liveUserAnchor) started = true; continue; }
      if (entry?.type !== 'message' && entry?.type !== 'custom_message') continue;
      if (entry.message?.role !== 'user') continue;
      const text = textContent(entry.message.content);
      const images = Array.isArray(entry.message.content) ? entry.message.content.filter(block => { const type = block && typeof block === 'object' ? (block as { type?: unknown }).type : undefined; return type === 'image' || type === 'input_image'; }).length : 0;
      if ((live.text && (text === live.text || text.startsWith(live.text) || text.includes(live.text))) || (!live.text && images >= (live.imageCount ?? 0))) return true;
    }
    return false;
  }

  private hasSavedAssistant(connection: PiConnection, text: string): boolean {
    return connection.entryItems.some(item => item.type === 'assistant' && (item.text === text || item.text.startsWith(text) || text.startsWith(item.text)));
  }

  private scheduleRefresh(connection: PiConnection, immediate = false): Promise<void> {
    if (connection.refreshing) { connection.refreshAgain = true; return Promise.resolve(); }
    if (connection.refreshTimer) { if (!immediate) return Promise.resolve(); clearTimeout(connection.refreshTimer); connection.refreshTimer = null; }
    const run = async () => {
      connection.refreshTimer = null; connection.refreshing = true;
      const since = connection.lastEntryId;
      try {
        const data = await this.request(connection, { type: 'get_entries', ...(since ? { since } : {}) }, 10_000) as { entries?: unknown[] };
        if (!connection.closed && data?.entries) { this.setEntries(connection, data.entries, !!since); this.changed(connection); }
      } catch {
        // A compaction may remove the `since` entry. Re-read the bounded window
        // once instead of silently freezing the graphical transcript.
        if (since && !connection.closed) {
          const recent = await this.recentEntries(connection.sessionFile);
          if (recent?.length) { this.setEntries(connection, recent); this.changed(connection); }
          else connection.lastEntryId = null;
        }
      }
      finally {
        connection.refreshing = false;
        if (connection.refreshAgain && !connection.closed) { connection.refreshAgain = false; void this.scheduleRefresh(connection, true); }
      }
    };
    if (immediate) return run();
    connection.refreshTimer = setTimeout(() => void run(), 80);
    return Promise.resolve();
  }

  private consume(connection: PiConnection, chunk: string) {
    connection.stdout += chunk;
    let index = connection.stdout.indexOf('\n');
    while (index !== -1) {
      const line = connection.stdout.slice(0, index).replace(/\r$/, '');
      connection.stdout = connection.stdout.slice(index + 1);
      if (line.trim()) this.line(connection, line);
      index = connection.stdout.indexOf('\n');
    }
    // A single tool result can be large. Never retain a partial line (its tail
    // cannot be parsed) and never let the RPC reader grow without bound.
    if (connection.stdout.length > 16 * 1024 * 1024) connection.stdout = '';
  }

  private line(connection: PiConnection, line: string) {
    let message: Record<string, unknown>;
    try { message = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    if (message.type === 'response') {
      const pending = typeof message.id === 'string' ? connection.pending.get(message.id) : undefined;
      if (!pending) return;
      connection.pending.delete(message.id as string); clearTimeout(pending.timer);
      if (message.success === true) pending.resolve(message.data);
      else pending.reject(new Error(typeof message.error === 'string' ? message.error : `${pending.command} 失败`));
      return;
    }
    if (message.type === 'extension_ui_request') { this.extensionUi(connection, message); return; }
    this.event(connection, message);
  }

  private event(connection: PiConnection, event: Record<string, unknown>) {
    if (connection.closed) return;
    switch (event.type) {
      case 'agent_start':
        if (!connection.activeTurnId) {
          connection.activeTurnId = connection.queuedTurnIds.shift() ?? connection.expectedTurnId ?? randomUUID();
          connection.turnEnded = false;
        }
        connection.expectedTurnId = null;
        this.setStatus(connection, 'running', 'Pi 正在处理');
        break;
      case 'turn_start':
        // A follow-up starts a later turn in the same agent run. Bind it to the
        // id returned to the client so "awaiting" can clear when it becomes active.
        if (!connection.activeTurnId) connection.activeTurnId = connection.queuedTurnIds.shift() ?? connection.expectedTurnId ?? randomUUID();
        else if (connection.turnEnded) connection.activeTurnId = connection.queuedTurnIds.shift() ?? connection.activeTurnId;
        connection.expectedTurnId = null;
        connection.turnEnded = false;
        break;
      case 'message_start': {
        const message = event.message as { role?: string } | undefined;
        if (message?.role === 'assistant') connection.liveText = { id: `pi:${connection.nativeId}:live:${randomUUID()}`, text: '' };
        break;
      }
      case 'message_update': {
        const update = event.assistantMessageEvent as { type?: string; delta?: string; text?: string } | undefined;
        if (update?.type === 'text_delta' && connection.liveText) {
          connection.liveText.text = clipText(connection.liveText.text + (update.delta ?? update.text ?? ''), 60_000);
          this.changed(connection);
        }
        break;
      }
      case 'message_end':
        // Keep the streamed text until the saved assistant entry is confirmed;
        // clearing here makes the reply flash out and back during the refresh.
        void this.scheduleRefresh(connection);
        break;
      case 'tool_execution_start': {
        const id = typeof event.toolCallId === 'string' ? event.toolCallId : undefined;
        if (!id) break;
        connection.liveTools.set(id, { id: `pi:${connection.nativeId}:tool:${id}`, type: 'tool', text: clipText(JSON.stringify(event.args ?? {}, null, 2), 20_000), title: typeof event.toolName === 'string' ? event.toolName : 'tool', status: 'inProgress' });
        this.changed(connection);
        break;
      }
      case 'tool_execution_update': {
        const id = typeof event.toolCallId === 'string' ? event.toolCallId : undefined;
        const partial = event.partialResult as { content?: unknown } | undefined;
        if (!id) break;
        const item = connection.liveTools.get(id);
        if (item) { item.output = clipText(textContent(partial?.content), 40_000); this.changed(connection); }
        break;
      }
      case 'tool_execution_end': {
        const id = typeof event.toolCallId === 'string' ? event.toolCallId : undefined;
        if (!id) break;
        const item = connection.liveTools.get(id);
        if (item) {
          const result = event.result as { content?: unknown } | undefined;
          item.output = clipText(textContent(result?.content), 40_000);
          item.status = event.isError === true ? 'failed' : 'completed';
          this.changed(connection);
        }
        break;
      }
      case 'turn_end':
        connection.turnEnded = true;
        void this.scheduleRefresh(connection);
        break;
      case 'agent_end':
        void this.scheduleRefresh(connection);
        break;
      case 'agent_settled':
        connection.activeTurnId = null; connection.expectedTurnId = null; connection.queuedTurnIds = []; connection.turnEnded = false; connection.settledCount++;
        if (event.aborted === true) { connection.liveText = null; for (const tool of connection.liveTools.values()) if (tool.status === 'inProgress') tool.status = 'failed'; }
        this.setStatus(connection, 'idle', event.aborted === true ? 'Pi 当前任务已停止' : 'Pi 图形对话已就绪');
        void this.scheduleRefresh(connection, true);
        break;
      case 'session_info_changed':
        if (typeof event.name === 'string') connection.sessionName = event.name;
        this.changed(connection);
        break;
      case 'extension_error':
        connection.detail = 'Pi 扩展报告了错误，原生会话仍可继续';
        this.setStatus(connection, connection.activeTurnId ? 'running' : 'idle', connection.detail);
        break;
      default: break;
    }
  }

  private extensionUi(connection: PiConnection, event: Record<string, unknown>) {
    const method = typeof event.method === 'string' ? event.method : '';
    if (method === 'notify' || method === 'setStatus' || method === 'setWidget' || method === 'set_editor_text') return;
    if (method === 'setTitle') { if (typeof event.title === 'string') { connection.sessionName = event.title; this.changed(connection); } return; }
    if (method !== 'select' && method !== 'confirm' && method !== 'input' && method !== 'editor') return;
    const uiId = typeof event.id === 'string' ? event.id : randomUUID();
    const requestId = `pi-ui:${connection.nativeId}:${uiId}`;
    const title = typeof event.title === 'string' ? event.title : 'Pi 需要你的确认';
    const options = Array.isArray(event.options) ? event.options.filter((value): value is string => typeof value === 'string') : [];
    let request: AgentChatRequest;
    if (method === 'confirm') {
      request = { id: requestId, kind: 'approval', title, description: typeof event.message === 'string' ? event.message : undefined, options: [{ id: 'yes', label: '允许' }, { id: 'no', label: '拒绝' }] };
    } else if (method === 'select') {
      request = { id: requestId, kind: 'question', title, questions: [{ id: 'choice', header: '选择', question: title, options: options.map(label => ({ label })) }], options: options.map(label => ({ id: label, label })) };
    } else {
      request = { id: requestId, kind: 'question', title, questions: [{ id: 'answer', header: '回答', question: title, ...(typeof event.placeholder === 'string' ? { detail: event.placeholder } : {}) }], ...(typeof event.placeholder === 'string' ? { description: event.placeholder } : {}) };
    }
    const timeoutMs = typeof event.timeout === 'number' && event.timeout > 0 ? event.timeout : undefined;
    const timeout = timeoutMs ? setTimeout(() => {
      if (!connection.requests.delete(requestId)) return;
      // Do not leave the native extension blocked on a UI request Dili has
      // already stopped showing; send the protocol's cancellation response.
      this.sendRaw(connection, { type: 'extension_ui_response', id: uiId, cancelled: true });
      this.setStatus(connection, connection.activeTurnId ? 'running' : 'idle', connection.activeTurnId ? 'Pi 正在处理' : 'Pi 图形对话已就绪');
    }, timeoutMs) : undefined;
    connection.requests.set(requestId, { uiId, request, method, ...(timeout ? { timeout } : {}) });
    this.setStatus(connection, method === 'confirm' ? 'waiting_approval' : 'waiting_input', title);
  }

  private request(connection: PiConnection, command: Record<string, unknown>, timeoutMs = this.options.requestTimeoutMs ?? 30_000): Promise<unknown> {
    if (connection.closed) return Promise.reject(new Error('Pi 原生进程已退出'));
    const id = `dili_${++connection.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { connection.pending.delete(id); reject(new Error(`等待 Pi ${String(command.type)} 响应超时${connection.stderr ? `：${connection.stderr.trim().split('\n').at(-1)}` : ''}`)); }, timeoutMs);
      connection.pending.set(id, { command: String(command.type), resolve, reject, timer });
      this.sendRaw(connection, { ...command, id });
    });
  }

  private sendRaw(connection: PiConnection, message: Record<string, unknown>) {
    if (connection.closed || connection.child.stdin.destroyed || !connection.child.stdin.writable) return;
    try { connection.child.stdin.write(JSON.stringify(message) + '\n'); } catch { /* exit handler rejects pending commands */ }
  }

  private exited(connection: PiConnection, code: number | null, signal: NodeJS.Signals | null) {
    if (connection.disposed) return;
    this.rejectPending(connection, new Error(`Pi 原生进程已退出（code=${String(code)} signal=${String(signal)}）`));
    connection.connected = false;
    connection.ready = false;
    connection.activeTurnId = null;
    if (connection.status !== 'stopped') {
      const crashed = (code !== null && code !== 0) || !!signal;
      this.setStatus(connection, crashed ? 'error' : 'stopped', crashed ? `Pi 原生进程异常退出${code !== null ? `（${code}）` : ''}` : 'Pi 原生进程已退出');
    }
  }
  private failed(connection: PiConnection, error: Error) {
    if (connection.disposed) return;
    connection.connected = false;
    connection.ready = false;
    this.rejectPending(connection, error);
    this.setStatus(connection, 'error', `Pi 原生进程异常：${error.message}`);
  }
  private rejectPending(connection: PiConnection, error: Error) {
    for (const pending of connection.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    connection.pending.clear();
  }

  private async dispose(connection: PiConnection) {
    if (connection.disposed) return;
    connection.disposed = true;
    connection.closed = true;
    connection.ready = false;
    connection.connected = false;
    this.rejectPending(connection, new Error('Pi 会话已关闭'));
    for (const pending of connection.requests.values()) if (pending.timeout) clearTimeout(pending.timeout);
    connection.requests.clear();
    if (connection.refreshTimer) { clearTimeout(connection.refreshTimer); connection.refreshTimer = null; }
    if (!connection.child.killed) {
      try { connection.child.stdin.end(); } catch { /* already gone */ }
      try { await Promise.race([connection.exit, delay(600)]); } catch { /* ignore */ }
      try { await connection.owned.stop('SIGTERM'); } catch { try { connection.child.kill('SIGKILL'); } catch { /* already gone */ } }
    }
    connection.status = 'stopped'; connection.detail = 'Pi 会话已停止';
    if (this.connections.get(connection.nativeId) === connection) this.connections.delete(connection.nativeId);
    for (const listener of this.statusListeners) { try { listener(connection.nativeId, { status: 'stopped', detail: connection.detail, timestamp: now() }); } catch { /* ignore */ } }
  }
}
