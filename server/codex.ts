import { access, mkdir, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import type { ExecutionMode } from '../shared/execution.ts';
import type { SessionStatus } from '../shared/types.js';
import { validateNativeId } from './adapters.js';
import { OwnedProcess } from './owned-process.ts';
import { sameDirectory } from './paths.ts';
import type { CodexChatAnswer, CodexChatHistoryPage, CodexChatSnapshot, AgentChatSettings, AgentChatSettingsUpdate } from '../shared/chat.ts';
import { checkSettingsUpdate, settingsError, settingsVersion } from './agents/settings.ts';
import { CodexChatState, nativeChatAnswer, nativeChatRequest, type NativeChatRequest } from './codex-chat.ts';

export interface CodexNativeSession {
  nativeSessionId: string;
  /** Remote endpoint for the native Codex TUI. The token is intentionally
   * separate and is only passed to a child process by remoteLaunch(). */
  remoteUrl: string;
}

export interface CodexStatusEvent {
  status: SessionStatus;
  detail: string;
  timestamp: string;
  /** Stable native event identity, retained when a reconnect replays it. */
  attentionKey?: string;
}

export interface CodexLaunchCommand {
  file: string;
  args: string[];
  env: Record<string, string>;
}

export interface CodexBridgeOptions {
  /** Local SessionDeck data directory. Only runtime token files are written. */
  dataDir?: string;
  /** Override the executable for tests or a non-standard installation. */
  executable?: string;
  /** Use a fixed loopback port; 0 chooses an available port. */
  port?: number;
  /** Environment inherited by app-server and remote TUI children. */
  env?: NodeJS.ProcessEnv;
  /** Tests can attach to an already-running authenticated WS endpoint. */
  manageProcess?: boolean;
  remoteUrl?: string;
  remoteToken?: string;
  /** Optional timeout for app-server readiness. */
  startupTimeoutMs?: number;
  /** Timeout for the WebSocket HTTP upgrade and initialize handshake. */
  handshakeTimeoutMs?: number;
}

type RpcMessage = {
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string };
  params?: Record<string, unknown>;
};

type Thread = {
  id: string;
  cwd?: string;
  path?: string | null;
  status?: { type?: string; activeFlags?: string[] };
  forkedFromId?: string | null;
  canAcceptDirectInput?: boolean | null;
  name?: string | null;
  turns?: { id: string; status?: string; items?: unknown[]; itemsView?: string }[];
};

type RpcConnection = {
  ws: WebSocket;
  generation: number;
  nextId: number;
  pending: Map<number, { resolve: (value: RpcMessage) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>;
  initialized: Promise<void>;
  closed: boolean;
};

type StatusListener = (threadId: string, event: CodexStatusEvent) => void;
type ObservationAttempt = { version: number; connection?: RpcConnection; promise: Promise<void> };

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const DEFAULT_PORT = 4319;
const TOKEN_ENV = 'SESSIONDECK_CODEX_TOKEN';

function now(): string { return new Date().toISOString(); }

function errorMessage(value: unknown, fallback: string): string {
  if (value instanceof Error && value.message) return value.message;
  if (typeof value === 'string' && value) return value;
  return fallback;
}

async function availablePort(requested: number): Promise<number> {
  if (!Number.isInteger(requested) || requested < 0 || requested > 65535) throw new Error('SESSIONDECK_CODEX_PORT 必须是 0–65535 的端口号');
  const server = createServer();
  await new Promise<void>((resolveCheck, reject) => {
    server.once('error', reject);
    server.listen(requested, '127.0.0.1', () => resolveCheck());
  });
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : requested;
  await new Promise<void>(resolveCheck => server.close(() => resolveCheck()));
  return port;
}

/**
 * Owns one authenticated loopback Codex app-server. The server is deliberately
 * a separate process: Codex's native TUI can attach to exactly the same loaded
 * thread through `--remote`, while SessionDeck uses the stable JSON-RPC API for
 * identity, Fork and status. Permission overrides apply only to opted-in contacts.
 */
export class CodexBridge {
  private readonly nativeSettings = new Map<string, Record<string, unknown>>();
  private readonly settingsViews = new Map<string, AgentChatSettings>();
  private readonly changingSettings = new Set<string>();
  private captureSettings(id: string, value: unknown) {
    if (!value || typeof value !== 'object') return;
    const row = value as Record<string, unknown>;
    this.nativeSettings.set(id, { model: row.model, approvalPolicy: row.approvalPolicy, approvalsReviewer: row.approvalsReviewer });
  }
  async readChatSettings(id: string): Promise<AgentChatSettings> {
    const connection = this.observers.get(id);
    if (!connection || connection.closed || !this.chat.get(id)?.connected) return settingsError('请先连接 Codex 图形会话');
    const [response, native] = await Promise.all([
      this.call(connection, 'model/list', { limit: 100 }),
      // thread/read omits effective settings in current app-server versions.
      // Resume the retained observer with no policy overrides or history replay.
      this.call(connection, 'thread/resume', { threadId: id, excludeTurns: true }),
    ]);
    if (this.observers.get(id) !== connection || connection.closed) return settingsError('原生连接已变化，请重新打开设置');
    if (native.error) throw this.rpcError(native, '无法回读原生会话设置');
    const thread = (native.result as { thread?: Thread })?.thread;
    if (thread?.id !== id) return settingsError('原生设置返回了不同会话，请重新连接');
    this.captureSettings(id, native.result);
    const data = (response.result as { data?: { model: string; displayName: string; description?: string; hidden?: boolean }[] })?.data;
    const models = Array.isArray(data) ? data.filter(row => !row.hidden && typeof row.model === 'string').slice(0, 100).map(row => ({ id: row.model, label: row.displayName || row.model, description: row.description })) : [];
    const raw = this.nativeSettings.get(id) ?? {};
    const policy = raw.approvalPolicy, reviewer = raw.approvalsReviewer;
    const permission = policy === 'on-request' && reviewer === 'auto_review' ? 'auto_review' : typeof policy === 'string' && (reviewer === 'user' || reviewer === undefined) ? policy : null;
    const settings = settingsVersion(this.settingsViews.get(id), {
      nativeSessionId: id, model: typeof raw.model === 'string' ? raw.model : null, models, permission,
      ...(permission === null && policy !== undefined ? { permissionLabel: '自定义原生审批策略' } : {}),
      permissions: typeof policy === 'string' || (policy && typeof policy === 'object') ? [
        { id: 'untrusted', label: '谨慎审批', description: '不可信操作由你审批；保留当前沙箱' },
        { id: 'on-request', label: '按需审批', description: '由 Agent 请求审批；保留当前沙箱' },
        ...(typeof reviewer === 'string' ? [{ id: 'auto_review', label: '自动审核', description: '由 Codex 审核请求；保留当前沙箱' }] : []),
        { id: 'never', label: '不请求审批', description: '无法在当前沙箱执行的操作直接失败' },
      ] : [],
      ...(!models.length ? { modelReason: '当前 Codex 未返回可用模型列表，请检查 CLI 版本或原生配置' } : {}),
      ...(policy === undefined ? { permissionReason: '当前 Codex 未报告审批设置，请升级 CLI 后重试' } : {}),
      ...(thread.status?.type !== 'idle' || this.changingSettings.has(id) || this.sendingPrompts.has(id) || this.chat.get(id)?.activeTurnId || this.chat.get(id)?.requests.length ? { disabledReason: '请等待当前任务、审批或设置修改结束；原生状态未确认时不可修改' } : {}),
      scope: '作用于当前原生线程；审批切换保留现有沙箱和文件／网络权限。',
    });
    this.settingsViews.set(id, settings);
    return settings;
  }
  async updateChatSettings(id: string, update: AgentChatSettingsUpdate): Promise<AgentChatSettings> {
    const current = await this.readChatSettings(id);
    checkSettingsUpdate(current, update);
    const connection = this.observers.get(id)!;
    // A second request can finish its model/list while the first one is saving.
    if (this.changingSettings.has(id) || this.sendingPrompts.has(id) || this.chat.get(id)?.activeTurnId || this.chat.get(id)?.requests.length) return settingsError('原生会话正在处理任务或设置，请稍后重试');
    this.changingSettings.add(id);
    try {
      const response = await this.call(connection, 'thread/settings/update', { threadId: id, ...(update.field === 'model' ? { model: update.value } : { approvalPolicy: update.value === 'auto_review' ? 'on-request' : update.value, ...(this.nativeSettings.get(id)?.approvalsReviewer !== undefined ? { approvalsReviewer: update.value === 'auto_review' ? 'auto_review' : 'user' } : {}) }) });
      if (response.error) throw this.rpcError(response, '当前 Codex 不支持或拒绝了设置修改');
      if (connection.closed || this.observers.get(id) !== connection) return settingsError('原生连接已变化，请刷新确认设置');
      // Metadata-only native readback; never replay history or auto-mode overrides.
      const readback = await this.call(connection, 'thread/resume', { threadId: id, excludeTurns: true });
      if (readback.error) throw this.rpcError(readback, '设置已提交，但无法回读确认，请刷新');
      const result = readback.result as { thread?: Thread };
      if (result?.thread?.id !== id || connection.closed || this.observers.get(id) !== connection) return settingsError('设置回读身份已变化，请刷新确认');
      this.captureSettings(id, result);
      if (update.field === 'permission') this.executionModes.set(id, 'default');
    } finally { this.changingSettings.delete(id); }
    const confirmed = await this.readChatSettings(id);
    if (confirmed[update.field] !== update.value) return settingsError('原生设置未确认目标值，请刷新检查实际设置');
    return confirmed;
  }
  private readonly executionModes = new Map<string, ExecutionMode>();
  private autoPermissions(mode?: ExecutionMode): Record<string, string> {
    return mode === 'auto' ? { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write' } : {};
  }
  readonly remoteUrl: string;
  private readonly options: CodexBridgeOptions;
  private readonly env: NodeJS.ProcessEnv;
  private process: ChildProcess | null = null;
  private owners = new WeakMap<ChildProcess, OwnedProcess>();
  private retiring: Promise<void> = Promise.resolve();
  private starting: Promise<void> | null = null;
  private ready = false;
  private closed = false;
  private port = 0;
  private token = '';
  private tokenFile: string | null = null;
  private bootGeneration = 0;
  private connections = new Set<RpcConnection>();
  private observers = new Map<string, RpcConnection>();
  private observing = new Map<string, ObservationAttempt>();
  private observationVersions = new Map<string, number>();
  private turnIds = new Map<string, string>();
  private completed = new Map<string, CodexStatusEvent>();
  private nativeAttention = new Map<string, CodexStatusEvent>();
  private listeners = new Set<StatusListener>();
  private chat = new CodexChatState();
  private chatRequests = new Map<string, { threadId: string; connection: RpcConnection; request: NativeChatRequest }>();
  private answeredChatRequests = new WeakMap<RpcConnection, Set<number | string>>();
  private sendingPrompts = new Set<string>();
  private historyReads = new Map<string, Promise<CodexChatSnapshot>>();
  private historyChecked = new Map<string, number>();
  private historyFailures = new Map<string, { until: number; error: Error }>();
  private historyPages = new Map<string, Promise<CodexChatHistoryPage>>();

  constructor(options: CodexBridgeOptions = {}) {
    this.options = options;
    this.env = { ...(options.env ?? process.env) };
    this.remoteUrl = options.remoteUrl ?? '';
  }

  /** Endpoint after start(). Before start() it is an empty string. */
  get endpoint(): string { return this.remoteUrl || (this.port ? `ws://127.0.0.1:${this.port}` : ''); }

  /** Token is intentionally not part of the public session object. */
  get remoteToken(): string | null { return this.ready ? this.token : null; }

  onStatus(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onChat(listener: (threadId: string, snapshot: CodexChatSnapshot) => void): () => void { return this.chat.onChange(listener); }
  chatSnapshot(id: string): CodexChatSnapshot | undefined { return this.chat.get(id); }

  /** A read can use an existing observer but never resumes or starts an Agent. */
  async readChat(id: string): Promise<CodexChatSnapshot> {
    validateNativeId('codex', id);
    if (!this.ready) throw new Error('请先打开 Codex 图形会话');
    const pending = this.historyReads.get(id);
    if (pending) return pending;
    const cached = this.chat.get(id);
    if (cached && Date.now() - (this.historyChecked.get(id) ?? 0) < 2000) return cached;
    const failure = this.historyFailures.get(id);
    if (failure && failure.until > Date.now()) throw failure.error;
    const generation = this.bootGeneration;
    const job = this.readRecentChat(id).then(snapshot => {
      if (generation === this.bootGeneration) {
        this.historyChecked.delete(id); this.historyChecked.set(id, Date.now());
        this.historyFailures.delete(id);
        while (this.historyChecked.size > 128) this.historyChecked.delete(this.historyChecked.keys().next().value!);
      }
      return snapshot;
    }).catch(cause => {
      if (generation === this.bootGeneration && this.ready) {
        this.historyFailures.delete(id);
        this.historyFailures.set(id, { until: Date.now() + 10_000, error: cause instanceof Error ? cause : new Error(String(cause)) });
        while (this.historyFailures.size > 128) this.historyFailures.delete(this.historyFailures.keys().next().value!);
      }
      throw cause;
    }).finally(() => { if (this.historyReads.get(id) === job) this.historyReads.delete(id); });
    this.historyReads.set(id, job);
    return job;
  }

  private async readRecentChat(id: string): Promise<CodexChatSnapshot> {
    const generation = this.bootGeneration;
    await this.observing.get(id)?.promise;
    if (!this.ready || generation !== this.bootGeneration) throw new Error('Codex 图形会话已停止，请重新打开');
    const basis = this.chat.get(id)?.revision ?? 0;
    const page = await this.readTurns(id);
    if (!this.ready || generation !== this.bootGeneration) throw new Error('Codex 对话读取连接已失效');
    const retained = this.observers.get(id);
    return this.chat.reconcile(id, { id, turns: page.turns }, basis, !!retained && !retained.closed, page.nextCursor);
  }

  /** Older pages stay separate from live state so reading history cannot change
   * active turns, approvals, or evict current output in other viewers. */
  async readChatHistory(id: string, cursor: string): Promise<CodexChatHistoryPage> {
    validateNativeId('codex', id);
    if (!cursor || cursor.length > 8192 || /[\x00-\x1f]/.test(cursor)) throw new Error('历史游标无效');
    if (!this.ready) throw new Error('请先打开 Codex 图形会话');
    const key = `${id}:${cursor}`;
    const pending = this.historyPages.get(key);
    if (pending) return pending;
    if (this.historyPages.size >= 32) throw new Error('历史读取繁忙，请稍后重试');
    const generation = this.bootGeneration;
    const job = this.readTurns(id, cursor).then(page => {
      if (!this.ready || generation !== this.bootGeneration) throw new Error('Codex 对话读取连接已失效');
      if (page.nextCursor === cursor) throw new Error('原生历史游标没有推进，请刷新后重试');
      const view = new CodexChatState().reconcile(id, { id, turns: page.turns }, 0, false);
      return { nativeSessionId: id, items: view.items, nextCursor: page.nextCursor, truncated: view.truncated };
    }).finally(() => { if (this.historyPages.get(key) === job) this.historyPages.delete(key); });
    this.historyPages.set(key, job);
    return job;
  }

  private async readTurns(id: string, cursor?: string): Promise<{ turns: unknown[]; nextCursor: string | null }> {
    // Never request includeTurns:true: large logs can spend seconds rebuilding
    // an oversized response only to hit the frame limit. Short-lived sockets
    // isolate paginated reads from the observer that owns approvals and input.
    for (const limit of [20, 5, 1]) {
      const connection = await this.connect(false);
      try {
        const response = await this.call(connection, 'thread/turns/list', { threadId: id, itemsView: 'full', sortDirection: 'desc', limit, ...(cursor ? { cursor } : {}) }, 5000);
        if (response.error) throw this.rpcError(response, 'Codex 分页历史读取失败');
        if (connection.closed || connection.generation !== this.bootGeneration) throw new Error('Codex 对话读取连接已失效');
        const page = response.result as { data?: unknown[]; nextCursor?: unknown } | undefined;
        if (!Array.isArray(page?.data) || (page.nextCursor != null && (typeof page.nextCursor !== 'string' || !page.nextCursor || page.nextCursor.length > 8192))) throw new Error('Codex 返回了无效的分页历史');
        return { turns: page.data.toReversed(), nextCursor: typeof page.nextCursor === 'string' ? page.nextCursor : null };
      } catch (cause) {
        if (limit === 1 || !/payload size exceeded|max payload|message too large/i.test(errorMessage(cause, ''))) throw cause;
      } finally { this.closeConnection(connection); this.connections.delete(connection); }
    }
    throw new Error('Codex 分页历史读取失败');
  }

  /** The retained connection must own this request so approvals and questions
   * remain answerable after turn/start returns. No native policy is overridden. */
  async sendPrompt(id: string, text: string, model?: string, images: string[] = [], expectedTurnId?: string): Promise<{ turnId: string }> {
    const rejected = (message: string): Error => Object.assign(new Error(message), { deliveryUnknown: false });
    try { validateNativeId('codex', id); } catch { throw rejected('无效的原生会话 ID'); }
    if (typeof text !== 'string' || (!text.trim() && !images.length) || text.length > 32_000 || text.includes('\0')) throw rejected('消息不能为空且最多 32000 字符');
    const connection = this.observers.get(id);
    if (!this.ready || !connection || connection.closed || connection.ws.readyState !== WebSocket.OPEN) throw rejected('Codex 会话尚未连接，请先打开图形会话');
    const snapshot = this.chat.get(id);
    if (!snapshot?.connected) throw rejected('Codex 会话仍在连接，请等待原生恢复完成');
    if (this.changingSettings.has(id) || this.sendingPrompts.has(id) || snapshot?.requests.length) throw rejected('Codex 正在修改设置、提交消息或等待答复，请处理后再发送');
    if (expectedTurnId !== undefined && (!UUID.test(expectedTurnId) || snapshot.activeTurnId !== expectedTurnId)) throw rejected('当前任务已变化或完成，草稿已保留，请核对后重新发送');
    if (snapshot.activeTurnId && !expectedTurnId) throw rejected('Codex 仍在执行，请刷新后补充当前任务');
    this.sendingPrompts.add(id);
    const basis = snapshot?.revision ?? 0;
    try {
      let response: RpcMessage;
      const input = [...(text.trim() ? [{ type: 'text', text, text_elements: [] }] : []), ...images.map(path => ({ type: 'localImage', path }))];
      try { response = await this.call(connection, expectedTurnId ? 'turn/steer' : 'turn/start', { threadId: id, ...(expectedTurnId ? { expectedTurnId } : model ? { model } : {}), input }); }
      catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { deliveryUnknown: true }); }
      if (response.error) throw Object.assign(response.error.code === -32601 && expectedTurnId ? new Error('当前 Codex 版本不支持生成中补充，请升级或在本轮完成后发送；草稿已保留') : this.rpcError(response, 'Codex 未接受消息'), { deliveryUnknown: false });
      const result = response.result as { turn?: { id?: string }; turnId?: string } | undefined;
      const turn = expectedTurnId ? { id: result?.turnId } : result?.turn;
      if (!turn?.id || !UUID.test(turn.id)) throw Object.assign(new Error('Codex 未返回有效轮次 ID，请先确认是否已接收消息'), { deliveryUnknown: true });
      if (expectedTurnId && turn.id !== expectedTurnId) throw Object.assign(new Error('Codex 返回了不同的任务 ID，请先核对补充结果'), { deliveryUnknown: true });
      // Steering must not resurrect a turn that completed before its response.
      if (!expectedTurnId) this.chat.acceptedTurn(id, turn, basis);
      const active = this.chat.get(id)?.activeTurnId;
      if (active) this.turnIds.set(id, active);
      return { turnId: turn.id };
    } finally { this.sendingPrompts.delete(id); }
  }

  async answerChatRequest(id: string, requestId: string, answer: CodexChatAnswer): Promise<void> {
    validateNativeId('codex', id);
    const entry = this.chatRequests.get(requestId);
    if (!entry || entry.threadId !== id || this.observers.get(id) !== entry.connection || entry.connection.closed || entry.connection.generation !== this.bootGeneration || !this.ready) throw new Error('此原生请求已失效或已由另一窗口处理，请刷新会话');
    const result = nativeChatAnswer(entry.request, answer);
    // Claim synchronously before yielding. A second tab must never respond to
    // the same native request, even while the first socket write is pending.
    this.chatRequests.delete(requestId);
    let answered = this.answeredChatRequests.get(entry.connection);
    if (!answered) { answered = new Set(); this.answeredChatRequests.set(entry.connection, answered); }
    answered.add(entry.request.nativeId);
    // A peer that omits resolution notifications must not grow this set forever.
    if (answered.size > 256) answered.delete(answered.values().next().value!);
    this.publishChatRequests(id);
    await new Promise<void>((accept, reject) => {
      entry.connection.ws.send(JSON.stringify({ jsonrpc: '2.0', id: entry.request.nativeId, result }), error => {
        if (error) { this.chat.notice(id, '答复连接中断，接收结果尚未确认；请检查原生会话。'); reject(error); }
        else accept();
      });
    });
  }

  private publishChatRequests(id: string): void {
    this.chat.requests(id, [...this.chatRequests.values()].filter(entry => entry.threadId === id).map(entry => entry.request.view));
  }

  private clearChatRequests(connection: RpcConnection, threadId?: string, turnId?: string): void {
    const changed = new Set<string>();
    for (const [key, entry] of this.chatRequests) if (entry.connection === connection && (!threadId || entry.threadId === threadId) && (!turnId || entry.request.turnId === turnId)) { this.chatRequests.delete(key); changed.add(entry.threadId); }
    for (const id of changed) this.publishChatRequests(id);
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('Codex 桥接服务正在关闭');
    if (this.ready) return;
    if (this.starting) return this.starting;
    const generation = ++this.bootGeneration;
    this.historyReads.clear(); this.historyChecked.clear(); this.historyFailures.clear(); this.historyPages.clear();
    const pending = this.boot(generation).finally(() => { if (this.starting === pending) this.starting = null; });
    this.starting = pending;
    return pending;
  }

  private async boot(generation: number): Promise<void> {
    const assertActive = () => { if (generation !== this.bootGeneration) throw new Error('Codex app-server 启动已取消'); };
    await this.retiring;
    assertActive();
    if (this.options.manageProcess === false) {
      if (!this.options.remoteUrl || !this.options.remoteToken) throw new Error('测试模式需要 remoteUrl 和 remoteToken');
      this.token = this.options.remoteToken;
      this.ready = true;
      return;
    }
    const executable = this.options.executable ?? await this.findExecutable();
    assertActive();
    if (!executable) throw new Error('未找到 Codex，请安装 codex CLI 并加入 PATH');
    this.port = await availablePort(this.options.port ?? Number(this.env.SESSIONDECK_CODEX_PORT ?? DEFAULT_PORT));
    assertActive();
    const dataDir = resolve(this.options.dataDir ?? this.env.SESSIONDECK_DATA_DIR ?? join(homedir(), '.local/share', 'sessiondeck'));
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    assertActive();
    // Codex refuses to start when CODEX_HOME is explicitly pointed at a path
    // that has not been created yet (common in tests and fresh profiles).
    if (this.env.CODEX_HOME) await mkdir(resolve(this.env.CODEX_HOME), { recursive: true, mode: 0o700 });
    assertActive();
    this.token = `sessiondeck-${randomBytes(24).toString('hex')}`;
    const tokenFile = join(dataDir, `.codex-app-server-${process.pid}-${randomUUID()}.token`);
    this.tokenFile = tokenFile;
    await writeFile(tokenFile, this.token, { mode: 0o600 });
    if (generation !== this.bootGeneration) { await this.removeTokenFile(tokenFile); assertActive(); }
    const childEnv = { ...this.env };
    const child = spawn(executable, [
      'app-server', '--listen', `ws://127.0.0.1:${this.port}`,
      '--ws-auth', 'capability-token', '--ws-token-file', tokenFile,
    ], { cwd: process.cwd(), env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] });
    const closed = new Promise<void>(accept => child.once('close', () => accept()));
    this.owners.set(child, new OwnedProcess(child.pid ?? 0, closed, signal => { child.kill(signal); }));
    this.process = child;
    let failure: Error | null = null;
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    child.once('error', error => { failure = error; });
    child.once('exit', code => {
      if (this.process !== child) return;
      if (!this.ready) failure = new Error(`Codex app-server 已退出（${code ?? 'signal'}）${stderr ? `：${stderr.trim().slice(-500)}` : ''}`);
      this.closeConnections(true);
      this.ready = false;
      this.process = null;
      this.turnIds.clear();
      this.completed.clear();
      this.nativeAttention.clear();
      void this.removeTokenFile(tokenFile);
    });
    const timeoutMs = this.options.startupTimeoutMs ?? 10_000;
    const deadline = Date.now() + timeoutMs;
    try {
      while (Date.now() < deadline) {
        assertActive();
        if (failure) throw failure;
        try {
          const response = await fetch(`http://127.0.0.1:${this.port}/readyz`, { signal: AbortSignal.timeout(300) });
          assertActive();
          if (response.ok) {
            this.ready = true;
            return;
          }
        } catch { /* still booting */ }
        await delay(100);
      }
      throw new Error(`Codex app-server 启动超时${stderr ? `：${stderr.trim().slice(-500)}` : ''}`);
    } catch (error) {
      if (this.process === child) this.process = null;
      this.retire(child);
      await this.removeTokenFile(tokenFile);
      throw error;
    }
  }

  private async findExecutable(): Promise<string | null> {
    const configured = this.env.SESSIONDECK_CODEX_BIN;
    const candidates = configured ? [configured] : (this.env.PATH ?? '').split(delimiter).filter(Boolean).map(path => join(path, 'codex'));
    for (const candidate of candidates) {
      try { await access(candidate, constants.X_OK); return resolve(candidate); } catch { /* continue */ }
    }
    return null;
  }

  async stop(): Promise<void> {
    const starting = this.starting;
    ++this.bootGeneration;
    this.starting = null;
    this.ready = false;
    this.historyReads.clear(); this.historyChecked.clear(); this.historyFailures.clear(); this.historyPages.clear();
    this.closeConnections();
    this.turnIds.clear();
    this.completed.clear();
    this.nativeAttention.clear();
    if (this.process) this.retire(this.process);
    this.process = null;
    await this.removeTokenFile();
    await starting?.catch(() => undefined);
    await this.retiring;
  }

  async close(): Promise<void> { this.closed = true; await this.stop(); }

  private retire(child: ChildProcess): void {
    const retiring = this.owners.get(child)?.stop() ?? Promise.resolve();
    this.retiring = Promise.all([this.retiring, retiring]).then(() => undefined);
    void this.retiring.catch(() => undefined);
  }

  private async removeTokenFile(path = this.tokenFile): Promise<void> {
    if (path === this.tokenFile) this.tokenFile = null;
    if (path) try { await unlink(path); } catch { /* already removed */ }
  }

  private closeConnections(emitUnknown = false): void {
    for (const [threadId, attempt] of this.observing) {
      this.observationVersions.set(threadId, attempt.version + 1);
      if (attempt.connection) this.closeConnection(attempt.connection);
    }
    this.observing.clear();
    const observed = [...this.observers.keys()];
    for (const threadId of observed) this.invalidateObserver(threadId, 'Codex 原生状态连接已断开', emitUnknown);
    for (const connection of this.connections) this.closeConnection(connection);
    this.connections.clear();
    this.observers.clear();
  }

  private invalidateObserver(threadId: string, detail: string, forceEmit = false): void {
    this.nativeSettings.delete(threadId);
    this.settingsViews.delete(threadId);
    const connection = this.observers.get(threadId);
    if (connection) this.closeConnection(connection);
    this.observers.delete(threadId);
    this.chat.connected(threadId, false, detail);
    // A dropped observer does not end the native turn or acknowledge its
    // result. Keep that identity until resume reconciles it with native state.
    // Do not emit during an intentional stop. During a boot/process failure the
    // card must become explicitly unknown instead of retaining stale truth.
    if (this.ready || forceEmit) this.emitStatus(threadId, { status: 'unknown', detail, timestamp: now() });
  }

  private closeConnection(connection: RpcConnection): void {
    this.clearChatRequests(connection);
    this.answeredChatRequests.delete(connection);
    for (const [id, observer] of this.observers) if (observer === connection) this.chat.connected(id, false, 'Codex 原生连接已断开，请重新连接。');
    if (connection.closed) return;
    connection.closed = true;
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Codex app-server 连接已关闭'));
    }
    connection.pending.clear();
    connection.ws.terminate();
  }

  private async connect(allowStart = true): Promise<RpcConnection> {
    if (allowStart) await this.start();
    else if (!this.ready) throw new Error('Codex app-server 尚未启动');
    const endpoint = this.endpoint;
    const token = this.token;
    if (!endpoint || !token) throw new Error('Codex app-server 尚未就绪');
    const ws = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${token}` }, maxPayload: 16 * 1024 * 1024 });
    const pending = new Map<number, { resolve: (value: RpcMessage) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
    const generation = this.bootGeneration;
    const connection: RpcConnection = { ws, generation, nextId: 1, pending, initialized: Promise.resolve(), closed: false };
    this.connections.add(connection);
    ws.on('message', data => {
      let message: RpcMessage;
      try { message = JSON.parse(data.toString()) as RpcMessage; } catch { return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      if (message.method !== undefined && typeof message.method !== 'string') return;
      if (message.params !== undefined && (!message.params || typeof message.params !== 'object' || Array.isArray(message.params))) return;
      if (connection.closed || connection.generation !== this.bootGeneration || !this.ready) return;
      if (message.method && message.id !== undefined) {
        this.handleServerRequest(connection, message);
        return;
      }
      if (message.method) this.handleNotification(connection, message);
      if (message.id === undefined || message.method || (!('result' in message) && !('error' in message))) return;
      if (typeof message.id !== 'number') return;
      const id = message.id;
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.resolve(message);
    });
    const fail = (reason: unknown) => {
      const error = new Error(errorMessage(reason, 'Codex app-server WebSocket 连接失败'));
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
      pending.clear();
    };
    ws.on('error', fail);
    ws.on('close', () => {
      connection.closed = true;
      fail(new Error('Codex app-server WebSocket 已关闭'));
      this.connections.delete(connection);
      for (const [threadId, observed] of this.observers) if (observed === connection) this.invalidateObserver(threadId, 'Codex 原生状态连接已断开');
    });
    connection.initialized = new Promise<void>((resolveInit, rejectInit) => {
      let handshakeTimer: NodeJS.Timeout;
      const onError = (error: Error) => { clearTimeout(handshakeTimer); rejectInit(error); };
      const onClose = () => { clearTimeout(handshakeTimer); rejectInit(new Error('Codex app-server 在握手完成前关闭了连接')); };
      handshakeTimer = setTimeout(() => {
        try { ws.terminate(); } catch { /* already closed */ }
        rejectInit(new Error('Codex app-server WebSocket 握手超时'));
      }, this.options.handshakeTimeoutMs ?? 5_000);
      const onOpen = () => {
        ws.off('error', onError);
        this.call(connection, 'initialize', { clientInfo: { name: 'sessiondeck', version: '0.2.0' }, capabilities: { experimentalApi: true } }, this.options.handshakeTimeoutMs ?? 5_000)
          .then(response => {
            if (response.error) throw this.rpcError(response, 'Codex initialize 失败');
            ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }));
          })
          .then(() => { clearTimeout(handshakeTimer); ws.off('close', onClose); resolveInit(); }, onError);
      };
      ws.once('error', onError);
      ws.once('close', onClose);
      ws.once('open', onOpen);
    });
    try { await connection.initialized; return connection; }
    catch (error) { this.closeConnection(connection); this.connections.delete(connection); throw error; }
  }

  private call(connection: RpcConnection, method: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<RpcMessage> {
    if (connection.closed || connection.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Codex app-server 连接尚未打开'));
    const id = connection.nextId++;
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => { connection.pending.delete(id); rejectCall(new Error(`Codex ${method} 请求超时`)); }, timeoutMs);
      connection.pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });
      try { connection.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); }
      catch (error) { clearTimeout(timer); connection.pending.delete(id); rejectCall(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  private rpcError(response: RpcMessage, fallback: string): Error {
    if (/already has an active writer/i.test(response.error?.message ?? '')) {
      return Object.assign(new Error('这个 Codex 会话正被其他原生客户端占用。关闭原客户端后重试恢复，或 Fork 为独立会话继续。'), {
        status: 409, code: 'NATIVE_SESSION_BUSY',
      });
    }
    return new Error(response.error?.message ? `Codex：${response.error.message}` : fallback);
  }

  private async rpc<T extends Record<string, unknown>>(method: string, params: Record<string, unknown>): Promise<T> {
    const connection = await this.connect();
    try {
      const response = await this.call(connection, method, params);
      if (response.error) throw this.rpcError(response, `Codex ${method} 失败`);
      return (response.result ?? {}) as T;
    } finally { this.closeConnection(connection); this.connections.delete(connection); }
  }

  private handleServerRequest(connection: RpcConnection, message: RpcMessage): void {
    const params = message.params ?? {};
    const threadId = typeof params.threadId === 'string' ? params.threadId : typeof params.conversationId === 'string' ? params.conversationId : undefined;
    if (!threadId || this.observers.get(threadId) !== connection) return;
    if (message.id !== undefined && (typeof message.id === 'string' || typeof message.id === 'number')) {
      const duplicate = this.answeredChatRequests.get(connection)?.has(message.id) || [...this.chatRequests.values()].some(entry => entry.connection === connection && entry.threadId === threadId && entry.request.nativeId === message.id);
      const count = [...this.chatRequests.values()].filter(entry => entry.threadId === threadId).length;
      if (!duplicate && count < 32) {
        const request = nativeChatRequest(message.method!, message.id, params);
        this.chatRequests.set(request.view.id, { threadId, connection, request });
        this.publishChatRequests(threadId);
      } else if (count >= 32) this.chat.notice(threadId, '原生待处理请求过多，请切换原生终端或停止当前任务。');
    }
    const item = params.item as { id?: unknown } | undefined;
    const itemId = typeof params.itemId === 'string' ? params.itemId : typeof item?.id === 'string' ? item.id : undefined;
    let event: CodexStatusEvent | undefined;
    if (/approval|permission/i.test(message.method ?? '')) event = { status: 'waiting_approval', detail: 'Codex 正在等待原生会话处理审批', timestamp: now(), ...(itemId ? { attentionKey: `codex:${threadId}:approval:${itemId}` } : {}) };
    else if (/elicitation|user.?input/i.test(message.method ?? '')) event = { status: 'waiting_input', detail: 'Codex 正在等待原生会话处理输入', timestamp: now(), ...(itemId ? { attentionKey: `codex:${threadId}:input:${itemId}` } : {}) };
    if (event) { this.nativeAttention.set(threadId, event); this.emitStatus(threadId, event); }
    // A native request may also reach the TUI. Only an explicit user answer
    // writes a response; serverRequest/resolved removes another client's win.
  }

  private handleNotification(connection: RpcConnection, message: RpcMessage): void {
    if (connection.generation !== this.bootGeneration) return;
    const params = message.params ?? {};
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
    if (!threadId || !UUID.test(threadId) || this.observers.get(threadId) !== connection) return;
    if (message.method === 'thread/settings/updated') this.captureSettings(threadId, params.threadSettings);
    if (message.method === 'serverRequest/resolved') {
      if (typeof params.requestId === 'string' || typeof params.requestId === 'number') this.answeredChatRequests.get(connection)?.delete(params.requestId);
      for (const [id, entry] of this.chatRequests) if (entry.connection === connection && entry.threadId === threadId && entry.request.nativeId === params.requestId) this.chatRequests.delete(id);
      this.publishChatRequests(threadId);
      return;
    }
    this.chat.event(threadId, message.method!, params);
    if (message.method === 'thread/status/changed' && threadId) {
      const status = params.status as { type?: string; activeFlags?: string[] } | undefined;
      if (status?.type === 'active') this.completed.delete(threadId);
      const event = this.currentStatus(threadId, status, 'Codex 原生状态已更新');
      this.emitStatus(threadId, event);
    } else if (message.method === 'turn/started' && threadId) {
      const turn = params.turn as { id?: string } | undefined;
      if (!turn?.id || !UUID.test(turn.id)) return;
      this.turnIds.set(threadId, turn.id);
      this.completed.delete(threadId);
      this.nativeAttention.delete(threadId);
      this.emitStatus(threadId, { status: 'running', detail: 'Codex 原生会话正在执行', timestamp: now() });
    } else if (message.method === 'turn/completed' && threadId) {
      const turn = params.turn as { id?: string; status?: string } | undefined;
      if (!turn?.id || !UUID.test(turn.id)) return;
      const activeId = this.turnIds.get(threadId);
      if (activeId && activeId !== turn.id) return;
      this.clearChatRequests(connection, threadId, turn.id);
      this.turnIds.delete(threadId);
      const event = this.completionEvent(threadId, turn as { id: string; status?: string });
      this.emitStatus(threadId, event);
    } else if (message.method === 'error' && threadId) {
      this.emitStatus(threadId, { status: 'error', detail: 'Codex 报告执行错误，请进入原生会话查看', timestamp: now() });
    }
  }

  private completionEvent(threadId: string, turn: { id: string; status?: string }): CodexStatusEvent {
    const attentionKey = `codex:${threadId}:${turn.id}:${turn.status ?? 'unknown'}`;
    const previous = this.completed.get(threadId);
    if (previous?.attentionKey === attentionKey) return previous;
    const event: CodexStatusEvent = turn.status === 'completed'
      ? { status: 'waiting_input', detail: 'Codex 本轮已结束，可以继续或验收', timestamp: now(), attentionKey }
      : turn.status === 'interrupted' ? { status: 'idle', detail: 'Codex 当前轮次已中断', timestamp: now(), attentionKey }
      : turn.status === 'failed' ? { status: 'error', detail: 'Codex 当前轮次执行失败，请进入原生会话查看', timestamp: now(), attentionKey }
      : { status: 'unknown', detail: 'Codex 返回了未知的轮次结束状态', timestamp: now(), attentionKey };
    this.completed.set(threadId, event);
    this.nativeAttention.delete(threadId);
    return event;
  }

  private currentStatus(threadId: string, status: Thread['status'], detail: string): CodexStatusEvent {
    if (status?.type === 'idle' && this.completed.has(threadId)) return this.completed.get(threadId)!;
    const mapped = this.mapStatus(status, detail);
    const attention = this.nativeAttention.get(threadId);
    if (attention?.status === mapped.status) return attention;
    if (mapped.status !== 'unknown') this.nativeAttention.delete(threadId);
    return mapped;
  }

  private restoreNativeState(thread: Thread): CodexStatusEvent {
    const latest = thread.turns?.at(-1);
    if (thread.status?.type === 'active') {
      this.completed.delete(thread.id);
      const active = thread.turns?.findLast(turn => turn.status === 'inProgress');
      if (active && UUID.test(active.id)) this.turnIds.set(thread.id, active.id);
    } else if (thread.status?.type === 'idle' && latest && UUID.test(latest.id) && latest.status !== 'inProgress') {
      this.turnIds.delete(thread.id);
      this.completionEvent(thread.id, latest);
    }
    return this.currentStatus(thread.id, thread.status, 'Codex 原生会话已连接');
  }

  private mapStatus(status: { type?: string; activeFlags?: string[] } | undefined, detail: string): CodexStatusEvent {
    if (!status?.type || !['active', 'idle', 'notLoaded', 'systemError'].includes(status.type)) return { status: 'unknown', detail: 'Codex 未返回可识别的原生状态', timestamp: now() };
    const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
    if (status?.type === 'systemError') return { status: 'error', detail: 'Codex 原生会话发生系统错误', timestamp: now() };
    if (status?.type === 'notLoaded') return { status: 'unknown', detail: 'Codex 原生会话尚未加载', timestamp: now() };
    if (flags.includes('waitingOnApproval')) return { status: 'waiting_approval', detail: 'Codex 正在等待命令审批', timestamp: now() };
    if (flags.includes('waitingOnUserInput')) return { status: 'waiting_input', detail: 'Codex 正在等待你的输入', timestamp: now() };
    if (status?.type === 'active') return { status: 'running', detail: 'Codex 原生会话正在执行', timestamp: now() };
    return { status: 'idle', detail, timestamp: now() };
  }

  private emitStatus(threadId: string, event: CodexStatusEvent): void {
    for (const listener of this.listeners) {
      try { listener(threadId, event); } catch { /* status observers must not break the bridge */ }
    }
  }

  private async observe(threadId: string, cwd?: string): Promise<void> {
    const version = this.observationVersions.get(threadId) ?? 0;
    const pending = this.observing.get(threadId);
    if (pending?.version === version) return pending.promise;
    if (this.observers.has(threadId)) return;
    const attempt: ObservationAttempt = { version, promise: Promise.resolve() };
    const assertActive = () => {
      if ((this.observationVersions.get(threadId) ?? 0) !== version || (attempt.connection && (attempt.connection.closed || attempt.connection.generation !== this.bootGeneration))) throw new Error('Codex 状态恢复已取消');
    };
    attempt.promise = (async () => {
      const connection = await this.connect();
      attempt.connection = connection;
      try {
        assertActive();
        const basis = this.chat.get(threadId)?.revision ?? 0;
        // Register before resume: a pending approval can be replayed before the
        // resume response, and must stay bound to this retained connection.
        this.retainObserver(threadId, connection);
        // Do not replay the complete native history while reconnecting. An
        // imported thread can be much larger than the WebSocket payload limit;
        // history is loaded separately when needed and live notifications keep
        // the retained observer current.
        const response = await this.call(connection, 'thread/resume', { threadId, excludeTurns: true, ...this.autoPermissions(this.executionModes.get(threadId)), ...(cwd ? { cwd: resolve(cwd) } : {}) });
        assertActive();
        if (response.error) throw this.rpcError(response, 'Codex 会话恢复失败');
        const thread = (response.result as { thread?: Thread } | undefined)?.thread;
        if (thread?.id !== threadId) throw new Error('Codex 返回了不匹配的恢复会话');
        this.captureSettings(threadId, response.result);
        if (cwd && (!thread.cwd || !await sameDirectory(thread.cwd, cwd))) throw new Error('Codex 恢复后未使用所选工作目录');
        const newerTurn = this.chat.turnChanged(threadId, basis);
        this.chat.reconcile(threadId, thread, basis, true);
        if (!newerTurn) this.emitStatus(threadId, this.restoreNativeState(thread));
      } catch (error) {
        this.closeConnection(connection);
        this.connections.delete(connection);
        if (this.observers.get(threadId) === connection) this.observers.delete(threadId);
        throw error;
      }
    })().finally(() => { if (this.observing.get(threadId) === attempt) this.observing.delete(threadId); });
    this.observing.set(threadId, attempt);
    return attempt.promise;
  }

  private retainObserver(threadId: string, connection: RpcConnection): void {
    this.observers.set(threadId, connection);
    connection.ws.once('close', () => { if (this.observers.get(threadId) === connection) this.observers.delete(threadId); });
  }

  async createSession(cwd: string, title?: string, mode: ExecutionMode = 'default'): Promise<CodexNativeSession> {
    // Codex 0.154's default paginated history cannot resume an empty thread in
    // its native TUI ("missing source rollout"). Its supported legacy history
    // contract can. Request that contract instead of modifying native files.
    // Retain the creation connection as the live status observer.
    const connection = await this.connect();
    try {
      const response = await this.call(connection, 'thread/start', { cwd: resolve(cwd), ephemeral: false, historyMode: 'legacy', ...this.autoPermissions(mode) });
      if (response.error) throw this.rpcError(response, 'Codex 会话创建失败');
      const thread = (response.result as { thread?: Thread } | undefined)?.thread;
      if (!thread?.id || !UUID.test(thread.id)) throw new Error('Codex 未返回有效的原生会话 ID');
      this.executionModes.set(thread.id, mode);
      this.retainObserver(thread.id, connection);
      this.captureSettings(thread.id, response.result);
      this.chat.reconcile(thread.id, thread, this.chat.get(thread.id)?.revision ?? 0, true);
      if (title?.trim()) {
        // The native identity already exists. A transient title write failure
        // must not make the caller create a duplicate contact.
        try {
          await this.call(connection, 'thread/name/set', { threadId: thread.id, name: title.trim().slice(0, 160) });
        } catch { /* The local card title is authoritative; native naming is optional. */ }
      }
      this.emitStatus(thread.id, connection.closed
        ? { status: 'unknown', detail: 'Codex 会话已创建，状态连接已断开', timestamp: now() }
        : this.mapStatus(thread.status, 'Codex 原生会话已连接'));
      return { nativeSessionId: thread.id, remoteUrl: this.endpoint };
    } catch (error) {
      this.closeConnection(connection);
      this.connections.delete(connection);
      throw error;
    }
  }

  async openSession(id: string, cwd?: string, options: { allowCwdChange?: boolean; executionMode?: ExecutionMode } = {}): Promise<CodexNativeSession> {
    validateNativeId('codex', id);
    const result = await this.rpc<{ thread?: Thread }>('thread/read', { threadId: id, includeTurns: false });
    const thread = result.thread;
    if (thread?.id !== id) throw new Error('Codex 返回了不匹配的原生会话');
    const changedCwd = cwd && thread.cwd && !await sameDirectory(thread.cwd, cwd);
    if (changedCwd && !options.allowCwdChange) throw new Error('Codex 会话工作目录与联系人不一致');
    if (changedCwd && (this.observers.has(id) || this.observing.has(id))) throw new Error('Codex 会话已连接，请先停止再更换工作目录');
    if (options.executionMode) this.executionModes.set(id, options.executionMode);
    await this.observe(id, changedCwd ? cwd : undefined);
    return { nativeSessionId: id, remoteUrl: this.endpoint };
  }

  async forkSession(id: string, cwd?: string, mode?: ExecutionMode): Promise<CodexNativeSession> {
    validateNativeId('codex', id);
    const source = await this.rpc<{ thread?: Thread }>('thread/read', { threadId: id, includeTurns: false });
    if (source.thread?.id !== id) throw new Error('Codex 返回了不匹配的原生来源会话');
    const targetCwd = cwd ? resolve(cwd) : undefined;
    const connection = await this.connect();
    try {
      const response = await this.call(connection, 'thread/fork', { threadId: id, ...(targetCwd ? { cwd: targetCwd } : {}), ephemeral: false, excludeTurns: true, ...this.autoPermissions(mode ?? this.executionModes.get(id)) });
      if (response.error) throw this.rpcError(response, 'Codex Fork 失败');
      const child = (response.result as { thread?: Thread } | undefined)?.thread;
      if (!child?.id || !UUID.test(child.id) || child.id === id || child.forkedFromId !== id) throw new Error('Codex 未创建独立 Fork 会话');
      if (targetCwd && child.cwd && !await sameDirectory(child.cwd, targetCwd)) throw new Error('Codex Fork 未使用请求的工作目录');
      this.executionModes.set(child.id, mode ?? this.executionModes.get(id) ?? 'default');
      this.retainObserver(child.id, connection);
      this.captureSettings(child.id, response.result);
      this.chat.reconcile(child.id, child, this.chat.get(child.id)?.revision ?? 0, true);
      if (child.status) this.emitStatus(child.id, this.mapStatus(child.status, 'Codex Fork 会话已连接'));
      return { nativeSessionId: child.id, remoteUrl: this.endpoint };
    } catch (error) {
      this.closeConnection(connection);
      this.connections.delete(connection);
      throw error;
    }
  }

  async setName(id: string, name: string): Promise<void> {
    validateNativeId('codex', id);
    if (!name.trim()) throw new Error('Codex 会话名称不能为空');
    await this.rpc('thread/name/set', { threadId: id, name: name.trim().slice(0, 160) });
  }

  async stopSession(id: string): Promise<void> {
    validateNativeId('codex', id);
    // A dead app-server cannot own a live turn. Stopping its former TUI must
    // not launch a replacement service or resurrect the archived thread.
    if (!this.ready) return;
    const existing = this.observers.get(id);
    const connection = existing ?? await this.connect();
    const temporary = !existing;
    try {
      if (temporary) {
        const resumed = await this.call(connection, 'thread/resume', { threadId: id, excludeTurns: true });
        if (resumed.error) throw this.rpcError(resumed, 'Codex 任务停止前恢复失败');
        if ((resumed.result as { thread?: Thread } | undefined)?.thread?.id !== id) throw new Error('Codex 返回了不匹配的停止目标');
      }
      let turnId = this.turnIds.get(id);
      if (!turnId) {
        // The fallback only needs the current status. If no turn ID was
        // observed on this connection, report that clearly instead of
        // requesting all historical turns and exceeding the payload limit.
        const current = await this.call(connection, 'thread/read', { threadId: id, includeTurns: false });
        if (current.error) throw this.rpcError(current, '无法读取 Codex 当前任务');
        const thread = (current.result as { thread?: Thread } | undefined)?.thread;
        if (thread?.id !== id) throw new Error('Codex 返回了不匹配的停止目标');
        const turns = thread.turns ?? [];
        const active = [...turns].reverse().find(turn => turn.status === 'inProgress');
        turnId = active?.id;
        if (turnId) this.turnIds.set(id, turnId);
        else if (thread.status?.type === 'active') throw new Error('Codex 任务仍在执行，但尚未返回可中断的轮次，请在原生终端中停止');
      }
      if (!turnId) {
        this.emitStatus(id, { status: 'idle', detail: 'Codex 当前没有正在执行的任务', timestamp: now() });
        return;
      }
      const response = await this.call(connection, 'turn/interrupt', { threadId: id, turnId });
      if (response.error && !/no active turn/i.test(response.error.message ?? '')) throw this.rpcError(response, 'Codex 任务停止失败');
      this.clearChatRequests(connection, id);
      this.chat.event(id, 'turn/completed', { turn: { id: turnId, status: 'interrupted' } });
      this.turnIds.delete(id);
      this.completed.delete(id);
      this.nativeAttention.delete(id);
      this.emitStatus(id, { status: 'idle', detail: 'Codex 当前任务已停止，原生会话仍保留', timestamp: now() });
    } finally {
      if (temporary) { this.closeConnection(connection); this.connections.delete(connection); }
    }
  }

  /** Release one observer when a card is archived or its native process stops. */
  releaseSession(id: string): void {
    validateNativeId('codex', id);
    this.observationVersions.set(id, (this.observationVersions.get(id) ?? 0) + 1);
    const pending = this.observing.get(id);
    this.observing.delete(id);
    if (pending?.connection) this.closeConnection(pending.connection);
    this.turnIds.delete(id);
    this.completed.delete(id);
    this.nativeAttention.delete(id);
    this.invalidateObserver(id, 'Codex 原生状态观察已释放');
  }

  async getStatus(id: string): Promise<CodexStatusEvent> {
    validateNativeId('codex', id);
    const version = this.observationVersions.get(id) ?? 0;
    let readObserver: RpcConnection | undefined;
    try {
      // A native TUI may still be healthy when just our observer socket drops.
      // Recover that subscription on the next status poll, without restarting
      // the app-server or losing the native TUI's execution/approval ownership.
      if (!this.ready) return { status: 'unknown', detail: 'Codex 原生服务已断开，请重新进入会话', timestamp: now() };
      if (!this.observers.has(id) || this.observing.has(id)) await this.observe(id);
      if ((this.observationVersions.get(id) ?? 0) !== version) return { status: 'unknown', detail: 'Codex 原生状态观察已释放', timestamp: now() };
      const observer = this.observers.get(id);
      if (!observer) return { status: 'unknown', detail: 'Codex 原生状态连接已断开', timestamp: now() };
      readObserver = observer;
      const response = await this.call(observer, 'thread/read', { threadId: id, includeTurns: false });
      if ((this.observationVersions.get(id) ?? 0) !== version) return { status: 'unknown', detail: 'Codex 原生状态观察已释放', timestamp: now() };
      if (response?.error) throw this.rpcError(response, 'Codex 状态读取失败');
      const result = (response.result ?? {}) as { thread?: Thread };
      if (result.thread?.id !== id) return { status: 'unknown', detail: 'Codex 未返回该会话', timestamp: now() };
      const event = this.currentStatus(id, result.thread.status, 'Codex 原生会话状态已读取');
      this.emitStatus(id, event);
      return event;
    } catch (error) {
      if ((this.observationVersions.get(id) ?? 0) === version && readObserver && this.observers.get(id) === readObserver) this.invalidateObserver(id, 'Codex 原生状态读取连接已断开');
      return { status: 'unknown', detail: errorMessage(error, '无法连接 Codex 原生会话'), timestamp: now() };
    }
  }

  /** Launch native TUI against this bridge without mutating process.env. */
  remoteLaunch(id: string, executable: string, cwd?: string): CodexLaunchCommand {
    validateNativeId('codex', id);
    if (!this.ready || !this.endpoint || !this.token) throw new Error('Codex app-server 尚未就绪');
    return {
      file: executable,
      args: ['--remote', this.endpoint, '--remote-auth-token-env', TOKEN_ENV, ...(this.executionModes.get(id) === 'auto' ? ['--approve-for-me'] : []), 'resume', id, '--no-alt-screen'],
      env: { [TOKEN_ENV]: this.token, ...(cwd ? { PWD: resolve(cwd) } : {}) },
    };
  }
}
