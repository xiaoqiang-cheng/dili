import WebSocket from 'ws';
import type { ImAdapter, ImInbound } from './hub.ts';
import { FRAME_CONTROL, FRAME_DATA, decodeFrame, encodeFrame, header, type Frame } from './pbbp2.ts';

/** A Feishu (飞书) bot over the long connection: no public URL needed. The
 * protocol follows @larksuiteoapi/node-sdk 1.76 WSClient: POST
 * /callback/ws/endpoint with the app credentials returns a WebSocket URL and
 * ping settings; events arrive as pbbp2 data frames that must be ACKed with
 * {"code":200}; replies go through the IM v1 REST API. */
export interface FeishuCredentials { appId: string; appSecret: string }
export interface FeishuStatus { state: 'off' | 'connecting' | 'connected' | 'error'; error?: string; botName?: string; since?: string }

const DOMAIN = 'https://open.feishu.cn';
const clip = (text: string, max = 200) => text.length > max ? `${text.slice(0, max)}…` : text;

/** Text of an im.message.receive_v1 event, with @mention placeholders removed. */
export function feishuInbound(event: unknown, botOpenId?: string): ImInbound | null {
  const body = event as { header?: { event_type?: string; event_id?: string }; event?: { sender?: { sender_id?: { open_id?: string }; sender_type?: string }; message?: { message_id?: string; chat_id?: string; chat_type?: string; message_type?: string; content?: string; mentions?: { key?: string; id?: { open_id?: string } }[] } } };
  if (body?.header?.event_type !== 'im.message.receive_v1') return null;
  const message = body.event?.message, sender = body.event?.sender;
  if (!message?.chat_id || !message.message_id || !sender?.sender_id?.open_id || sender.sender_type === 'app') return null;
  let text = '';
  if (message.message_type === 'text') {
    try { text = String((JSON.parse(message.content ?? '{}') as { text?: unknown }).text ?? ''); } catch { return null; }
  } else if (message.message_type === 'post') {
    // Rich text: keep the plain text runs.
    try {
      const post = JSON.parse(message.content ?? '{}') as { title?: string; content?: { tag?: string; text?: string }[][] };
      text = [post.title, ...(post.content ?? []).map(line => line.filter(item => item.tag === 'text' || item.tag === 'a').map(item => item.text ?? '').join(''))].filter(Boolean).join('\n');
    } catch { return null; }
  } else return null;
  const mentions = message.mentions ?? [];
  for (const mention of mentions) if (mention.key) text = text.split(mention.key).join('');
  const group = message.chat_type !== 'p2p';
  return {
    channel: 'feishu', chatId: message.chat_id, senderId: sender.sender_id.open_id, messageId: body.header?.event_id || message.message_id,
    text: text.replace(/\s+/g, ' ').trim(), group,
    mentioned: !group || (!!botOpenId && mentions.some(mention => mention.id?.open_id === botOpenId)),
  };
}

export class FeishuChannel implements ImAdapter {
  readonly kind = 'feishu' as const;
  private socket: WebSocket | null = null;
  private generation = 0;
  private timers = new Set<NodeJS.Timeout>();
  private token: { value: string; expiresAt: number } | null = null;
  private botOpenId?: string;
  private fragments = new Map<string, { parts: (Uint8Array | undefined)[]; at: number }>();
  private state: FeishuStatus = { state: 'off' };
  constructor(private readonly options: { receive(message: ImInbound): void | Promise<void>; onStatus(): void; fetcher?: typeof fetch; domain?: string; WebSocketImpl?: typeof WebSocket }) {}

  status(): FeishuStatus { return this.state; }
  private set(state: FeishuStatus) { this.state = { ...state, since: new Date().toISOString() }; this.options.onStatus(); }
  private get domain() { return this.options.domain ?? DOMAIN; }
  private get fetcher() { return this.options.fetcher ?? fetch; }
  private credentials: FeishuCredentials | null = null;

  /** Connects with these credentials (reconnecting forever), or stops when null. */
  async configure(credentials: FeishuCredentials | null) {
    const generation = ++this.generation;
    this.stopSocket();
    this.credentials = credentials; this.token = null; this.botOpenId = undefined;
    if (!credentials) { this.set({ state: 'off' }); return; }
    this.set({ state: 'connecting' });
    void this.loop(generation, 0);
  }
  close() { this.generation++; this.stopSocket(); this.credentials = null; }

  private later(ms: number, fn: () => void) { const timer = setTimeout(() => { this.timers.delete(timer); fn(); }, ms); timer.unref?.(); this.timers.add(timer); }
  private stopSocket() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    const socket = this.socket; this.socket = null;
    if (socket) { socket.removeAllListeners(); socket.on('error', () => {}); try { socket.terminate(); } catch { /* already gone */ } }
  }

  private async loop(generation: number, attempt: number) {
    if (generation !== this.generation || !this.credentials) return;
    const retry = (error: string, fatal = false) => {
      if (generation !== this.generation) return;
      this.set({ state: 'error', error });
      if (!fatal) this.later(Math.min(60_000, 2000 * 2 ** Math.min(attempt, 5)), () => void this.loop(generation, attempt + 1));
    };
    let config: { url: string; serviceId: number; pingMs: number };
    try { config = await this.endpoint(); }
    catch (cause) { const error = cause as Error & { fatal?: boolean }; retry(error.message, error.fatal); return; }
    if (!this.botOpenId) this.botOpenId = await this.botInfo().catch(() => undefined);
    if (generation !== this.generation) return;
    const Impl = this.options.WebSocketImpl ?? WebSocket;
    const socket = new Impl(config.url);
    this.socket = socket;
    let opened = false;
    socket.on('open', () => {
      opened = true; attempt = 0;
      this.set({ state: 'connected', ...(this.state.botName ? { botName: this.state.botName } : {}) });
      const ping = () => {
        if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
        socket.send(encodeFrame({ SeqID: 0n, LogID: 0n, service: config.serviceId, method: FRAME_CONTROL, headers: [{ key: 'type', value: 'ping' }] }));
        this.later(config.pingMs, ping);
      };
      ping();
    });
    socket.on('message', (data: Buffer) => { if (this.socket === socket) void this.frame(socket, data, config); });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      retry(opened ? '飞书长连接已断开，正在重连' : '无法连接飞书长连接');
    });
  }

  private async endpoint(): Promise<{ url: string; serviceId: number; pingMs: number }> {
    const response = await this.fetcher(`${this.domain}/callback/ws/endpoint`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { 'content-type': 'application/json', locale: 'zh' }, body: JSON.stringify({ AppID: this.credentials!.appId, AppSecret: this.credentials!.appSecret }) })
      .catch(() => { throw new Error('无法连接飞书开放平台'); });
    const data = await response.json().catch(() => ({})) as { code?: number; msg?: string; data?: { URL?: string; ClientConfig?: { PingInterval?: number } } };
    if (data.code !== 0 || !data.data?.URL) {
      // 1 = system busy, 1000040343 = internal error: retry; anything else is configuration.
      const retryable = data.code === 1 || data.code === 1000040343 || response.status >= 500;
      throw Object.assign(new Error(`飞书拒绝了长连接：${clip(data.msg || `code ${data.code ?? response.status}`)}。请检查 App ID、App Secret，以及应用是否启用了「使用长连接接收事件」`), { fatal: !retryable });
    }
    const url = new URL(data.data.URL);
    return { url: data.data.URL, serviceId: Number(url.searchParams.get('service_id') ?? 0), pingMs: Math.max(10, data.data.ClientConfig?.PingInterval ?? 120) * 1000 };
  }

  private async frame(socket: WebSocket, data: Buffer, config: { pingMs: number }) {
    let frame: Frame;
    try { frame = decodeFrame(new Uint8Array(data)); } catch { return; }
    if (frame.method === FRAME_CONTROL) {
      if (header(frame, 'type') === 'pong' && frame.payload) {
        try { const pong = JSON.parse(new TextDecoder().decode(frame.payload)) as { PingInterval?: number }; if (pong.PingInterval) config.pingMs = Math.max(10, pong.PingInterval) * 1000; } catch { /* keep the current interval */ }
      }
      return;
    }
    if (frame.method !== FRAME_DATA || header(frame, 'type') !== 'event') return;
    const started = Date.now();
    const payload = this.merge(header(frame, 'message_id') ?? '', Number(header(frame, 'sum') ?? 1), Number(header(frame, 'seq') ?? 0), frame.payload ?? new Uint8Array());
    if (payload === undefined) return;
    let code = 200;
    try {
      const inbound = feishuInbound(JSON.parse(new TextDecoder().decode(payload)), this.botOpenId);
      if (inbound) await this.options.receive(inbound);
    } catch { code = 500; }
    // Without this ACK Feishu redelivers the event.
    if (socket.readyState === WebSocket.OPEN) socket.send(encodeFrame({ ...frame, headers: [...frame.headers, { key: 'biz_rt', value: String(Date.now() - started) }], payload: new TextEncoder().encode(JSON.stringify({ code })) }));
  }

  /** Large events arrive in `sum` fragments; returns the whole payload once complete. */
  private merge(id: string, sum: number, seq: number, part: Uint8Array): Uint8Array | undefined {
    if (!Number.isInteger(sum) || sum <= 1) return part;
    if (!Number.isInteger(seq) || seq < 0 || seq >= sum || sum > 100) return undefined;
    for (const [key, value] of this.fragments) if (Date.now() - value.at > 10_000) this.fragments.delete(key);
    const entry = this.fragments.get(id) ?? { parts: new Array<Uint8Array | undefined>(sum).fill(undefined), at: Date.now() };
    if (entry.parts.length !== sum) return undefined;
    entry.parts[seq] = part; this.fragments.set(id, entry);
    if (entry.parts.some(item => !item)) return undefined;
    this.fragments.delete(id);
    return Buffer.concat(entry.parts as Uint8Array[]);
  }

  private async tenantToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const response = await this.fetcher(`${this.domain}/open-apis/auth/v3/tenant_access_token/internal`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app_id: this.credentials?.appId, app_secret: this.credentials?.appSecret }) });
    const data = await response.json().catch(() => ({})) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
    if (data.code !== 0 || !data.tenant_access_token) throw new Error(`飞书凭证无效：${clip(data.msg ?? String(response.status))}`);
    this.token = { value: data.tenant_access_token, expiresAt: Date.now() + (data.expire ?? 7200) * 1000 };
    return this.token.value;
  }
  private async botInfo(): Promise<string | undefined> {
    const response = await this.fetcher(`${this.domain}/open-apis/bot/v3/info`, { redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${await this.tenantToken()}` } });
    const data = await response.json().catch(() => ({})) as { bot?: { open_id?: string; app_name?: string } };
    if (data.bot?.app_name) this.state = { ...this.state, botName: data.bot.app_name };
    return data.bot?.open_id;
  }

  async send(chatId: string, text: string): Promise<void> {
    if (!this.credentials) throw new Error('飞书未连接');
    const response = await this.fetcher(`${this.domain}/open-apis/im/v1/messages?receive_id_type=chat_id`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { 'content-type': 'application/json', authorization: `Bearer ${await this.tenantToken()}` }, body: JSON.stringify({ receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) }) });
    const data = await response.json().catch(() => ({})) as { code?: number; msg?: string };
    if (data.code !== 0) throw new Error(`飞书发送失败：${clip(data.msg ?? String(response.status))}`);
  }
}
