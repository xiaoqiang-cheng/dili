import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import { findExecutable, validateNativeId } from './adapters.js';
import type { SessionStatus } from '../shared/types.js';
import { OwnedProcess } from './owned-process.ts';
import { sameDirectory } from './paths.ts';
import { DeliveryNotAcceptedError } from './delivery.ts';
import type { DshHistory } from './conversation.ts';

export interface DshBridgeOptions {
  port?: number;
  dataDir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Tests can exercise the real HTTP contract against a fixture server. */
  manageProcess?: boolean;
  /** Total readiness budget, including every HTTP probe and response body. */
  startupTimeoutMs?: number;
}
interface NativeSession { nativeSessionId: string; nativeUrl: string }
interface DshSummary { sessionId: string; running?: boolean; agentAvailable?: boolean; cwd?: string; updatedAt?: number }
export interface DshStatus { status: SessionStatus; detail?: string; attentionKey?: string }
interface TurnBoundary { type: 'turn/start' | 'turn/end'; seq: number; reason?: string }
class DshCompatibilityError extends Error {}

/** Read-only invocation identity. A page returning 200 is not proof that the
 * process we spawned owns the port (another service may win the bind race). */
function dshHostPlugin(token: string): string {
  return `import {writeFileSync} from 'node:fs';
export default function sessiondeckLink(ctx){
ctx.inject(['connection'],function(ctx){if(typeof ctx.connection.authenticatedUrl==='function')writeFileSync(process.env.SESSIONDECK_DSH_AUTH_FILE,ctx.connection.authenticatedUrl(process.env.SESSIONDECK_DSH_BASE_URL),{mode:0o600});});
ctx.inject(['webServer'],function(ctx){ctx.effect(function(){return ctx.webServer.register({kind:'exact',path:'/sessiondeck/instance',handler:function(req,res){res.setHeader('content-type','text/plain');res.setHeader('cache-control','no-store');res.end(${JSON.stringify(token)});}});});});}\n`;
}

async function prepareLaunch(dataDir: string, token: string): Promise<{ directory: string; loaderPath: string; patchPath: string }> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  // A cancelled boot may still have an outstanding filesystem write. Each
  // launch gets its own files so it cannot corrupt a replacement's plugin.
  const directory = await mkdtemp(join(dataDir, 'dsh-launch-'));
  try {
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'dsh-sessiondeck-link', version: '1.0.0', type: 'module', main: 'index.js', exports: { '.': './index.js', './client': './client.js', './package.json': './package.json' }, dsh: { client: { inject: ['sessions'], platform: 'web' } } }, null, 2), { mode: 0o600 });
    await writeFile(join(directory, 'index.js'), dshHostPlugin(token), { mode: 0o600 });
    await writeFile(join(directory, 'client.js'), dshDeepLinkClient('dsh-sessiondeck-link'), { mode: 0o600 });
    const loaderPath = join(directory, 'loader.mjs');
    const moduleUrls = { 'dsh-sessiondeck-link': pathToFileURL(join(directory, 'index.js')).href, 'dsh-sessiondeck-link/package.json': pathToFileURL(join(directory, 'package.json')).href };
    await writeFile(loaderPath, `import { registerHooks } from 'node:module';\nconst urls=${JSON.stringify(moduleUrls)};\nregisterHooks({resolve(specifier,context,next){return Object.hasOwn(urls,specifier)?{url:urls[specifier],shortCircuit:true}:next(specifier,context);}});\n`, { mode: 0o600 });
    const patchPath = join(directory, 'patch.yml');
    // JSON is a YAML subset; the overlay adds only this invocation's plugin.
    // A file URL also lets 0.2's request inventory find its owning manifest;
    // a synthetic bare name resolves through hooks but not packageOf().
    await writeFile(patchPath, JSON.stringify([{ insert: [{ id: 'sessiondeck-link', name: pathToFileURL(join(directory, 'index.js')).href }] }]), { mode: 0o600 });
    return { directory, loaderPath, patchPath };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** The original UI provides a public sessions.open() service but no URL routing.
 * This invocation-only client plugin adds a deep link without copying any UI. */
export function dshDeepLinkClient(moduleId: string): string {
  return `window.__ModuleLoader__.load({id:${JSON.stringify(moduleId)},factory:function(){return {inject:['sessions'],apply:function(ctx){
    const target=new URLSearchParams(location.search).get('sessiondeckSession')||new URLSearchParams((location.hash||'').slice(1)).get('sessiondeckSession');
    if(!target || !/^(?:session-)?[a-f\\d]{8}-[a-f\\d]{4}-[a-f\\d]{4}-[a-f\\d]{4}-[a-f\\d]{12}$/i.test(target))return;
    let opened=false;
    const tryOpen=function(){if(opened)return;const state=ctx.sessions.list.getSnapshot();if(state.byId && state.byId[target]){opened=true;ctx.sessions.open(target);}};
    ctx.effect(function(){const unsubscribe=ctx.sessions.list.subscribe(tryOpen);tryOpen();return unsubscribe;});
  }}}});`;
}

export class DshBridge {
  private url: string;
  get baseUrl(): string { return this.url; }
  /** No configured port: pick a free one at each boot. A fixed default (4318)
   * collided with the remote-access listener, which also defaults to Web port + 1. */
  private readonly dynamicPort: boolean;
  private process: ChildProcess | null = null;
  private owners = new WeakMap<ChildProcess, OwnedProcess>();
  private starting: Promise<void> | null = null;
  private bootAbort: AbortController | null = null;
  private bootGeneration = 0;
  private ready = false;
  private modern = false;
  private cookie = '';
  private authenticatedUrl = '';
  private followed = new Map<string, string>();
  private synchronized = new Set<string>();
  private closed = false;
  private retiring: Promise<void> = Promise.resolve();
  private cleanups = new Set<Promise<void>>();
  private requests = new Set<AbortController>();
  private streams: WebSocket[] = [];
  private streamGeneration = 0;
  private streamReady = false;
  private muxSynchronized = false;
  private pending = new Map<string, Map<string, 'waiting_approval' | 'waiting_input'>>();
  private observedRunning = new Map<string, boolean>();
  private boundaries = new Map<string, TurnBoundary>();
  private historyFresh = new Set<string>();
  private revisions = new Map<string, number>();
  private completed = new Map<string, string>();
  private failed = new Map<string, string>();
  private statusListeners = new Set<() => void>();
  onStatusChange(listener: () => void) { this.statusListeners.add(listener); return () => { this.statusListeners.delete(listener); }; }
  private options: DshBridgeOptions;
  constructor(options: DshBridgeOptions = {}) {
    const configured = options.port ?? (process.env.SESSIONDECK_DSH_PORT ? Number(process.env.SESSIONDECK_DSH_PORT) : undefined);
    this.dynamicPort = configured === undefined;
    const port = configured ?? 0;
    if (!this.dynamicPort && (!Number.isInteger(port) || port < 1024 || port > 65535)) throw new Error('无效的 DSH 端口');
    if (options.startupTimeoutMs !== undefined && (!Number.isSafeInteger(options.startupTimeoutMs) || options.startupTimeoutMs <= 0)) throw new Error('无效的 DSH 启动超时');
    this.url = `http://127.0.0.1:${port}`;
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('DeepSeek Harness 桥接服务正在关闭');
    if (this.ready) return;
    if (this.starting) return this.starting;
    const generation = ++this.bootGeneration;
    const pending = this.boot(generation).finally(() => {
      if (this.starting === pending) this.starting = null;
      // boot() has an inner finally once a child exists. Earlier failures
      // (missing executable, occupied port, filesystem setup) need the same
      // abort-controller cleanup, but an older cancelled generation must not
      // clear a replacement's controller.
      if (this.bootGeneration === generation && !this.ready) this.bootAbort = null;
    });
    this.starting = pending;
    return pending;
  }

  private async boot(generation: number): Promise<void> {
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 20_000);
    const abort = new AbortController();
    this.bootAbort = abort;
    const timedOut = () => new Error('DeepSeek Harness 启动超时，请检查 dsh web 是否能正常运行');
    const assertActive = () => {
      if (this.bootGeneration !== generation) throw new Error('DeepSeek Harness 启动已取消');
      if (Date.now() >= deadline) throw timedOut();
    };
    const probeSignal = () => {
      assertActive();
      return AbortSignal.any([abort.signal, AbortSignal.timeout(Math.max(1, Math.min(500, deadline - Date.now())))]);
    };
    await this.retiring;
    assertActive();
    if (this.options.manageProcess === false) { this.ready = true; return; }
    const file = await findExecutable('dsh');
    assertActive();
    if (!file) throw new Error('未找到 dsh 命令，请安装 DeepSeek Harness');
    if (this.dynamicPort) {
      const free = await new Promise<number>((resolvePort, reject) => {
        const probe = createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => { const address = probe.address(); probe.close(() => resolvePort(address && typeof address === 'object' ? address.port : 0)); });
      });
      assertActive();
      this.url = `http://127.0.0.1:${free}`;
    }
    const port = Number(new URL(this.baseUrl).port);
    await new Promise<void>((resolveCheck, reject) => {
      const probe = createServer();
      probe.once('error', () => reject(new Error(`DSH 端口 ${port} 已被占用，请设置 SESSIONDECK_DSH_PORT 为其他端口`)));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolveCheck()));
    });
    assertActive();
    const dataDir = resolve(this.options.dataDir ?? process.env.SESSIONDECK_DATA_DIR ?? join(homedir(), '.sessiondeck'));
    const launchToken = randomUUID();
    const { directory, loaderPath, patchPath } = await prepareLaunch(dataDir, launchToken);
    try { assertActive(); }
    catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
    const baseEnv = this.options.env ?? process.env;
    const authFile = join(directory, 'auth-url');
    this.modern = false; this.cookie = ''; this.authenticatedUrl = '';
    const env = { ...baseEnv, SESSIONDECK_DSH_LAUNCH_TOKEN: launchToken, SESSIONDECK_DSH_AUTH_FILE: authFile, SESSIONDECK_DSH_BASE_URL: this.baseUrl, NODE_OPTIONS: `${baseEnv.NODE_OPTIONS ?? ''} --import ${JSON.stringify(pathToFileURL(loaderPath).href)}`.trim() };
    const child = spawn(file, ['--profile', 'web', '--patch', patchPath, '--host', '127.0.0.1', '--port', String(port), '--no-open'], { cwd: this.options.cwd ?? process.cwd(), env, stdio: ['ignore', 'ignore', 'pipe'] });
    const closed = new Promise<void>(accept => child.once('close', () => accept()));
    const cleaned = closed.then(() => rm(directory, { recursive: true, force: true }));
    this.cleanups.add(cleaned);
    void cleaned.then(() => this.cleanups.delete(cleaned), () => this.cleanups.delete(cleaned));
    this.owners.set(child, new OwnedProcess(child.pid ?? 0, cleaned, signal => { child.kill(signal); }));
    // Keep cleanup covered even when the native process exits on its own.
    void cleaned.catch(() => undefined);
    this.process = child;
    let failure: Error | null = null;
    child.stderr?.resume();
    child.once('error', error => { failure = error; });
    child.once('exit', code => {
      failure = new Error(`DeepSeek Harness 已退出（${code ?? 'signal'}）`);
      if (this.process !== child) return;
      this.ready = false; this.process = null; this.closeStreams();
      this.clearStatus(); this.abortRequests();
      this.cookie = ''; this.authenticatedUrl = ''; this.modern = false;
    });
    try {
      while (Date.now() < deadline) {
        assertActive();
        if (failure) throw failure;
        try {
          const response = await fetch(`${this.baseUrl}/sessiondeck/instance`, { signal: probeSignal(), redirect: 'error' });
          const token = response.ok ? await response.text() : '';
          assertActive();
          if (failure) throw failure;
          if (token === launchToken) {
            const authUrl = await readFile(authFile, 'utf8').catch(() => '');
            assertActive();
            if (authUrl && !this.cookie) {
              const url = new URL(authUrl);
              if (url.origin !== this.baseUrl || url.pathname !== '/' || !url.searchParams.get('token')) throw new DshCompatibilityError('DeepSeek Harness 返回了无效的本地认证地址');
              const exchange = await fetch(url, { signal: probeSignal(), redirect: 'manual' });
              assertActive();
              if (exchange.status !== 303) throw new DshCompatibilityError('DeepSeek Harness 本地认证失败');
              this.cookie = exchange.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
              if (!this.cookie) throw new DshCompatibilityError('DeepSeek Harness 未返回本地认证凭据');
              this.modern = true; this.authenticatedUrl = url.href;
            }
            // The plugin route can become available before the native API has
            // finished mounting. Probe a read-only native method as well.
            const rpcId = randomUUID();
            const method = this.modern ? 'session/list' : 'session.list';
            const api = await fetch(`${this.baseUrl}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: this.baseUrl, ...(this.cookie ? { cookie: this.cookie } : {}) }, body: JSON.stringify({ type: 'client-request', rpcId, method, payload: this.modern ? { args: { _request: {} } } : {} }), signal: probeSignal(), redirect: 'error' });
            if (api.status === 401 || api.status === 403) throw new DshCompatibilityError(`DeepSeek Harness 原生 API 拒绝桥接访问（HTTP ${api.status}）。请检查原生认证与桥接版本兼容性；这不是模型服务超时。`);
            if (api.ok) {
              const result = await api.json() as { type?: string; rpcId?: string; result?: { ok?: boolean; value?: { items?: unknown } } };
              assertActive();
              if (!failure && result.type === 'server-response' && result.rpcId === rpcId && result.result?.ok === true && Array.isArray(result.result.value?.items)) { this.ready = true; this.connectEvents(); return; }
            }
          }
        } catch (error) {
          if (error instanceof DshCompatibilityError) throw error;
          /* boot not yet bound */
        }
        assertActive();
        await delay(Math.min(200, deadline - Date.now()), undefined, { signal: abort.signal });
      }
      throw timedOut();
    } catch (error) {
      const failure = this.bootGeneration !== generation ? new Error('DeepSeek Harness 启动已取消') : Date.now() >= deadline ? timedOut() : error;
      if (this.process === child) this.process = null;
      // Failed start is not complete until its owned process and invocation
      // files are gone. The bounded process grace period remains under the
      // browser's 30s request timeout after the default 20s readiness budget.
      await this.retire(child);
      throw failure;
    } finally {
      if (this.bootAbort === abort) this.bootAbort = null;
    }
  }

  async stop(): Promise<void> {
    const starting = this.starting;
    this.bootGeneration++;
    this.bootAbort?.abort();
    this.bootAbort = null;
    this.starting = null;
    this.closeStreams();
    this.clearStatus(); this.abortRequests();
    this.cookie = ''; this.authenticatedUrl = ''; this.modern = false;
    if (this.process) this.retire(this.process);
    this.process = null;
    this.ready = false;
    await starting?.catch(() => undefined);
    await this.retiring;
    await Promise.all([...this.cleanups]);
  }

  async close(): Promise<void> { this.closed = true; await this.stop(); }

  private clearStatus(): void {
    this.observedRunning.clear(); this.completed.clear(); this.failed.clear();
    this.boundaries.clear(); this.historyFresh.clear(); this.revisions.clear();
  }

  private abortRequests(): void { for (const request of this.requests) request.abort(); }

  private retire(child: ChildProcess): Promise<void> {
    const retiring = this.owners.get(child)?.stop() ?? Promise.resolve();
    this.retiring = Promise.all([this.retiring, retiring]).then(() => undefined);
    void this.retiring.catch(() => undefined);
    return retiring;
  }

  private closeStreams(): void {
    this.streamGeneration++;
    this.streams.forEach(socket => socket.terminate());
    this.streams = [];
    this.pending.clear();
    this.streamReady = false;
    this.muxSynchronized = false;
    this.followed.clear(); this.synchronized.clear();
  }

  private connectEvents(): void {
    if (this.modern) { this.connectModernEvents(); return; }
    const generation = ++this.streamGeneration;
    this.pending.clear();
    this.historyFresh.clear();
    this.streamReady = false;
    this.muxSynchronized = false;
    let opened = 0;
    let reconnecting = false;
    this.streams = ['events.mux', 'events.host'].map(method => {
      const socket = new WebSocket(`${this.baseUrl.replace('http:', 'ws:')}/api/${method}`, { origin: this.baseUrl, handshakeTimeout: 5000, maxPayload: 16 * 1024 * 1024 });
      socket.on('open', () => { if (generation === this.streamGeneration && ++opened === 2) this.streamReady = true; });
      socket.on('message', data => {
        if (generation !== this.streamGeneration || reconnecting) return;
        try {
          const envelope = JSON.parse(data.toString());
          const frame = envelope.payload;
          if (frame?.type === 'stream/error') { reconnect(); return; }
          if (envelope.type !== 'server-request' || !frame || typeof frame.sessionId !== 'string') return;
          validateNativeId('dsh', frame.sessionId);
          const requests = this.pending.get(frame.sessionId) ?? new Map<string, 'waiting_approval' | 'waiting_input'>();
          if (frame.type === 'approval/requested' && typeof frame.approvalId === 'string') requests.set(`approval:${frame.approvalId}`, 'waiting_approval');
          else if (frame.type === 'question/requested' && typeof envelope.rpcId === 'string') requests.set(`question:${envelope.rpcId}`, 'waiting_input');
          else if (frame.type === 'approval/resolved' && typeof frame.approvalId === 'string') { requests.delete(`approval:${frame.approvalId}`); if (method === 'events.mux') this.muxSynchronized = true; }
          else if (frame.type === 'question/resolved' && typeof frame.questionRpcId === 'string') { requests.delete(`question:${frame.questionRpcId}`); if (method === 'events.mux') this.muxSynchronized = true; }
          else if (frame.type === 'session/event' && method === 'events.mux' && frame.event && Number.isSafeInteger(frame.event.seq) && frame.event.seq >= 0) {
            // Live events follow the entire pending-request replay in this FIFO.
            // Socket open (and WS pong) alone cannot certify that baseline.
            this.muxSynchronized = true;
            this.observeBoundary(frame.sessionId, frame.event);
            if (frame.event.type === 'turn/end' && this.boundaries.get(frame.sessionId)?.seq === frame.event.seq) requests.clear();
          }
          else if (frame.type === 'host/agent-error' && typeof envelope.rpcId === 'string') this.failed.set(frame.sessionId, `dsh:error:${frame.sessionId}:${envelope.rpcId}`);
          else if (frame.type === 'host/session-status' && typeof frame.running === 'boolean') {
            this.observeRunning(frame.sessionId, frame.running);
          }
          this.pending.set(frame.sessionId, requests);
          if (['approval/requested', 'approval/resolved', 'question/requested', 'question/resolved', 'host/agent-error', 'host/session-status'].includes(frame.type)
            || (frame.type === 'session/event' && ['turn/start', 'turn/end'].includes(frame.event?.type))) {
            this.revisions.set(frame.sessionId, (this.revisions.get(frame.sessionId) ?? 0) + 1);
            for (const listener of this.statusListeners) listener();
          }
        } catch { /* unsupported stream frame never fabricates status */ }
      });
      const reconnect = () => {
        if (generation !== this.streamGeneration || reconnecting) return;
        reconnecting = true;
        this.streamReady = false;
        this.muxSynchronized = false;
        this.pending.clear();
        this.streams.forEach(stream => stream.terminate());
        const timer = setTimeout(() => { if (this.ready && generation === this.streamGeneration) this.connectEvents(); }, 2000);
        timer.unref();
      };
      socket.on('error', reconnect);
      socket.on('close', reconnect);
      return socket;
    });
  }

  /** 0.2 multiplexes named Remote streams on one authenticated socket. Only
   * already attached agents are followed: following a cold session activates it. */
  private connectModernEvents(): void {
    const generation = ++this.streamGeneration;
    this.followed.clear(); this.synchronized.clear(); this.pending.clear();
    this.historyFresh.clear(); this.streamReady = false; this.muxSynchronized = false;
    const socket = new WebSocket(`${this.baseUrl.replace('http:', 'ws:')}/api/remote.mux`, { origin: this.baseUrl, headers: { cookie: this.cookie }, handshakeTimeout: 5000, maxPayload: 16 * 1024 * 1024 });
    this.streams = [socket];
    let reconnecting = false;
    const reconnect = () => {
      if (generation !== this.streamGeneration || reconnecting) return;
      reconnecting = true; this.streamReady = false; this.muxSynchronized = false;
      this.pending.clear(); this.followed.clear(); this.synchronized.clear(); socket.terminate();
      const timer = setTimeout(() => { if (this.ready && generation === this.streamGeneration) this.connectModernEvents(); }, 2000);
      timer.unref();
    };
    socket.on('open', () => socket.send(JSON.stringify({ type: 'open', streamId: 'control', endpoint: 'session/control', payload: { args: {} } })));
    socket.on('message', raw => {
      if (generation !== this.streamGeneration || reconnecting) return;
      try {
        const message = JSON.parse(raw.toString());
        if (message.type !== 'item') { if (['error', 'end'].includes(message.type)) reconnect(); return; }
        const frame = message.value;
        if (message.streamId === 'control') {
          if (frame?.type === 'baseline') {
            this.streamReady = true; this.muxSynchronized = true;
            for (const [id, block] of Object.entries(frame.value?.projections ?? {})) this.observeQuestions(id, (block as { values?: { questions?: unknown } }).values?.questions);
          } else if (frame?.type === 'projection' && frame.key === 'questions') this.observeQuestions(frame.sessionId, frame.value);
        } else {
          const id = this.followed.get(message.streamId);
          if (!id) return;
          if (frame?.type === 'snapshot') {
            this.pending.delete(id);
            for (const record of frame.records ?? []) if (record.type === 'event') this.observeModernEvent(id, record.event);
            this.observeQuestions(id, frame.projections?.values?.questions);
            this.synchronized.add(id);
          } else if (frame?.type === 'event') this.observeModernEvent(id, frame.event);
        }
        for (const listener of this.statusListeners) listener();
      } catch { /* Unsupported frames never manufacture status. */ }
    });
    socket.on('error', reconnect); socket.on('close', reconnect);
  }

  private observeQuestions(id: string, value: unknown): void {
    if (!value || typeof value !== 'object' || !Array.isArray((value as { active?: unknown }).active)) return;
    const requests = this.pending.get(id) ?? new Map<string, 'waiting_approval' | 'waiting_input'>();
    for (const key of requests.keys()) if (key.startsWith('question:')) requests.delete(key);
    for (const question of (value as { active: { callId?: unknown }[] }).active) if (typeof question.callId === 'string') requests.set(`question:${question.callId}`, 'waiting_input');
    this.pending.set(id, requests);
  }

  private observeModernEvent(id: string, event: { type?: string; data?: { id?: string }; seq?: number }): void {
    this.observeBoundary(id, event);
    const requests = this.pending.get(id) ?? new Map<string, 'waiting_approval' | 'waiting_input'>();
    if (event.type === 'approval/asked' && event.data?.id) requests.set(`approval:${event.data.id}`, 'waiting_approval');
    if (event.type === 'approval/decided' && event.data?.id) requests.delete(`approval:${event.data.id}`);
    if (event.type === 'turn/end') requests.clear();
    this.pending.set(id, requests);
  }

  private followAttached(id: string): void {
    const socket = this.streams[0];
    if (!this.modern || socket?.readyState !== WebSocket.OPEN || [...this.followed.values()].includes(id)) return;
    const streamId = randomUUID(); this.followed.set(streamId, id);
    socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: id }, maxMessages: 1 } } } }));
  }

  private async rpc<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    if (!this.ready) throw new Error('DeepSeek Harness 原生服务尚未启动');
    if (this.modern && method === 'session.history') {
      const projection = await this.rpc<{ asOfSeq: number } | null>('session.projections', { sessionId: payload.sessionId });
      if (!projection) throw new Error('DeepSeek Harness 未返回会话历史游标');
      const page = await this.rpc<{ records: { type: string; event?: unknown }[]; hasMore: boolean }>('session.page', { address: { kind: 'session', sessionId: payload.sessionId }, throughSeq: projection.asOfSeq, maxMessages: payload.maxMessages });
      return { events: page.records.filter(record => record.type === 'event'), hasMore: page.hasMore } as T;
    }
    const generation = this.bootGeneration;
    const abort = new AbortController();
    this.requests.add(abort);
    const rpcId = randomUUID();
    try {
      const endpoint = this.modern ? method.replace('.', '/') : method;
      const args = method === 'commands.execute' ? { agentId: payload.agentId, line: payload.line, submittedAttachments: payload.submittedAttachments } : { [method === 'session.list' ? '_request' : 'request']: payload };
      const response = await fetch(`${this.baseUrl}/api/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: this.baseUrl, ...(this.cookie ? { cookie: this.cookie } : {}) }, body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: this.modern ? { args } : payload }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]), redirect: 'error' });
      if (!response.ok) throw new Error(`DeepSeek Harness API 请求失败（HTTP ${response.status}）`);
      const chunks: Uint8Array[] = []; let length = 0;
      if (!response.body) throw new Error('DeepSeek Harness 返回了空响应');
      const reader = response.body.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.length;
          if (length > 16 * 1024 * 1024) { await reader.cancel(); throw new Error('DeepSeek Harness API 响应超过大小限制'); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { type?: string; rpcId?: string; result?: { ok?: boolean; value?: T; error?: { message?: string; code?: string } } };
      if (generation !== this.bootGeneration || !this.ready) throw new Error('DeepSeek Harness 请求所属服务已停止');
      if (result.type !== 'server-response') throw new Error('DeepSeek Harness 返回了无效的响应类型');
      if (result.rpcId !== rpcId) throw new Error('DeepSeek Harness 返回了不匹配的请求 ID');
      if (result.result?.ok === false) {
        const message = `DeepSeek Harness：${result.result.error?.message ?? result.result.error?.code ?? '原生接口拒绝了请求'}`;
        // Generic native errors may occur after queue acceptance. Only a
        // documented pre-dispatch missing-session rejection permits retry.
        if (method === 'session.prompt' && ['session-not-found', 'session/not-found'].includes(result.result.error?.code ?? '')) throw new DeliveryNotAcceptedError(message);
        throw new Error(message);
      }
      if (result.result?.ok !== true) throw new Error('DeepSeek Harness 返回了无效的 API 响应');
      return result.result.value as T;
    } finally { this.requests.delete(abort); }
  }

  private reference(id: string): NativeSession {
    validateNativeId('dsh', id);
    return { nativeSessionId: id, nativeUrl: this.authenticatedUrl ? `${this.authenticatedUrl}#sessiondeckSession=${encodeURIComponent(id)}` : `${this.baseUrl}/?sessiondeckSession=${encodeURIComponent(id)}` };
  }

  async createSession(cwd: string, _title?: string): Promise<NativeSession> {
    await this.start();
    const result = await this.rpc<{ sessionId: string }>('session.create', { cwd, sessionId: `session-${randomUUID()}` });
    return this.reference(result.sessionId);
  }

  async forkSession(id: string, cwd?: string): Promise<NativeSession> {
    validateNativeId('dsh', id);
    await this.start();
    if (cwd) {
      const { items } = await this.rpc<{ items: DshSummary[] }>('session.list', {});
      const source = items.find(item => item.sessionId === id);
      if (!source?.cwd || !await sameDirectory(source.cwd, cwd)) throw new Error('DeepSeek Harness 原生 Fork 保留原工作目录，暂不支持修改目录');
    }
    const result = await this.rpc<{ sessionId: string }>('session.fork', { sessionId: id });
    if (result.sessionId === id) throw new Error('DeepSeek Harness 未创建独立分叉会话');
    return this.reference(result.sessionId);
  }

  async openSession(id: string): Promise<NativeSession> {
    validateNativeId('dsh', id);
    await this.start();
    const result = await this.rpc<{ items: DshSummary[] }>('session.list', {});
    if (!Array.isArray(result.items) || !result.items.some(item => item.sessionId === id)) throw new Error('未找到对应的 DeepSeek Harness 会话');
    return this.reference(id);
  }

  async setAutoMode(id: string): Promise<void> {
    validateNativeId('dsh', id);
    const result = await this.rpc<{ result?: { kind: string; text?: string } }>('commands.execute', { agentId: id, line: '/permission auto', submittedAttachments: [] });
    if (result?.result?.kind !== 'success') throw new Error(result?.result?.text || 'Harness 原生 Auto 不可用，请检查原生权限预设与自动审核配置');
  }

  async prompt(id: string, text: string): Promise<void> {
    validateNativeId('dsh', id);
    if (!text.trim()) throw new Error('消息不能为空');
    // Private chat and group delivery both need the native Web RPC, including
    // when the contact is attached through dsh-tui rather than the Web UI.
    await this.start();
    await this.rpc('session.prompt', { sessionId: id, ...(this.modern ? { requestId: randomUUID() } : {}), mode: 'queue', content: [{ type: 'text', text }] });
  }

  /** Native history is explicitly read-only: it never attaches or resumes an
   * Agent. Reading a card must also never start a stopped native Web service. */
  async readHistory(id: string, maxMessages = 200): Promise<DshHistory | undefined> {
    validateNativeId('dsh', id);
    if (!this.ready) return undefined;
    return this.rpc<DshHistory>('session.history', { sessionId: id, maxMessages: Math.max(1, Math.min(200, Math.floor(maxMessages))) });
  }

  async stopSession(id: string): Promise<void> {
    validateNativeId('dsh', id);
    if (!this.ready) return;
    // Persisted sessions are visible before the native UI attaches an agent.
    // The native API documents running=false for these cold sessions, whereas
    // session.cancel rejects them as not attached. There is no turn to cancel.
    const result = await this.rpc<{ items: DshSummary[] }>('session.list', {});
    const item = Array.isArray(result.items) ? result.items.find(row => row?.sessionId === id) : undefined;
    if (item?.running === false) return;
    await this.rpc('session.cancel', { sessionId: id });
  }

  private observeRunning(id: string, running: boolean): void {
    // Host status and mux boundaries travel on different sockets. A delayed
    // host "running" must not erase a newer turn/end from the mux stream.
    // Only an identified turn/start retires the preceding attention state.
    if (running) this.historyFresh.delete(id);
    this.observedRunning.set(id, running);
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
  }

  private observeBoundary(id: string, event: unknown): void {
    if (!event || typeof event !== 'object') return;
    const value = event as { type?: unknown; seq?: unknown; data?: { reason?: { kind?: unknown } } };
    if (value.type !== 'turn/start' && value.type !== 'turn/end') return;
    if (typeof value.seq !== 'number' || !Number.isSafeInteger(value.seq) || value.seq < 0) return;
    const previous = this.boundaries.get(id);
    if (previous && previous.seq >= value.seq) return;
    const reason = typeof value.data?.reason?.kind === 'string' ? value.data.reason.kind : undefined;
    this.boundaries.set(id, { type: value.type, seq: value.seq, reason });
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
    if (value.type === 'turn/start') {
      this.observeRunning(id, true);
      this.completed.delete(id); this.failed.delete(id);
    } else {
      this.observeRunning(id, false);
      this.pending.delete(id);
      const key = `dsh:turn:${id}:${value.seq}:${reason ?? 'ended'}`;
      if (reason === 'error') { this.failed.set(id, key); this.completed.delete(id); }
      else { this.completed.set(id, key); this.failed.delete(id); }
    }
  }

  private async recoverHistory(id: string, running: boolean): Promise<void> {
    if (this.historyFresh.has(id)) return;
    const generation = this.streamGeneration;
    try {
      // Native history is read-only and does not resume cold agents. A single
      // message tail carries the final boundary; no prompt bodies are retained.
      const history = await this.rpc<{ events?: { event?: unknown }[] }>('session.history', { sessionId: id, maxMessages: 1 });
      if (generation !== this.streamGeneration || !Array.isArray(history.events)) return;
      const last = history.events.map(entry => entry.event).findLast(event => !!event && typeof event === 'object' && ['turn/start', 'turn/end'].includes((event as { type: string }).type)) as { type: string } | undefined;
      if (last?.type === 'turn/end' || (running && last?.type === 'turn/start')) this.observeBoundary(id, last);
      if (last?.type !== 'turn/start') this.historyFresh.add(id);
    } catch { /* an unavailable history never manufactures a completion */ }
  }

  async getStatus(id: string): Promise<DshStatus> {
    return (await this.getStatuses([id])).get(id)!;
  }

  /** One snapshot per polling round, regardless of the number of contacts. */
  async getStatuses(ids: string[]): Promise<Map<string, DshStatus>> {
    const unique = [...new Set(ids)];
    for (const id of unique) validateNativeId('dsh', id);
    const unknown = (detail: string) => new Map(unique.map(id => [id, { status: 'unknown', detail } as DshStatus]));
    if (!unique.length) return new Map();
    if (!this.ready) return unknown('原生 Web 服务尚未启动');
    try {
      const generation = this.bootGeneration;
      const revisions = new Map(unique.map(id => [id, this.revisions.get(id) ?? 0]));
      const result = await this.rpc<{ items: DshSummary[] }>('session.list', {});
      const items = new Map((Array.isArray(result.items) ? result.items : []).filter(row => row?.sessionId).map(row => [row.sessionId, row]));
      if (this.modern) for (const id of unique) if (items.get(id)?.agentAvailable) this.followAttached(id);
      const statuses = new Map<string, DshStatus>();
      const pending = [...unique];
      await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
        while (pending.length) {
          const id = pending.shift()!;
          statuses.set(id, await this.statusFromSnapshot(id, items.get(id), revisions.get(id)!, generation));
        }
      }));
      if (generation !== this.bootGeneration || !this.ready) return unknown('原生服务已停止');
      for (const id of unique) {
        const item = items.get(id);
        if (typeof item?.running === 'boolean') statuses.set(id, this.currentStatus(id, item.running));
      }
      return statuses;
    } catch { return unknown('无法连接 DeepSeek Harness 原生服务'); }
  }

  private async statusFromSnapshot(id: string, item: DshSummary | undefined, revision: number, generation: number): Promise<DshStatus> {
    if (generation !== this.bootGeneration || !this.ready) return { status: 'unknown', detail: '原生服务已停止' };
    if (!item) return { status: 'unknown', detail: '原生服务未返回该会话' };
    if (typeof item.running !== 'boolean') return { status: 'unknown', detail: '原生服务未返回可识别的运行状态' };
    // Live events received while the HTTP snapshot was in flight are newer.
    if (revision === (this.revisions.get(id) ?? 0)) this.observeRunning(id, item.running);
    const nativeRunning = this.observedRunning.get(id) ?? item.running;
    // A durable turn error may be superseded while the socket is offline.
    // Host errors have no log position; only an identified newer turn can
    // clear those, never a pre-existing history tail.
    if ((!nativeRunning && !this.failed.get(id)?.startsWith('dsh:error:')) || (nativeRunning && !this.muxSynchronized && this.failed.has(id))) await this.recoverHistory(id, nativeRunning);
    if (generation !== this.bootGeneration || !this.ready) return { status: 'unknown', detail: '原生服务已停止' };
    return this.currentStatus(id, item.running);
  }

  private currentStatus(id: string, snapshotRunning: boolean): DshStatus {
    const running = this.observedRunning.get(id) ?? snapshotRunning;
    const pending = this.pending.get(id);
    const approval = pending && [...pending].find(([, status]) => status === 'waiting_approval');
    const question = pending && [...pending].find(([, status]) => status === 'waiting_input');
    if (approval) return { status: 'waiting_approval', detail: 'DeepSeek Harness 正在等待审批', attentionKey: `dsh:${id}:${approval[0]}` };
    if (question) return { status: 'waiting_input', detail: 'DeepSeek Harness 正在等待回答', attentionKey: `dsh:${id}:${question[0]}` };
    if (this.failed.has(id)) return { status: 'error', detail: 'DeepSeek Harness 报告执行错误，请进入原生会话查看', attentionKey: this.failed.get(id) };
    if (running && this.options.manageProcess !== false && (!this.streamReady || !this.muxSynchronized || (this.modern && !this.synchronized.has(id)))) return { status: 'unknown', detail: '原生服务正在运行；等待事件流确认执行或审批状态' };
    if (!running && this.completed.has(id)) return { status: 'waiting_input', detail: 'DeepSeek Harness 本轮已结束，可以继续或验收', attentionKey: this.completed.get(id) };
    return { status: running ? 'running' : 'idle', detail: running ? 'DeepSeek Harness 报告运行中' : 'DeepSeek Harness 报告空闲' };
  }
}
