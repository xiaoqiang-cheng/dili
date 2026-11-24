import { randomBytes, randomUUID } from 'node:crypto';
import type { ImAdapter, ImInbound } from './hub.ts';

/** WeChat ClawBot (微信 ClawBot / iLink bot), spoken directly. The protocol
 * follows @tencent-weixin/openclaw-weixin 2.4.10 (MIT): QR login on
 * ilinkai.weixin.qq.com, a long-poll getupdates with a server cursor, and
 * sendmessage with the context_token of the user's last message. The person who
 * scans the QR code is the account owner and the only one Dili listens to. */
export interface WeixinAccount { token: string; botId: string; baseUrl: string; userId: string; cursor?: string }
export interface WeixinStatus {
  state: 'off' | 'login' | 'connecting' | 'connected' | 'paused' | 'error';
  error?: string;
  /** While logging in: the URL to show as a QR code, and what the phone reported. */
  qr?: string;
  login?: 'wait' | 'scaned' | 'need_verifycode' | 'expired';
  account?: string;
  since?: string;
}

const LOGIN_BASE = 'https://ilinkai.weixin.qq.com';
/** Protocol version of the official plugin this mirrors (iLink-App-ClientVersion). */
const PROTOCOL_VERSION = '2.4.10';
const CLIENT_VERSION = String((2 << 16) | (4 << 8) | 10);
const BOT_TYPE = '3';
const STALE_TOKEN = -14;
const clip = (text: string, max = 200) => text.length > max ? `${text.slice(0, max)}…` : text;

/** uint64 ids would lose precision in JSON.parse: quote them first. */
export function parseLossless<T>(raw: string): T {
  return JSON.parse(raw.replace(/("(?:message_id|msg_id|svr_id)"\s*:\s*)(-?\d+)/g, '$1"$2"')) as T;
}

type WeixinMessage = { message_id?: string; from_user_id?: string; message_type?: number; context_token?: string; group_id?: string; item_list?: { type?: number; text_item?: { text?: string }; voice_item?: { text?: string } }[] };
/** A user's text (or voice transcript) message, or null for anything else. */
export function weixinInbound(message: WeixinMessage): ImInbound | null {
  if (message.message_type !== 1 || !message.from_user_id) return null;
  const text = (message.item_list ?? []).map(item => item.type === 1 ? item.text_item?.text ?? '' : item.type === 3 ? item.voice_item?.text ?? '' : '').filter(Boolean).join('\n').trim();
  if (!text) return null;
  return { channel: 'weixin', chatId: message.from_user_id, senderId: message.from_user_id, messageId: message.message_id || randomUUID(), text, replyContext: message.context_token, ...(message.group_id ? { group: true, mentioned: true } : {}) };
}

export class WeixinChannel implements ImAdapter {
  readonly kind = 'weixin' as const;
  private account: WeixinAccount | null = null;
  private generation = 0;
  private abort: AbortController | null = null;
  private state: WeixinStatus = { state: 'off' };
  private login: { qrcode: string; base: string; verifyCode?: string; refreshes: number } | null = null;
  constructor(private readonly options: {
    receive(message: ImInbound): void | Promise<void>;
    /** Persist the logged-in account (and its cursor); null after logout. */
    save(account: WeixinAccount | null): void;
    /** The scanner is the owner: called once a login is confirmed. */
    loggedIn(userId: string): void;
    onStatus(): void;
    botAgent: string;
    fetcher?: typeof fetch;
  }) {}

  status(): WeixinStatus { return this.state; }
  private set(state: WeixinStatus) { this.state = { ...state, since: new Date().toISOString() }; this.options.onStatus(); }
  private get fetcher() { return this.options.fetcher ?? fetch; }

  private headers(token?: string): Record<string, string> {
    return {
      'content-type': 'application/json', AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64'),
      'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': CLIENT_VERSION,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
  }
  private baseInfo() { return { channel_version: PROTOCOL_VERSION, bot_agent: this.options.botAgent }; }
  private async post<T>(base: string, path: string, body: unknown, options: { token?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    const signals = [AbortSignal.timeout(options.timeoutMs ?? 15_000), ...(options.signal ? [options.signal] : [])];
    const response = await this.fetcher(new URL(path, `${base.replace(/\/+$/, '')}/`), { method: 'POST', redirect: 'error', signal: AbortSignal.any(signals), headers: this.headers(options.token), body: JSON.stringify(body) });
    const raw = await response.text();
    if (!response.ok) throw new Error(`微信接口返回 ${response.status}：${clip(raw)}`);
    return parseLossless<T>(raw);
  }

  /** Resumes a saved account, or stays off. */
  resume(account: WeixinAccount | null) {
    this.stop();
    this.account = account;
    if (account) this.monitor(++this.generation); else this.set({ state: 'off' });
  }

  /** Starts a QR login; the status carries the QR URL until the phone confirms. */
  async startLogin() {
    this.stop();
    const generation = ++this.generation;
    const qr = await this.post<{ qrcode?: string; qrcode_img_content?: string }>(LOGIN_BASE, `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`, { local_token_list: this.account ? [this.account.token] : [] });
    if (!qr.qrcode || !qr.qrcode_img_content) throw new Error('微信没有返回登录二维码，请稍后重试');
    this.login = { qrcode: qr.qrcode, base: LOGIN_BASE, refreshes: 0 };
    this.set({ state: 'login', qr: qr.qrcode_img_content, login: 'wait' });
    void this.pollLogin(generation);
  }
  /** The phone shows a number to type in when the login needs confirmation. */
  submitVerifyCode(code: string) {
    if (!this.login || !/^\d{1,12}$/.test(code)) throw new Error('请输入手机上显示的数字');
    this.login.verifyCode = code;
  }
  cancelLogin() { if (this.login) { this.stop(); this.login = null; this.resume(this.account); } }

  private async pollLogin(generation: number) {
    const deadline = Date.now() + 8 * 60_000;
    while (generation === this.generation && this.login && Date.now() < deadline) {
      const login = this.login;
      let status: { status?: string; bot_token?: string; ilink_bot_id?: string; baseurl?: string; ilink_user_id?: string; redirect_host?: string };
      try {
        const path = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(login.qrcode)}${login.verifyCode ? `&verify_code=${encodeURIComponent(login.verifyCode)}` : ''}`;
        const response = await this.fetcher(new URL(path, `${login.base}/`), { redirect: 'error', signal: AbortSignal.timeout(35_000), headers: { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': CLIENT_VERSION } });
        status = response.ok ? await response.json() as typeof status : { status: 'wait' };
      } catch { status = { status: 'wait' }; }
      if (generation !== this.generation) return;
      switch (status.status) {
        case 'scaned': login.verifyCode = undefined; this.set({ ...this.state, login: 'scaned' }); break;
        case 'need_verifycode':
          if (this.state.login !== 'need_verifycode' || login.verifyCode) { login.verifyCode = undefined; this.set({ ...this.state, login: 'need_verifycode', ...(this.state.login === 'need_verifycode' ? { error: '数字不匹配，请重新输入' } : {}) }); }
          break;
        case 'scaned_but_redirect': if (status.redirect_host && /^[\w.-]+$/.test(status.redirect_host)) login.base = `https://${status.redirect_host}`; break;
        case 'expired': case 'verify_code_blocked':
          if (++login.refreshes > 3) { this.login = null; this.set({ state: 'error', error: '二维码多次失效，请重新登录' }); return; }
          try {
            const qr = await this.post<{ qrcode?: string; qrcode_img_content?: string }>(LOGIN_BASE, `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`, { local_token_list: [] });
            if (!qr.qrcode || !qr.qrcode_img_content) throw new Error('no qr');
            login.qrcode = qr.qrcode; login.base = LOGIN_BASE; login.verifyCode = undefined;
            this.set({ state: 'login', qr: qr.qrcode_img_content, login: 'wait', error: status.status === 'expired' ? '二维码已过期，已刷新' : '多次输入错误，已刷新二维码' });
          } catch { this.login = null; this.set({ state: 'error', error: '刷新二维码失败，请重新登录' }); return; }
          break;
        case 'binded_redirect':
          this.login = null;
          if (this.account) { this.resume(this.account); return; }
          this.set({ state: 'error', error: '这个微信 ClawBot 已连接到其他客户端。请先在那边断开，再重新扫码。' }); return;
        case 'confirmed': {
          this.login = null;
          if (!status.bot_token || !status.ilink_bot_id || !status.ilink_user_id) { this.set({ state: 'error', error: '登录失败：微信没有返回完整的账号信息' }); return; }
          const account: WeixinAccount = { token: status.bot_token, botId: status.ilink_bot_id, userId: status.ilink_user_id, baseUrl: status.baseurl && /^https:\/\/[\w.-]+\/?$/.test(status.baseurl) ? status.baseurl : LOGIN_BASE };
          this.options.save(account);
          this.options.loggedIn(account.userId);
          this.resume(account);
          return;
        }
        default: break;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (generation === this.generation && this.login) { this.login = null; this.set({ state: 'error', error: '登录超时，请重新扫码' }); }
  }

  private monitor(generation: number) {
    const account = this.account!;
    const abort = new AbortController(); this.abort = abort;
    this.set({ state: 'connecting', account: account.botId });
    void this.post(account.baseUrl, 'ilink/bot/msg/notifystart', { base_info: this.baseInfo() }, { token: account.token, timeoutMs: 10_000 }).catch(() => undefined);
    void (async () => {
      let failures = 0, timeoutMs = 35_000;
      while (generation === this.generation && !abort.signal.aborted) {
        try {
          type Updates = { ret?: number; errcode?: number; errmsg?: string; msgs?: WeixinMessage[]; get_updates_buf?: string; longpolling_timeout_ms?: number };
          // The server holds the request until messages arrive; a client timeout is an empty poll.
          const response = await this.post<Updates>(account.baseUrl, 'ilink/bot/getupdates', { get_updates_buf: account.cursor ?? '', base_info: this.baseInfo() }, { token: account.token, timeoutMs: timeoutMs + 5000, signal: abort.signal })
            .catch((cause): Updates => { if ((cause as Error).name === 'TimeoutError') return { ret: 0, msgs: [] }; throw cause; });
          if (generation !== this.generation) return;
          if (response.longpolling_timeout_ms && response.longpolling_timeout_ms > 0) timeoutMs = Math.min(response.longpolling_timeout_ms, 120_000);
          if (response.ret === STALE_TOKEN || response.errcode === STALE_TOKEN) {
            this.set({ state: 'paused', account: account.botId, error: '微信登录已失效，请重新扫码登录' });
            return;
          }
          if ((response.ret ?? 0) !== 0 || (response.errcode ?? 0) !== 0) throw new Error(`微信接口错误 ${response.errcode ?? response.ret}：${clip(response.errmsg ?? '')}`);
          failures = 0;
          if (this.state.state !== 'connected') this.set({ state: 'connected', account: account.botId });
          if (response.get_updates_buf) { account.cursor = response.get_updates_buf; this.options.save(account); }
          for (const message of response.msgs ?? []) {
            const inbound = weixinInbound(message);
            if (inbound) await Promise.resolve(this.options.receive(inbound)).catch(() => undefined);
          }
        } catch (cause) {
          if (abort.signal.aborted || generation !== this.generation) return;
          failures++;
          this.set({ state: 'error', account: account.botId, error: cause instanceof Error ? clip(cause.message) : '微信连接失败，正在重试' });
          await new Promise(resolve => setTimeout(resolve, failures >= 3 ? 30_000 : 2000));
          if (failures >= 3) failures = 0;
        }
      }
    })();
  }

  stop() {
    this.generation++;
    this.abort?.abort(); this.abort = null;
  }
  /** Logs out locally: stops polling and forgets the token. */
  logout() {
    const account = this.account;
    this.stop(); this.login = null; this.account = null;
    if (account) void this.post(account.baseUrl, 'ilink/bot/msg/notifystop', { base_info: this.baseInfo() }, { token: account.token, timeoutMs: 5000 }).catch(() => undefined);
    this.options.save(null);
    this.set({ state: 'off' });
  }

  async send(chatId: string, text: string, replyContext?: unknown): Promise<void> {
    const account = this.account;
    if (!account) throw new Error('微信未登录');
    const response = await this.post<{ ret?: number; errmsg?: string }>(account.baseUrl, 'ilink/bot/sendmessage', {
      msg: { from_user_id: '', to_user_id: chatId, client_id: `dili-${randomUUID()}`, message_type: 2, message_state: 2, item_list: [{ type: 1, text_item: { text } }], ...(typeof replyContext === 'string' && replyContext ? { context_token: replyContext } : {}) },
      base_info: this.baseInfo(),
    }, { token: account.token });
    if (response.ret && response.ret !== 0) throw new Error(`微信发送失败：${clip(response.errmsg ?? String(response.ret))}`);
  }
}
