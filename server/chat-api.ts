import type express from 'express';
import type { Backend, ConversationTranscript, Session } from '../shared/types.ts';
import type { AgentChatPatch, AgentChatSnapshot } from '../shared/chat.ts';
import type { AgentChatAdapter, AgentChatAdapters } from './agents/chat.ts';
import type { ConversationReader } from './conversation.ts';
import type { ChatSubmissions } from './chat-submissions.ts';
import type { Attachments } from './attachments.ts';
import type { Store } from './store.ts';

interface Dependencies {
  store: Store;
  attachments: Attachments;
  submissions: ChatSubmissions;
  adapters: AgentChatAdapters;
  conversations: ConversationReader;
  instanceId: string;
  demo: boolean;
  closing(): boolean;
  supported(item: Session): boolean;
  ready(item: Session): boolean;
  busy(id: string): boolean;
  sessions(): Session[];
  broadcast(): void;
  updatePreview(item: Session, transcript: ConversationTranscript, persisted?: boolean): void;
}
const fail = (message: string, status = 400): never => { throw Object.assign(new Error(message), { status }); };
const requestId = (value: unknown): string => typeof value === 'string' && /^[a-zA-Z0-9_-]{16,100}$/.test(value) ? value : fail('发送标识无效');
interface Viewer { response: express.Response; previous?: AgentChatSnapshot; device?: string }

export function registerAgentChat(app: express.Express, options: Dependencies) {
  const { store, conversations } = options;
  const bridgeFor = (item: Session): AgentChatAdapter => options.adapters[item.backend] ?? fail(`${item.backend} 尚未注册图形聊天适配器`);
  const submissions = options.submissions;
  const viewers = new Map<string, Set<Viewer>>();
  const scheduled = new Map<string, NodeJS.Timeout>();
  const snapshots = new Map<string, AgentChatSnapshot>();
  let revision = 0;
  function session(id: string): Session {
    const item = store.session(id) ?? fail('会话不存在', 404);
    if (!options.adapters[item.backend]) fail('这个后端尚未支持原生流式图形聊天');
    return item;
  }
  function writable(id: string): Session {
    const item = session(id);
    if (options.demo || !options.supported(item)) fail('当前后端不支持原生图形化交互，请使用原生终端');
    if (options.closing() || options.busy(id)) fail('会话正在启动或停止，请稍后重试', 409);
    if (item.archived || item.forkPending || !item.running || !item.nativeSessionId || !options.ready(item)) fail('请先启动或恢复这个图形会话', 409);
    return item;
  }
  function remember(id: string, snapshot: AgentChatSnapshot) {
    const previous = snapshots.get(id);
    const comparable = { ...snapshot, instanceId: options.instanceId, revision: 0 };
    if (previous && JSON.stringify({ ...previous, revision: 0 }) === JSON.stringify(comparable)) return previous;
    const next = { ...comparable, revision: ++revision };
    snapshots.delete(id); snapshots.set(id, next);
    // Only visible or recently accessed contacts need an HTTP view cache.
    for (const key of snapshots.keys()) {
      if (snapshots.size <= 100) break;
      if (!viewers.has(key)) snapshots.delete(key);
    }
    return next;
  }
  function nativeView(item: Session, snapshot: AgentChatSnapshot) {
    return remember(item.id, { ...snapshot, connected: item.running && options.ready(item) && snapshot.connected });
  }
  async function read(id: string) {
    const item = session(id), bridge = bridgeFor(item);
    const identity = item.nativeSessionId;
    if (!options.demo && identity && !item.forkPending) {
      try {
        const native = await bridge.readChat(identity);
        if (options.closing()) fail('服务正在关闭', 503);
        const current = session(id);
        if (current.nativeSessionId !== identity || current.forkPending) fail('会话身份已更新，请刷新', 409);
        // Bridge merges live events received while the recent page was pending.
        return nativeView(current, native);
      } catch (error) {
        if (options.closing() || (error as { status?: number }).status === 409) throw error;
        const cached = bridge.chatSnapshot(identity);
        // Even one enormous turn can exceed the frame limit after reducing
        // page size. Keep the bounded local fallback and never expose an empty
        // observer snapshot instead of an imported transcript.
        const message = error instanceof Error ? error.message : String(error);
        const payloadTooLarge = /payload size exceeded|max payload|message too large/i.test(message);
        if (cached?.items.length && !payloadTooLarge) return nativeView(session(id), cached);
      }
    }
    const transcript = options.demo ? { messages: [], truncated: false, notice: '演示终端不调用真实 Codex，请连接原生 Codex 使用图形化聊天。' } : await conversations.read(item);
    if (options.closing()) fail('服务正在关闭', 503);
    const current = session(id);
    if (current.nativeSessionId !== identity || current.forkPending !== item.forkPending) fail('会话身份已更新，请刷新', 409);
    options.updatePreview(item, transcript);
    const live = identity && !item.forkPending ? bridge.chatSnapshot(identity) : undefined;
    return remember(id, {
      nativeSessionId: item.forkPending ? null : identity, connected: !!live?.connected && current.running && options.ready(current), revision: 0, activeTurnId: live?.activeTurnId ?? null,
      items: transcript.messages.map(message => ({ id: message.id, type: message.role, text: message.text, status: 'completed' })),
      requests: live?.requests ?? [], truncated: transcript.truncated, notice: transcript.notice,
    });
  }
  function emit(id: string, snapshot: AgentChatSnapshot) {
    for (const viewer of viewers.get(id) ?? []) {
      const { response, previous } = viewer;
      if (response.destroyed || response.writableLength > 2_097_152) { response.destroy(); viewers.get(id)?.delete(viewer); continue; }
      if (previous?.revision === snapshot.revision) continue;
      if (!previous || previous.nativeSessionId !== snapshot.nativeSessionId) response.write(`event: state\ndata: ${JSON.stringify(snapshot)}\n\n`);
      else {
        const oldItems = new Map(previous.items.map(item => [item.id, item]));
        const patch: AgentChatPatch = { ...snapshot, baseRevision: previous.revision, items: snapshot.items.filter(item => JSON.stringify(item) !== JSON.stringify(oldItems.get(item.id))), order: snapshot.items.map(item => item.id) };
        response.write(`event: patch\ndata: ${JSON.stringify(patch)}\n\n`);
      }
      viewer.previous = snapshot;
    }
  }
  function queue(id: string) {
    if (options.closing() || scheduled.has(id) || !viewers.has(id)) return;
    scheduled.set(id, setTimeout(() => {
      scheduled.delete(id);
      if (options.closing()) return;
      const item = store.session(id);
      const native = item?.nativeSessionId && !item.forkPending ? bridgeFor(item).chatSnapshot(item.nativeSessionId) : undefined;
      if (item && native) emit(id, nativeView(item, native));
      else void read(id).then(snapshot => emit(id, snapshot)).catch(() => {});
    }, 80));
  }
  const offChats = (Object.entries(options.adapters) as [Backend, AgentChatAdapter][]).map(([backend, bridge]) => bridge.onChat((nativeId) => {
    if (options.closing()) return;
    const item = options.sessions().find(item => item.backend === backend && item.nativeSessionId === nativeId && !item.forkPending);
    if (!item) return;
    queue(item.id);
    // Bounded chat snapshots have no input timestamps and may contain only
    // older users. Saved native history owns previews; successful local sends
    // update immediately below, without letting late snapshot hydration regress them.
  }));
  const offStore = store.onChange(change => { if (change.table === 'sessions' && !!options.adapters[change.data.backend]) queue(change.data.id); });

  app.get('/api/sessions/:id/chat', async (req, res) => res.json(await read(String(req.params.id))));
  app.get('/api/sessions/:id/chat/settings', async (req, res) => {
    const item = writable(String(req.params.id)), identity = item.nativeSessionId!;
    const settings = await bridgeFor(item).readChatSettings(identity);
    if (writable(item.id).nativeSessionId !== identity) fail('会话身份已变化，请刷新', 409);
    res.json({ ...settings, ...(res.locals.principal?.kind === 'share' ? { disabledReason: '分享访问只能查看设置，请由所有者修改' } : {}) });
  });
  app.post('/api/sessions/:id/chat/settings', async (req, res) => {
    const item = writable(String(req.params.id)), identity = item.nativeSessionId!;
    const { version, field, value } = req.body;
    if (typeof version !== 'string' || version.length > 100 || !version || (field !== 'model' && field !== 'permission') || typeof value !== 'string' || !value || value.length > 200 || /[\x00-\x1f]/.test(value)) fail('设置参数无效');
    const settings = await bridgeFor(item).updateChatSettings(identity, { version, field, value }).catch(cause => {
      const error = cause instanceof Error ? cause : new Error('原生设置修改失败，请刷新确认');
      throw Object.assign(error, { status: (cause as { status?: number })?.status ?? 409 });
    });
    if (writable(item.id).nativeSessionId !== identity) fail('会话身份已变化，请刷新确认原生设置', 409);
    res.json(settings);
  });
  app.get('/api/sessions/:id/chat/history', async (req, res) => {
    const id = String(req.params.id), item = session(id), bridge = bridgeFor(item), identity = item.nativeSessionId;
    if (options.demo || !identity || item.forkPending) fail('当前会话没有可分页读取的原生历史', 409);
    const cursor = req.query.cursor;
    if (typeof cursor !== 'string' || !cursor || cursor.length > 8192 || /[\x00-\x1f]/.test(cursor)) fail('历史游标无效');
    const page = await bridge.readChatHistory(identity!, cursor as string);
    const current = session(id);
    if (options.closing()) fail('服务正在关闭', 503);
    if (current.nativeSessionId !== identity || current.forkPending) fail('会话身份已更新，请刷新', 409);
    res.json(page);
  });
  app.get('/api/sessions/:id/chat/events', async (req, res) => {
    const id = String(req.params.id);
    const item = session(id), bridge = bridgeFor(item);
    const viewer: Viewer = { response: res, device: typeof res.locals.device === 'string' ? res.locals.device : undefined };
    const set = viewers.get(id) ?? new Set<Viewer>(); set.add(viewer); viewers.set(id, set);
    res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Connection', 'keep-alive'); res.flushHeaders();
    const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 20_000);
    const cleanup = () => { clearInterval(heartbeat); set.delete(viewer); if (!set.size) viewers.delete(id); };
    req.on('close', cleanup);
    const native = item.nativeSessionId && !item.forkPending ? bridge.chatSnapshot(item.nativeSessionId) : undefined;
    const cached = native?.items.length ? nativeView(item, native) : snapshots.get(id);
    if (cached?.items.length && cached.nativeSessionId === item.nativeSessionId && !item.forkPending) emit(id, cached);
    try { const snapshot = await read(id); if (!res.destroyed) emit(id, snapshot); }
    catch (error) { if (!res.destroyed) { res.write(`event: unavailable\ndata: ${JSON.stringify({ error: error instanceof Error ? error.message : '无法读取原生聊天' })}\n\n`); res.end(); } }
  });
  app.get('/api/sessions/:id/chat/submissions/:requestId', (req, res) => {
    const item = session(String(req.params.id));
    res.json(submissions.get(item.id, requestId(req.params.requestId)) ?? fail('没有找到发送记录，请先核对会话历史', 404));
  });
  app.post('/api/sessions/:id/chat/messages', async (req, res) => {
    const item = writable(String(req.params.id)), bridge = bridgeFor(item);
    const id = requestId(req.body.requestId);
    if (req.body.model !== undefined) fail('请通过会话设置切换模型后再发送');
    if (typeof req.body.text !== 'string' || req.body.text.length > 32_000 || /\x00/.test(req.body.text)) fail('消息不能为空，且最多 32000 字符');
    const text = req.body.text.trim();
    const images = options.attachments.resolve(item.id, req.body.attachments);
    const expectedTurnId = req.body.expectedTurnId;
    if (expectedTurnId !== undefined && (typeof expectedTurnId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(expectedTurnId))) fail('任务 ID 无效');
    if (!text && !images.length) fail('消息不能为空');
    const { created, submission } = submissions.begin(item.id, id, item.nativeSessionId!, expectedTurnId ? JSON.stringify([text, req.body.attachments ?? [], expectedTurnId]) : images.length ? JSON.stringify([text, req.body.attachments]) : text);
    if (!created) return res.status(submission.status === 'unknown' || submission.status === 'sending' ? 202 : 200).json(submission);
    const inputAt = new Date().toISOString();
    try {
      const result = await bridge.sendPrompt(item.nativeSessionId!, text, undefined, images, expectedTurnId);
      if (options.closing()) return;
      const accepted = submissions.finish(item.id, id, { status: 'accepted', turnId: result.turnId });
      options.updatePreview(item, { messages: [{ id, role: 'user', text: text || '[图片]', createdAt: inputAt }], truncated: false }, false);
      res.json(accepted);
    } catch (cause) {
      if (options.closing()) return;
      const rejected = (cause as { deliveryUnknown?: boolean }).deliveryUnknown === false;
      const error = cause instanceof Error ? cause.message : '无法确认原生会话是否收到消息';
      const result = submissions.finish(item.id, id, { status: rejected ? 'rejected' : 'unknown', error });
      if (rejected) res.status(409).json({ ...result, error, code: 'CHAT_REJECTED' });
      else res.status(202).json(result);
    }
  });
  app.post('/api/sessions/:id/chat/connect', async (req, res) => {
    const item = writable(String(req.params.id)), bridge = bridgeFor(item), identity = item.nativeSessionId!;
    // Recover just the subscription. Never start an agent or interrupt a turn
    // as a side effect of retrying a failed graphical connection.
    const result = await bridge.getStatus(identity);
    const current = session(item.id);
    if (options.closing() || options.busy(item.id) || current.nativeSessionId !== identity || current.archived || current.forkPending || !current.running || !options.ready(current)) fail('会话身份或运行状态已变化，请重新进入会话', 409);
    if (!bridge.chatSnapshot(identity)?.connected) fail(result.detail || '原生连接恢复失败，请检查会话状态', 503);
    res.json({ connected: true });
  });
  app.post('/api/sessions/:id/chat/requests/:requestId', async (req, res) => {
    const item = writable(String(req.params.id)), bridge = bridgeFor(item);
    const id = String(req.params.requestId);
    if (!id || id.length > 200) fail('审批标识无效');
    await bridge.answerChatRequest(item.nativeSessionId!, id, req.body);
    res.json({ ok: true });
  });
  app.post('/api/sessions/:id/chat/interrupt', async (req, res) => {
    const item = writable(String(req.params.id)), bridge = bridgeFor(item);
    await bridge.stopSession(item.nativeSessionId!);
    res.json({ ok: true });
  });
  return { revalidate(valid: (device: string) => boolean) {
    // Revoked share devices stop receiving the native chat stream immediately.
    for (const set of viewers.values()) for (const viewer of set) if (viewer.device && !valid(viewer.device)) viewer.response.end();
  }, close() {
    offChats.forEach(off => off()); offStore();
    for (const timer of scheduled.values()) clearTimeout(timer);
    scheduled.clear();
    for (const set of viewers.values()) for (const viewer of set) viewer.response.end();
    viewers.clear(); snapshots.clear();
  } };
}
