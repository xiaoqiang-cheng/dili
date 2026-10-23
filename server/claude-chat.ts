import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import type { AgentChatAnswer, AgentChatHistoryPage, AgentChatItem, AgentChatRequest, AgentChatSnapshot, AgentChatSettings, AgentChatSettingsUpdate } from '../shared/chat.ts';
import { checkSettingsUpdate, settingsError, settingsVersion } from './agents/settings.ts';
import type { ConversationTranscript, SessionStatus } from '../shared/types.ts';
import type { LaunchCommand } from './terminal.ts';
import { OwnedProcess } from './owned-process.ts';

type Row = Record<string, any>;
const object = (value: unknown): Row | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined;
const reject = (text: string): never => { throw Object.assign(new Error(text), { deliveryUnknown: false, status: 409 }); };
export interface ClaudeChatStatus { status: SessionStatus; detail: string; timestamp: string; attentionKey?: string; running?: false }
interface Run {
  child: ChildProcessWithoutNullStreams; owner: OwnedProcess; snapshot: AgentChatSnapshot;
  alive: boolean; stopping: boolean; pending: Map<string, { resolve(value: Row): void; reject(error: Error): void; timer: NodeJS.Timeout }>;
  requests: Map<string, { nativeId: string; input: Row; tool: string }>;
  messageId?: string; blocks: Map<number, string>; completedBlocks: Map<string, number>; stderr: string;
  settings?: AgentChatSettings; changingSettings?: boolean;
  historyRefresh?: Promise<void>; historyDirty?: boolean;
  inheritedHistory?: AgentChatItem[];
}

/** Claude's own stream-json protocol. No TUI scraping, API credentials or SDK
 * dependency: the installed CLI still owns tools, auth, permissions and history. */
export class ClaudeChatBridge {
  private runs = new Map<string, Run>();
  private events = new EventEmitter();
  constructor(private readonly history?: (id: string, cursor?: string) => Promise<AgentChatHistoryPage>) {}
  onChat(listener: (id: string, snapshot: AgentChatSnapshot) => void) { this.events.on('chat', listener); return () => this.events.off('chat', listener); }
  onStatus(listener: (id: string, status: ClaudeChatStatus) => void) { this.events.on('status', listener); return () => this.events.off('status', listener); }
  onInput(listener: (id: string, text: string) => void) { this.events.on('input', listener); return () => this.events.off('input', listener); }
  has(id: string) { return this.runs.get(id)?.alive === true; }
  chatSnapshot(id: string) {
    const run = this.runs.get(id);
    // HTTP/SSE retain previous snapshots to calculate patches. Never let a
    // later native delta mutate their baseline, or the patch silently vanishes.
    return run?.alive ? { ...run.snapshot, items: run.snapshot.items.map(item => ({ ...item })), requests: [...run.snapshot.requests] } : undefined;
  }
  async readChat(id: string): Promise<AgentChatSnapshot> {
    const snapshot = this.chatSnapshot(id);
    if (snapshot) return snapshot;
    if (!this.history) throw new Error('Claude 图形连接尚未启动');
    const page = await this.history(id);
    // A process may have started while the read-only page was pending.
    const previous = this.runs.get(id);
    const inherited = !page.items.length ? previous?.inheritedHistory : undefined;
    return this.chatSnapshot(id) ?? { nativeSessionId: id, connected: false, revision: 0, activeTurnId: null, requests: [], items: inherited ?? page.items, historyCursor: page.nextCursor, truncated: page.truncated || !!page.nextCursor || (!!inherited && !!previous?.snapshot.truncated) };
  }
  async readChatSettings(id: string): Promise<AgentChatSettings> {
    const run = this.runs.get(id);
    if (!run?.alive || !run.snapshot.connected || !run.settings) return settingsError('请先连接 Claude 图形会话');
    return { ...run.settings, ...(run.changingSettings || run.snapshot.activeTurnId || run.snapshot.requests.length ? { disabledReason: '请等待当前任务、审批或设置修改结束' } : {}) };
  }
  async updateChatSettings(id: string, update: AgentChatSettingsUpdate): Promise<AgentChatSettings> {
    const run = this.runs.get(id);
    checkSettingsUpdate(await this.readChatSettings(id), update);
    if (!run?.alive || this.runs.get(id) !== run || run.settings?.version !== update.version || run.changingSettings || run.snapshot.activeTurnId || run.snapshot.requests.length) return settingsError('原生会话正在处理任务或设置，或连接已变化，请刷新后重试');
    run.changingSettings = true;
    try {
      const response = await this.control(run, update.field === 'model' ? { subtype: 'set_model', model: update.value } : { subtype: 'set_permission_mode', mode: update.value });
      if (this.runs.get(id) !== run || !run.alive) return settingsError('原生执行器已变化，请刷新设置');
      const actual = response[update.field === 'model' ? 'model' : 'mode'];
      // Acknowledgement must contain the actual native value. Never claim an
      // empty success envelope confirms a setting in an older CLI.
      if (typeof actual !== 'string' || !actual) {
        run.settings = settingsVersion(undefined, { ...run.settings!, [update.field]: null });
        return settingsError('原生进程未返回设置确认，请刷新检查；当前 CLI 可能不支持此操作');
      }
      run.settings = settingsVersion(undefined, { ...run.settings!, [update.field]: actual });
    } catch (cause) {
      if (!(cause as { nativeRejected?: boolean })?.nativeRejected && run.settings) run.settings = settingsVersion(undefined, { ...run.settings, [update.field]: null });
      throw cause;
    } finally { run.changingSettings = false; }
    return this.readChatSettings(id);
  }
  async readChatHistory(id: string, cursor: string): Promise<AgentChatHistoryPage> {
    if (!this.history) return reject('当前连接不支持历史分页');
    return this.history(id, cursor);
  }
  private changed(id: string, run: Run) {
    // Bound both SSE frames and long-lived process memory. Trim only complete
    // old items so a tool-heavy turn cannot evict its active streaming block.
    let size = 0;
    const previousLength = run.snapshot.items.length;
    run.snapshot.items = run.snapshot.items.toReversed().filter((item, index) => {
      size += item.text.length + (item.output?.length ?? 0);
      const keep = index < 200 && size <= 512_000;
      if (!keep) run.snapshot.truncated = true;
      return keep;
    }).reverse();
    if (run.snapshot.items.length < previousLength) {
      run.historyDirty = true;
      this.refreshHistoryCursor(id, run);
    }
    run.snapshot.revision++;
    this.events.emit('chat', id, this.chatSnapshot(id) ?? { ...run.snapshot, items: run.snapshot.items.map(item => ({ ...item })) });
  }
  private refreshHistoryCursor(id: string, run: Run) {
    if (!this.history || run.historyRefresh || !run.alive) return;
    run.historyDirty = false;
    run.historyRefresh = this.history(id).then(page => {
      if (this.runs.get(id) !== run || !run.alive) return;
      // A fresh tail cursor overlaps retained live items; the shared panel
      // deduplicates them. Keeping the original cursor would leave a gap after
      // messages generated since startup leave the bounded live snapshot.
      run.snapshot.historyCursor = page.nextCursor;
      if (page.items.length) run.inheritedHistory = undefined;
      this.changed(id, run);
    }).catch(() => { /* Saved history is optional while a turn is still writing. */ }).finally(() => {
      run.historyRefresh = undefined;
      if (run.historyDirty) this.refreshHistoryCursor(id, run);
    });
  }
  private status(id: string, status: SessionStatus, detail: string, extra: Partial<ClaudeChatStatus> = {}) {
    this.events.emit('status', id, { status, detail, timestamp: new Date().toISOString(), ...extra });
  }
  async start(id: string, cwd: string, command: LaunchCommand, history: ConversationTranscript = { messages: [], truncated: false }) {
    if (this.has(id)) return;
    let page = await this.history?.(id);
    let inheritedHistory: AgentChatItem[] | undefined;
    if (page && !page.items.length && command.args.includes('--fork-session')) {
      const resume = command.args.indexOf('--resume');
      const source = resume >= 0 ? command.args[resume + 1] : undefined;
      if (source && source !== id) {
        // Native Claude creates the fork log only after the first prompt. Show
        // a bounded source page meanwhile, with the UUIDs the fork will retain.
        // Its cursor is source-bound and must never be reused for this child.
        const parent = await this.history!(source);
        inheritedHistory = parent.items.map(item => ({ ...item, id: item.id.replace(`claude:${source}:`, `claude:${id}:`) }));
        page = { ...page, items: inheritedHistory, truncated: parent.truncated || !!parent.nextCursor };
      }
    }
    if (this.has(id)) return;
    const env = { ...process.env, ...command.env };
    delete env.CLAUDECODE; delete env.SESSIONDECK_TOKEN;
    const child = spawn(command.file, [...command.args, '--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--permission-prompt-tool', 'stdio'], { cwd, env, stdio: 'pipe' });
    let exited!: () => void;
    const exit = new Promise<void>(resolve => { exited = resolve; });
    const run: Run = {
      child, owner: new OwnedProcess(child.pid ?? -1, exit, signal => { child.kill(signal); }), alive: true, stopping: false, pending: new Map(), requests: new Map(), blocks: new Map(), completedBlocks: new Map(), stderr: '',
      inheritedHistory: inheritedHistory?.map(item => ({ ...item })),
      snapshot: { nativeSessionId: id, connected: false, revision: 0, activeTurnId: null, items: page?.items ?? history.messages.map(message => ({ id: message.id, type: message.role, text: message.text, status: 'completed' })), requests: [], truncated: page ? page.truncated || !!page.nextCursor : history.truncated, historyCursor: page?.nextCursor },
    };
    this.runs.delete(id); this.runs.set(id, run);
    for (const [key, old] of this.runs) if (this.runs.size > 100 && !old.alive) this.runs.delete(key);
    let buffer = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (this.runs.get(id) !== run || !run.alive) return;
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (line.length > 8_000_000) { void this.closeSession(id); return; }
        try { const row = object(JSON.parse(line)); if (row) this.receive(id, run, row); } catch { /* stderr is separate; ignore non-protocol lines */ }
      }
      if (buffer.length > 8_000_000) void this.closeSession(id);
    });
    child.stderr.on('data', (data: string) => { run.stderr = (run.stderr + data).slice(-4000); });
    const end = (error?: Error, code?: number | null) => {
      exited();
      if (!run.alive) return;
      run.alive = false; run.snapshot.connected = false;
      for (const pending of run.pending.values()) { clearTimeout(pending.timer); pending.reject(error ?? new Error(run.stderr.trim() || `Claude 原生进程已退出（${code}）`)); }
      run.pending.clear(); run.requests.clear(); run.snapshot.requests = [];
      this.finish(run, true);
      if (this.runs.get(id) !== run) return;
      this.changed(id, run);
      if (!run.stopping) this.status(id, 'error', error?.message || run.stderr.trim() || `Claude 原生进程已退出（${code}）`, { running: false });
    };
    child.stdin.on('error', () => { void run.owner.stop().catch(() => {}); });
    child.once('error', error => end(error)); child.once('close', code => end(undefined, code));
    try {
      const initialized = await this.control(run, { subtype: 'initialize' });
      if (!run.alive) throw new Error('Claude 原生进程已退出');
      if (page && (!page.items.length || inheritedHistory)) {
        const saved = await this.history!(id);
        if (!run.alive || this.runs.get(id) !== run) throw new Error('Claude 原生连接已变化');
        if (saved.items.length) {
          run.snapshot.items = saved.items;
          run.snapshot.historyCursor = saved.nextCursor;
          run.snapshot.truncated = saved.truncated || !!saved.nextCursor;
          run.inheritedHistory = undefined;
        }
      }
      const models = (Array.isArray(initialized.models) ? initialized.models : []).filter((model: Row) => typeof model.value === 'string').slice(0, 100).map((model: Row) => ({ id: model.value as string, label: String(model.displayName || model.value), description: typeof model.description === 'string' ? model.description : undefined }));
      const modelIndex = command.args.indexOf('--model');
      run.settings = settingsVersion(undefined, {
        nativeSessionId: id, model: modelIndex >= 0 ? command.args[modelIndex + 1] ?? null : null, models,
        permission: typeof initialized.current_permission_mode === 'string' ? initialized.current_permission_mode : null,
        permissions: typeof initialized.current_permission_mode === 'string' ? [
          { id: 'default', label: '默认审批', description: '沿用原生允许规则，其他操作请求审批' },
          { id: 'acceptEdits', label: '自动接受编辑', description: '允许文件编辑，其他操作仍按原生规则审批' },
          { id: 'plan', label: '计划模式', description: '先分析和规划，限制执行修改' },
        ] : [],
        ...(!models.length ? { modelReason: '当前 Claude 未返回模型列表，请检查 CLI 版本和原生配置' } : {}),
        ...(typeof initialized.current_permission_mode !== 'string' ? { permissionReason: '当前 Claude 未报告权限模式，请升级 CLI 后重试' } : {}),
        scope: '作用于当前 Claude 图形执行器；切换至终端或重开执行器后重新沿用原生配置。',
      });
      for (const request of [...(Array.isArray(initialized.pending_permission_requests) ? initialized.pending_permission_requests : []), ...(Array.isArray(initialized.pending_user_dialog_requests) ? initialized.pending_user_dialog_requests : [])]) {
        const row = object(request); if (row) this.receive(id, run, row);
      }
      run.snapshot.connected = true; this.changed(id, run);
      if (!run.snapshot.requests.length) this.status(id, 'waiting_input', 'Claude 原生流式会话已就绪');
    } catch (error) { await this.closeSession(id); throw error; }
  }
  private write(run: Run, row: Row): Promise<void> {
    if (!run.alive || run.child.stdin.destroyed) return Promise.reject(new Error('Claude 原生连接已断开'));
    return new Promise((resolve, reject) => { run.child.stdin.write(JSON.stringify(row) + '\n', error => error ? reject(error) : resolve()); });
  }
  private control(run: Run, request: Row): Promise<Row> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { run.pending.delete(id); reject(new Error('Claude 原生控制请求超时')); }, 45_000);
      run.pending.set(id, { resolve, reject, timer });
      void this.write(run, { type: 'control_request', request_id: id, request }).catch(error => { clearTimeout(timer); run.pending.delete(id); reject(error); });
    });
  }
  private upsert(run: Run, item: AgentChatItem) {
    item.text = item.text.slice(0, 32_000);
    if (item.output) item.output = item.output.slice(0, 24_000);
    const index = run.snapshot.items.findIndex(old => old.id === item.id);
    if (index < 0) run.snapshot.items.push(item); else run.snapshot.items[index] = item;
  }
  private finish(run: Run, failed: boolean) {
    for (const item of run.snapshot.items) if (item.status === 'inProgress') item.status = failed ? 'failed' : 'completed';
    run.snapshot.activeTurnId = null; run.messageId = undefined; run.blocks.clear(); run.completedBlocks.clear();
    run.requests.clear(); run.snapshot.requests = [];
  }
  private receive(id: string, run: Run, row: Row) {
    if (row.type === 'control_response') {
      const reply = object(row.response), pending = reply && run.pending.get(reply.request_id);
      if (pending) { clearTimeout(pending.timer); run.pending.delete(reply!.request_id); if (reply!.subtype === 'error') pending.reject(Object.assign(new Error(String(reply!.error)), { nativeRejected: true })); else pending.resolve(object(reply!.response) ?? {}); }
      return;
    }
    if (row.session_id && row.session_id !== id) {
      this.status(id, 'error', 'Claude 返回了不同的会话标识，已关闭连接'); void this.closeSession(id); return;
    }
    if (row.parent_tool_use_id) return; // subagent output is not this contact's reply
    if (row.type === 'system' && run.settings && (row.subtype === 'init' || row.subtype === 'status')) {
      run.settings = settingsVersion(run.settings, { ...run.settings, ...(typeof row.model === 'string' ? { model: row.model } : {}), ...(typeof row.permissionMode === 'string' ? { permission: row.permissionMode } : {}) });
      return;
    }
    if (row.type === 'stream_event') {
      const event = object(row.event); if (!event) return;
      if (event.type === 'message_start') { run.messageId = event.message?.id; run.blocks.clear(); run.completedBlocks.clear(); }
      const blockId = `claude-live:${id}:${run.messageId}:${event.index}`;
      if (event.type === 'content_block_start' && event.content_block?.type === 'text') {
        run.blocks.set(event.index, blockId);
        this.upsert(run, { id: blockId, turnId: run.snapshot.activeTurnId ?? undefined, type: 'assistant', text: String(event.content_block.text ?? ''), status: 'inProgress' });
      } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        const item = run.snapshot.items.find(item => item.id === run.blocks.get(event.index));
        if (item) item.text = (item.text + String(event.delta.text ?? '')).slice(0, 32_000);
      } else if (event.type === 'content_block_stop') {
        const item = run.snapshot.items.find(item => item.id === run.blocks.get(event.index));
        if (item) item.status = 'completed';
      }
    } else if (row.type === 'assistant') {
      const body = object(row.message);
      if (!body || !Array.isArray(body.content)) return;
      const savedId = typeof row.uuid === 'string' ? `claude:${id}:${row.uuid}` : undefined;
      if (savedId && run.snapshot.items.some(item => item.id === savedId)) return;
      const replaced: string[] = [];
      const texts: string[] = [];
      for (const [index, block] of body.content.entries()) {
        if (block.type === 'text') {
          // Claude versions may emit one assistant envelope per content block
          // (content is then a one-element array), or the complete array.
          // Match sequential final blocks to the original native stream index.
          const candidates = [...new Set(run.snapshot.items.flatMap(item => [item.id, ...(item.replaces ?? [])]).filter(key => key.startsWith(`claude-live:${id}:${body.id}:`)))].sort((a, b) => Number(a.split(':').at(-1)) - Number(b.split(':').at(-1)));
          const ordinal = run.completedBlocks.get(body.id) ?? 0;
          const native = body.content.length === 1 ? candidates[ordinal] : candidates.find(key => key === `claude-live:${id}:${body.id}:${index}`);
          const messageId = native ?? `claude-live:${id}:${body.id}:${index}`;
          if (savedId) { replaced.push(messageId); texts.push(String(block.text ?? '')); }
          else this.upsert(run, { id: messageId, turnId: run.snapshot.activeTurnId ?? undefined, type: 'assistant', text: String(block.text ?? ''), status: 'completed' });
          run.completedBlocks.set(body.id, ordinal + 1);
        }
        if (block.type === 'tool_use') this.upsert(run, { id: `claude-tool:${id}:${block.id}`, turnId: run.snapshot.activeTurnId ?? undefined, type: 'tool', title: String(block.name), text: JSON.stringify(block.input, null, 2) ?? '', status: 'inProgress' });
      }
      if (savedId && texts.length) {
        const first = run.snapshot.items.findIndex(item => replaced.includes(item.id));
        run.snapshot.items = run.snapshot.items.filter(item => !replaced.includes(item.id));
        const item: AgentChatItem = { id: savedId, replaces: replaced, turnId: run.snapshot.activeTurnId ?? undefined, type: 'assistant', text: texts.join('\n\n').slice(0, 32_000), status: 'completed' };
        run.snapshot.items.splice(first < 0 ? run.snapshot.items.length : first, 0, item);
      }
    } else if (row.type === 'user') {
      for (const block of Array.isArray(row.message?.content) ? row.message.content : []) if (block.type === 'tool_result') {
        const item = run.snapshot.items.find(item => item.id === `claude-tool:${id}:${block.tool_use_id}`);
        if (item) { item.status = block.is_error ? 'failed' : 'completed'; item.output = (typeof block.content === 'string' ? block.content : JSON.stringify(block.content) ?? '').slice(0, 24_000); }
      }
    } else if (row.type === 'result') {
      if (run.inheritedHistory || run.snapshot.truncated) this.refreshHistoryCursor(id, run);
      const turnId = run.snapshot.activeTurnId;
      const failed = row.is_error === true || row.subtype !== 'success';
      this.finish(run, failed);
      if (failed) this.upsert(run, { id: randomUUID(), type: 'notice', text: String(row.errors?.join('\n') || row.result || '本轮任务未完成'), status: 'failed' });
      this.status(id, failed ? 'error' : 'waiting_input', failed ? '本轮任务未完成，可继续对话' : '本轮回复已结束，可以继续或验收', { attentionKey: `claude:${turnId}` });
    } else if (row.type === 'control_request') {
      const request = object(row.request), nativeId = row.request_id;
      if (!request || typeof nativeId !== 'string' || run.requests.size >= 50) return;
      if ([...run.requests.values()].some(value => value.nativeId === nativeId)) return;
      if (request.subtype !== 'can_use_tool') {
        void this.write(run, { type: 'control_response', response: { subtype: 'error', request_id: nativeId, error: 'Dili 暂不支持此交互请求' } }).catch(() => {}); return;
      }
      const handle = randomUUID(), input = object(request.input) ?? {};
      const item: AgentChatRequest = { id: handle, kind: 'approval', title: `Claude 请求使用 ${String(request.tool_name)}`, details: JSON.stringify(input, null, 2).slice(0, 24_000), options: [{ id: 'allow', label: '允许本次' }, { id: 'deny', label: '拒绝' }] };
      if (request.tool_name === 'AskUserQuestion' && Array.isArray(input.questions)) {
        item.kind = 'question'; item.title = 'Claude 需要你补充信息'; item.details = undefined;
        item.questions = input.questions.slice(0, 10).map((question: Row, index: number) => ({ id: String(index), header: String(question.header ?? ''), question: String(question.question ?? ''), isOther: true, options: (Array.isArray(question.options) ? question.options : []).slice(0, 20).map((option: Row) => ({ label: String(option.label), description: String(option.description ?? '') })) }));
      }
      run.requests.set(handle, { nativeId, input, tool: String(request.tool_name) }); run.snapshot.requests.push(item);
      this.status(id, 'waiting_approval', item.title, { attentionKey: handle });
    } else if (row.type === 'control_cancel_request') {
      for (const [handle, request] of run.requests) if (request.nativeId === row.request_id) { run.requests.delete(handle); run.snapshot.requests = run.snapshot.requests.filter(item => item.id !== handle); }
    } else return;
    this.changed(id, run);
  }
  async sendPrompt(id: string, text: string, _model?: string, images: string[] = [], expectedTurnId?: string) {
    const run = this.runs.get(id);
    if (!run?.alive || !run.snapshot.connected) return reject('请先连接 Claude 图形会话');
    if (run.changingSettings) return reject('Claude 正在修改设置，请稍后发送');
    if (run.snapshot.activeTurnId || expectedTurnId) return reject('Claude 正在生成，请将消息加入队列');
    if (run.snapshot.requests.length) return reject('请先处理 Claude 的审批或提问');
    const content: Row[] = [];
    for (const path of images) {
      const data = await readFile(path).catch(() => reject('图片已不可用，请重新添加'));
      const ext = path.split('.').at(-1)?.toLowerCase(), mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
      content.push({ type: 'image', source: { type: 'base64', media_type: mime, data: data.toString('base64') } });
    }
    // Loading attachments yielded: check again before reserving the native turn.
    if (!run.alive || run.changingSettings || run.snapshot.activeTurnId || run.snapshot.requests.length) return reject('Claude 会话状态已变化，请重试');
    if (text.trim()) content.push({ type: 'text', text });
    const turnId = randomUUID(); run.snapshot.activeTurnId = turnId;
    this.upsert(run, { id: `claude:${id}:${turnId}`, turnId, type: 'user', text, imageCount: images.length, status: 'completed' });
    this.status(id, 'running', 'Claude 正在处理你的输入'); this.changed(id, run);
    await this.write(run, { type: 'user', uuid: turnId, session_id: id, message: { role: 'user', content }, parent_tool_use_id: null });
    this.events.emit('input', id, text || '[图片]');
    return { turnId };
  }
  async answerChatRequest(id: string, handle: string, answer: AgentChatAnswer) {
    const run = this.runs.get(id), pending = run?.requests.get(handle);
    if (!run?.alive || !pending) return reject('这个审批或提问已失效');
    let response: Row;
    if (pending.tool === 'AskUserQuestion') {
      const questions = run.snapshot.requests.find(item => item.id === handle)?.questions ?? [];
      if (!answer.answers || questions.some(question => {
        const values = answer.answers?.[question.id];
        return !Array.isArray(values) || !values.length || values.length > 20 || values.some(value => typeof value !== 'string' || !value.trim() || value.length > 8000);
      }) || Object.keys(answer.answers).some(key => !questions.some(question => question.id === key))) return reject('请回答当前问题');
      const answers = Object.fromEntries(questions.map(question => [question.question, answer.answers![question.id].join(', ')]));
      response = { behavior: 'allow', updatedInput: { ...pending.input, answers } };
    } else {
      if (answer.decision !== 'allow' && answer.decision !== 'deny') return reject('审批选项无效');
      response = answer.decision === 'allow' ? { behavior: 'allow', updatedInput: pending.input } : { behavior: 'deny', message: '用户拒绝了本次操作' };
    }
    // Consume before awaiting stdin so concurrent HTTP retries cannot answer twice.
    run.requests.delete(handle); run.snapshot.requests = run.snapshot.requests.filter(item => item.id !== handle);
    await this.write(run, { type: 'control_response', response: { subtype: 'success', request_id: pending.nativeId, response } });
    this.status(id, 'running', 'Claude 正在继续处理任务'); this.changed(id, run);
  }
  async stopSession(id: string) {
    const run = this.runs.get(id); if (!run?.alive || !run.snapshot.activeTurnId) return;
    await this.control(run, { subtype: 'interrupt' });
    // The native result frame owns turn completion; an interrupt receipt alone
    // is not proof that tools or queued work have stopped.
  }
  async getStatus(id: string): Promise<{ status: SessionStatus; detail: string; timestamp: string }> { const run = this.runs.get(id); return { timestamp: new Date().toISOString(), status: run?.snapshot.requests.length ? 'waiting_approval' : run?.snapshot.activeTurnId ? 'running' : run?.alive ? 'waiting_input' : 'stopped', detail: run?.alive ? 'Claude 原生连接已就绪' : 'Claude 原生连接未启动' }; }
  async closeSession(id: string) {
    const run = this.runs.get(id); if (!run?.alive) return;
    run.stopping = true;
    await run.owner.stop();
  }
  async close() { await Promise.all([...this.runs.keys()].map(id => this.closeSession(id))); this.events.removeAllListeners(); }
}
