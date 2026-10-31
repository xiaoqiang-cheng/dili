import { randomUUID } from 'node:crypto';
import type { AgentChatAdapter } from './chat.ts';
import type { AgentChatAnswer, AgentChatHistoryPage, AgentChatItem, AgentChatRequest, AgentChatSettings, AgentChatSettingsUpdate, AgentChatSnapshot } from '../../shared/chat.ts';
import type { SessionStatus } from '../../shared/types.ts';
import type { DshHistory } from '../conversation.ts';
import type { DshChatSettings } from '../dsh.ts';
import { dshChatItems, dshChatTurn } from './dsh-chat-items.ts';

interface DshPendingQuestion { callId: string; questions: unknown[]; state?: 'open' | 'continued' }
interface DshPendingApproval { id: string; toolName?: string; reason?: string }
interface DshPending { questions: DshPendingQuestion[]; approvals: DshPendingApproval[] }
export interface DshStatusLike { status: SessionStatus; detail?: string }

/** The small native surface this adapter needs. Keeping it structural lets the
 * tests exercise the adapter without booting the Harness web server. */
export interface DshChatNative {
  readonly readyState: boolean;
  start(): Promise<void>;
  readHistory(id: string, maxMessages?: number): Promise<DshHistory | undefined>;
  prompt(id: string, text: string): Promise<void>;
  stopSession(id: string): Promise<void>;
  getStatus(id: string): Promise<DshStatusLike>;
  pendingRequests?(id: string): DshPending;
  answerQuestion?(id: string, callId: string, answers: { id: string; selected: string[]; custom?: string }[]): Promise<void>;
  readChatSettings?(id: string): Promise<DshChatSettings>;
  updateChatSettings?(id: string, field: 'model' | 'permission', value: string): Promise<void>;
  onStatusChange?(listener: () => void): () => void;
  onSessionEvent?(listener: (id: string, event: unknown) => void): () => void;
}

const MAX_ITEMS = 200;
const MAX_ITEM_TEXT = 32_000;
const clip = (value: string, limit = MAX_ITEM_TEXT) => value.length > limit ? value.slice(0, limit - 1) + '…' : value;
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function questionsFromRequest(value: unknown, index: number): AgentChatRequest['questions'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw, questionIndex) => {
    const item = object(raw);
    if (!item || typeof item.question !== 'string' || !item.question.trim()) return [];
    const id = typeof item.id === 'string' && item.id ? item.id : `q${questionIndex + 1}`;
    const options = Array.isArray(item.options) ? item.options.flatMap(rawOption => {
      const option = object(rawOption);
      return option && typeof option.label === 'string' && option.label.trim() ? [{ label: option.label.trim(), ...(typeof option.description === 'string' && option.description.trim() ? { description: option.description.trim() } : {}) }] : [];
    }) : undefined;
    return [{
      id,
      header: typeof item.header === 'string' && item.header.trim() ? item.header.trim() : `问题 ${index + questionIndex + 1}`,
      question: item.question.trim(),
      ...(typeof item.detail === 'string' && item.detail.trim() ? { detail: item.detail.trim() } : {}),
      ...(options?.length ? { options, isOther: true } : {}),
      ...(item.multiSelect === true ? { multiSelect: true } : {}),
    }];
  });
}

function requestFromQuestion(question: DshPendingQuestion): AgentChatRequest {
  const questions = questionsFromRequest(question.questions, 0);
  const multiSelect = questions?.some(item => item.multiSelect);
  if (!questions?.length || multiSelect) {
    return {
      id: question.callId,
      kind: 'unsupported',
      title: 'DeepSeek Harness 等待回答',
      description: !questions?.length
        ? '原生问题没有可读取的选项，请进入 DeepSeek Harness 原生界面回答。'
        : '这组问题包含多选，当前网页界面还不能安全提交；请进入 DeepSeek Harness 原生界面回答。',
    };
  }
  const first = questions[0];
  return {
    id: question.callId,
    kind: 'question',
    title: first.header || (questions.length > 1 ? `${questions.length} 个问题需要回答` : '需要你回答'),
    ...(first.detail ? { description: first.detail } : {}),
    questions,
  };
}

function requestFromApproval(approval: DshPendingApproval): AgentChatRequest {
  return {
    id: approval.id,
    kind: 'unsupported',
    title: approval.toolName ? `等待审批：${approval.toolName}` : 'DeepSeek Harness 等待审批',
    description: '审批仍由 DeepSeek Harness 原生界面处理；网页端不会伪造允许或拒绝。',
    ...(approval.reason ? { details: approval.reason } : {}),
  };
}

export interface DshChatAdapterOptions {
  /** Read-only fallback when the native service is still booting. */
  notice?: string;
  /** Opening a stopped contact must not boot the native service. */
  shouldStart?: (nativeSessionId: string) => boolean;
  /** Whether a web writer owns the session; a dsh-tui-owned session can read but not write. */
  writerWritable?: (nativeSessionId: string) => boolean;
}

export class DshChatAdapter implements AgentChatAdapter {
  private readonly snapshots = new Map<string, AgentChatSnapshot>();
  private readonly listeners = new Set<(sessionId: string, snapshot: AgentChatSnapshot) => void>();
  private readonly refreshing = new Map<string, Promise<AgentChatSnapshot>>();
  private readonly pendingSynthetics = new Map<string, string[]>();
  private readonly turnIds = new Map<string, Map<number, string>>();
  private readonly live = new Map<string, { id: string; attemptId: string; turn: number; text: string }>();
  private readonly settingsVersions = new Map<string, string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private closed = false;
  private readonly offStatus: (() => void) | undefined;
  private readonly offEvent: (() => void) | undefined;

  constructor(private readonly native: DshChatNative, private readonly options: DshChatAdapterOptions = {}) {
    this.offStatus = native.onStatusChange?.(() => this.scheduleAll());
    this.offEvent = native.onSessionEvent?.((id, event) => this.observe(id, event));
  }

  close(): void {
    this.closed = true;
    this.offStatus?.(); this.offEvent?.();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.listeners.clear();
  }

  private schedule(id: string): void {
    if (this.closed || this.timers.has(id)) return;
    const timer = setTimeout(() => {
      this.timers.delete(id);
      if (!this.closed) void this.refresh(id).catch(() => {});
    }, 40);
    timer.unref();
    this.timers.set(id, timer);
  }

  private scheduleAll(): void {
    for (const id of this.snapshots.keys()) this.schedule(id);
  }

  private observe(id: string, event: unknown): void {
    if (this.closed) return;
    const value = object(event), data = object(value?.data);
    if (!value || !data || typeof value.type !== 'string') return;
    if (value.type === 'assistant/live-chunk') {
      const chunk = object(data.chunk);
      const attemptId = typeof data.attemptId === 'string' ? data.attemptId : undefined;
      const turn = typeof data.turn === 'number' ? data.turn : undefined;
      if (attemptId && turn !== undefined && chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        const previous = this.live.get(id);
        const text = (previous?.attemptId === attemptId ? previous.text : '') + chunk.text;
        this.live.set(id, { id: `dsh:live:${id}:${attemptId}`, attemptId, turn, text: clip(text) });
        this.publishLive(id);
      }
      return;
    }
    if (['assistant/message', 'tool/call', 'tool/result', 'user/message', 'turn/start', 'turn/end', 'approval/asked', 'approval/decided', 'question/resolved'].includes(value.type)) this.schedule(id);
  }

  private publishLive(id: string): void {
    const snapshot = this.snapshots.get(id), live = this.live.get(id);
    if (!snapshot || !live || !live.text) return;
    const currentTurn = this.turnIds.get(id)?.get(live.turn);
    const turnId = currentTurn ?? String(live.turn);
    const item: AgentChatItem = { id: live.id, type: 'assistant', text: clip(live.text), status: 'inProgress', turnId };
    const items = [...snapshot.items.filter(value => value.id !== live.id), item];
    const next: AgentChatSnapshot = { ...snapshot, items, activeTurnId: turnId, revision: snapshot.revision + 1 };
    this.snapshots.set(id, next);
    for (const listener of this.listeners) listener(id, next);
  }

  private async readNative(id: string): Promise<AgentChatSnapshot> {
    let startError: unknown;
    if (!this.native.readyState && this.options.shouldStart?.(id)) {
      try { await this.native.start(); }
      catch (error) { startError = error; }
    }
    if (!this.native.readyState) throw startError instanceof Error ? startError : new Error('DeepSeek Harness 原生服务尚未启动；请先启动会话或发送消息');
    const history = await this.native.readHistory(id, MAX_ITEMS).catch(() => undefined);
    const events = (history?.events ?? []).flatMap(entry => entry && typeof entry === 'object' && 'event' in entry ? [entry.event] : []);
    const turn = dshChatTurn(events);
    const status = await this.native.getStatus(id).catch(() => ({ status: 'unknown' as const, detail: '无法读取 DeepSeek Harness 状态' }));
    const connected = this.native.readyState && status.status !== 'unknown';
    let items = dshChatItems(events, id);
    const turnIds = this.turnIds.get(id) ?? new Map<number, string>();
    const pending = this.pendingSynthetics.get(id) ?? [];
    if (turn?.active && !turnIds.has(turn.id) && pending.length) turnIds.set(turn.id, pending.shift()!);
    if (turn?.id !== undefined) this.turnIds.set(id, turnIds);
    this.pendingSynthetics.set(id, pending);
    if (turn?.id !== undefined && turnIds.has(turn.id)) {
      const synthetic = turnIds.get(turn.id)!;
      items = items.map(item => item.turnId === String(turn.id) ? { ...item, turnId: synthetic } : item);
    }
    const live = this.live.get(id);
    if (live?.text) {
      const turnId = turnIds.get(live.turn) ?? String(live.turn);
      const finalAssistant = items.findLast(item => item.type === 'assistant' && item.turnId === turnId);
      if (finalAssistant) finalAssistant.replaces = [live.id];
      else items = [...items, { id: live.id, type: 'assistant', text: clip(live.text), status: 'inProgress', turnId }];
    }
    // Keep the live text only until its durable assistant message is read, so the
    // final item can explicitly replace the transient bubble.
    if (turn && !turn.active) this.live.delete(id);
    const nativeRequests = this.native.pendingRequests?.(id);
    const requests: AgentChatRequest[] = [
      ...(nativeRequests?.questions ?? []).map(requestFromQuestion),
      ...(nativeRequests?.approvals ?? []).map(requestFromApproval),
    ];
    const activeTurnId = turn?.active ? turnIds.get(turn.id) ?? String(turn.id) : null;
    const notice = startError instanceof Error ? startError.message
      : !this.native.readyState ? this.options.notice ?? 'DeepSeek Harness 原生服务尚未就绪。'
      : history?.hasMore ? '为保持流畅，只显示最近的原生消息；完整记录保留在 DeepSeek Harness 中。'
      : undefined;
    return {
      nativeSessionId: id,
      revision: this.snapshots.get(id)?.revision ?? 0,
      connected,
      activeTurnId,
      items: items.slice(-MAX_ITEMS),
      requests,
      truncated: history?.hasMore === true,
      historyCursor: null,
      ...(notice ? { notice } : {}),
    };
  }

  async readChat(sessionId: string): Promise<AgentChatSnapshot> {
    return this.refresh(sessionId);
  }

  private refresh(id: string): Promise<AgentChatSnapshot> {
    const running = this.refreshing.get(id);
    if (running) return running;
    const job = this.readNative(id).then(snapshot => {
      const previous = this.snapshots.get(id);
      const next = { ...snapshot, revision: (previous?.revision ?? 0) + 1 };
      this.snapshots.set(id, next);
      for (const listener of this.listeners) listener(id, next);
      return next;
    }).finally(() => { if (this.refreshing.get(id) === job) this.refreshing.delete(id); });
    this.refreshing.set(id, job);
    return job;
  }

  chatSnapshot(sessionId: string): AgentChatSnapshot | undefined {
    return this.snapshots.get(sessionId);
  }

  async readChatHistory(_sessionId: string, _cursor: string): Promise<AgentChatHistoryPage> {
    throw new Error('DeepSeek Harness 的图形记录只读取最近窗口，更早记录请在原生界面查看');
  }

  onChat(listener: (sessionId: string, snapshot: AgentChatSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async sendPrompt(sessionId: string, text: string): Promise<{ turnId: string }> {
    if (this.options.writerWritable?.(sessionId) === false) throw new Error('当前输入由 dsh-tui 持有；请先在图形对话中接管，再发送消息');
    if (!text.trim()) throw new Error('消息不能为空');
    await this.native.start();
    await this.native.prompt(sessionId, text);
    const turnId = randomUUID();
    const pending = this.pendingSynthetics.get(sessionId) ?? [];
    if (!this.snapshots.get(sessionId)?.activeTurnId) pending.push(turnId);
    this.pendingSynthetics.set(sessionId, pending);
    this.schedule(sessionId);
    return { turnId };
  }

  async getStatus(sessionId: string): Promise<{ status: SessionStatus; detail: string; timestamp: string }> {
    const status = await this.native.getStatus(sessionId);
    return { status: status.status, detail: status.detail ?? 'DeepSeek Harness 状态未知', timestamp: new Date().toISOString() };
  }

  async answerChatRequest(sessionId: string, requestId: string, answer: AgentChatAnswer): Promise<void> {
    const pending = this.native.pendingRequests?.(sessionId);
    const question = pending?.questions.find(item => item.callId === requestId);
    if (!question) {
      if (pending?.approvals.some(item => item.id === requestId)) throw new Error('审批只能在 DeepSeek Harness 原生界面处理');
      throw new Error('这个请求已结束，请刷新确认');
    }
    if (!this.native.answerQuestion) throw new Error('当前 DeepSeek Harness 版本没有提供网页回答接口');
    const parsed = questionsFromRequest(question.questions, 0) ?? [];
    if (!parsed.length || parsed.some(item => item.multiSelect)) throw new Error('这组问题无法在网页安全提交，请到原生界面回答');
    const answers = parsed.map(item => {
      const values = answer.answers?.[item.id] ?? [];
      const labels = new Set((item.options ?? []).map(option => option.label));
      const selected = values.filter(value => labels.has(value));
      const custom = values.filter(value => !labels.has(value)).join('\n').trim();
      return { id: item.id, selected, ...(custom ? { custom } : {}) };
    });
    await this.native.answerQuestion(sessionId, requestId, answers);
    this.schedule(sessionId);
  }

  async stopSession(sessionId: string): Promise<void> {
    await this.native.stopSession(sessionId);
    this.live.delete(sessionId);
    this.pendingSynthetics.set(sessionId, []);
    this.schedule(sessionId);
  }

  async readChatSettings(sessionId: string): Promise<AgentChatSettings> {
    if (!this.native.readChatSettings) {
      return {
        nativeSessionId: sessionId,
        version: 'dsh',
        model: null,
        models: [],
        permission: null,
        permissions: [],
        modelReason: '当前 DeepSeek Harness 版本未提供模型目录',
        permissionReason: '当前 DeepSeek Harness 版本未提供权限目录',
        disabledReason: '当前 DeepSeek Harness 版本只能在原生界面修改模型和权限',
        scope: '原生界面',
      };
    }
    const native = await this.native.readChatSettings(sessionId);
    const version = this.settingsVersions.get(sessionId) ?? randomUUID();
    this.settingsVersions.set(sessionId, version);
    const snapshot = this.snapshots.get(sessionId) ?? await this.readNative(sessionId);
    const active = !!snapshot?.activeTurnId || (snapshot?.requests.length ?? 0) > 0;
    const tuiOwned = this.options.writerWritable?.(sessionId) === false;
    return {
      nativeSessionId: sessionId,
      version,
      model: native.model,
      models: native.models,
      permission: native.permission,
      permissions: native.permissions,
      ...(native.permissionLabel ? { permissionLabel: native.permissionLabel } : {}),
      ...(native.models.length ? {} : { modelReason: 'DeepSeek Harness 未返回可用模型目录' }),
      ...(native.permissions.length ? {} : { permissionReason: 'DeepSeek Harness 未返回权限预设目录' }),
      ...(tuiOwned ? { disabledReason: '当前输入由 dsh-tui 持有；先接管图形对话，再修改原生模型和权限' } : active ? { disabledReason: '请等待当前任务、审批或问题处理结束后再修改原生设置' } : {}),
      scope: '作用于当前原生 dsh 会话；通过原生 Session API 修改。',
    };
  }

  async updateChatSettings(sessionId: string, update: AgentChatSettingsUpdate): Promise<AgentChatSettings> {
    const current = await this.readChatSettings(sessionId);
    if (update.version !== current.version) throw new Error('原生设置已变化，请刷新后重试');
    if (current.disabledReason) throw new Error(current.disabledReason);
    if (!this.native.updateChatSettings) throw new Error('当前 DeepSeek Harness 版本没有提供网页设置接口');
    if (update.field !== 'model' && update.field !== 'permission') throw new Error('不支持的设置项');
    await this.native.updateChatSettings(sessionId, update.field, update.value);
    this.settingsVersions.set(sessionId, randomUUID());
    return this.readChatSettings(sessionId);
  }
}
