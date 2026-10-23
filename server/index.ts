import express from 'express';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { statSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { Store } from './store.ts';
import { FunAsr, VoiceConnections } from './voice.ts';
import { VOICE_MAX_FRAME } from '../shared/voice.ts';
import { ScratchpadStore } from './scratchpad.ts';
import { Terminals, type LaunchCommand } from './terminal.ts';
import { ShellTerminals } from './shell-terminals.ts';
import { executionMode } from '../shared/execution.ts';
import { AgentSetup } from './agent-setup.ts';
import { StartupService } from './startup.ts';
import { allowedRemoteRequest, allowedRequest, readCookie, validToken } from './security.ts';
import { AuthStore, type Principal } from './auth.ts';
import { authorize } from './access.ts';
import { FrpTunnel } from './frp.ts';
import { decodeInvite } from './invite.ts';
import { ensureFrp } from './frp-install.ts';
import { pendingPairing, redeemPairing, revokePairing, type PendingPairing } from './pairing.ts';
import type { RelayPairing } from '../shared/pairing.ts';
import { remoteBase, remoteHtml, remoteManifest } from './remote-base.ts';
import { caddyConfig, DEFAULT_REMOTE, normalizeRemote, SecretBox, secretKey, Tunnel } from './remote.ts';
import type { AuthStatus, RemoteSettings, RemoteStatus, ShareMode } from '../shared/auth.ts';
import { demoBackends, seedDemo, demoCommand } from './demo.ts';
import { getBackendInfo, buildLaunch, discoverSessions, resolveNativeSessionId, validateNativeId, findExecutable } from './adapters.ts';
import { DshBridge } from './dsh.ts';
import { NativeStatusWatcher } from './native-status.ts';
import { nativeHookPatch } from './native-events.ts';
import { acquireInstanceLock } from './instance-lock.ts';
import { CodexBridge } from './codex.ts';
import { ClaudeChatBridge } from './claude-chat.ts';
import { DeliveryNotAcceptedError, sendDelivery } from './delivery.ts';
import { StatePublisher } from './state.ts';
import { listDirectories, normalizeDirectoryInput } from './directories.ts';
import { ConversationReader, conversationPreview, handoffPrompt } from './conversation.ts';
import { gitDiff, gitStatus, listWorkspace, openWorkspaceContent, parseByteRange, readWorkspaceFile, streamWorkspaceContent } from './workspace.ts';
import { Attachments, registerAttachments, hasImageSignature } from './attachments.ts';
import { ChatSubmissions } from './chat-submissions.ts';
import { registerAgentChat } from './chat-api.ts';
import { createAgentChatAdapters } from './agents/chat.ts';
import { MAX_TERMINAL_IMAGE_BYTES, TERMINAL_IMAGE_TYPES, type TerminalImageType } from '../shared/terminal-images.ts';
import type { Backend, BackendInfo, Session, AppState, SessionStatus, ConversationTranscript, DiscoveredSession } from '../shared/types.ts';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.env.PORT || process.env.SESSIONDECK_PORT || 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('SESSIONDECK_PORT 必须是 1024–65535 的端口号');
const host = (process.env.HOST || process.env.SESSIONDECK_HOST || '127.0.0.1').trim().replace(/^\[(.*)\]$/, '$1');
if (!host.trim()) throw new Error('SESSIONDECK_HOST 不能为空');
const wildcardHost = host === '0.0.0.0' || host === '::';
const demo = process.env.SESSIONDECK_DEMO === '1';
const dataDir = resolve(process.env.SESSIONDECK_DATA_DIR || join(homedir(), '.local/share', demo ? 'sessiondeck-demo' : 'sessiondeck'));
const instanceLock = await acquireInstanceLock(dataDir);
const store = new Store(join(dataDir, 'sessiondeck.sqlite'));
const scratchpad = new ScratchpadStore(store.db);
const submissions = new ChatSubmissions(store.db);
const attachments = new Attachments(store.db, join(dataDir, 'chat-images'));
// Uploaded images live outside every workspace. They intentionally survive a
// service restart so the native Codex composer can still read a pasted path.
const terminalImageDir = join(dataDir, 'terminal-images');
mkdirSync(terminalImageDir, { recursive: true, mode: 0o700 });
const token = randomBytes(32).toString('hex');
const instanceId = randomUUID();
const auth = new AuthStore(store.db, token);
const DEVICE_COOKIE = 'sessiondeck_device';
const LOCAL_OWNER: Principal = { kind: 'owner', local: true };
// The remote listener binds loopback only; the SSH tunnel carries it to the
// server's loopback and the reverse proxy there terminates TLS.
const envRemotePort = process.env.SESSIONDECK_REMOTE_PORT ? Number(process.env.SESSIONDECK_REMOTE_PORT) : null;
if (envRemotePort !== null && (!Number.isInteger(envRemotePort) || envRemotePort < 1024 || envRemotePort > 65535 || envRemotePort === port)) throw new Error('SESSIONDECK_REMOTE_PORT 必须是与 Web 端口不同的 1024–65535 端口');
// A random key file beside the database seals the saved SSH password.
const secretKeyFile = join(dataDir, 'secret.key');
if (!existsSync(secretKeyFile)) writeFileSync(secretKeyFile, randomBytes(32), { mode: 0o600, flag: 'wx' });
const secrets = new SecretBox(secretKey(readFileSync(secretKeyFile)));
function sshPassword(): string | null {
  const sealed = auth.setting<string>('remote-ssh-password');
  if (!sealed) return null;
  try { return secrets.open(sealed); } catch { return null; }
}
function remoteSettings(): RemoteSettings {
  const { hasPassword: _stale, ...saved } = auth.setting<Partial<RemoteSettings>>('remote') ?? {};
  return { ...DEFAULT_REMOTE, localPort: envRemotePort ?? port + 1, ...saved, ...(envRemotePort ? { localPort: envRemotePort } : {}), hasPassword: !!auth.setting('remote-ssh-password') };
}
function sealedSetting<T>(key: string): T | null {
  const value = auth.setting<string>(key);
  if (!value) return null;
  try { return JSON.parse(secrets.open(value)) as T; } catch { return null; }
}
const pairing = () => sealedSetting<RelayPairing>('remote-pairing');
const tunnel = new Tunnel(dataDir);
const frpTunnel = new FrpTunnel(dataDir);
let remoteBusy = false;
let pairingStage: RemoteStatus['pairingStage'] = null;
async function changeRemote<T>(operation: () => Promise<T>): Promise<T> {
  if (remoteBusy) throw Object.assign(new Error('远程设置正在处理中，请稍候再试'), { status: 409 });
  remoteBusy = true;
  try { return await operation(); } finally { remoteBusy = false; }
}
function cookiePath(req: express.Request) {
  return isRemote(req) ? `${remoteBase(remoteSettings())}/` : '/';
}
const terminals = new Terminals();
const shells = new ShellTerminals();
const nativeStatus = new NativeStatusWatcher();
const dsh = new DshBridge({ dataDir });
const conversations = new ConversationReader({ dshHistory: id => dsh.readHistory(id) });
// Codex's app-server is lazy-started on the first Codex contact. This keeps a
// Claude/dsh-only installation usable when an older Codex CLI lacks the bridge
// flags, while preserving exact native IDs whenever the installed CLI supports it.
const codexBridge = new CodexBridge({ dataDir });
const codexRuns = new Map<string, { nativeId: string; launchId: string }>();
const claudeBridge = new ClaudeChatBridge((id, cursor) => conversations.readClaudePage(id, cursor));
const claudeRuns = new Map<string, { nativeId: string; launchId: string }>();
const app = express();
const server = createServer(app);
const remoteServer = createServer(app);
const remoteSockets = new WeakSet<object>();
remoteServer.on('connection', socket => remoteSockets.add(socket));
const isRemote = (req: { socket: object }) => remoteSockets.has(req.socket);
const voiceEngine = new FunAsr(dataDir, { enabled: () => !demo && auth.setting('voice-enabled') === true, enable: () => auth.setSetting('voice-enabled', true) });
const voiceConnections = new VoiceConnections(voiceEngine);
const voiceWss = new WebSocketServer({ noServer: true, maxPayload: VOICE_MAX_FRAME, perMessageDeflate: false });
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
// Remote viewers keep their device token in memory so a revoked or expired
// device is disconnected instead of continuing to receive live output.
type Viewer = { principal: Principal; device?: string };
const sse = new Map<express.Response, Viewer>();
const viewers = new WeakMap<WebSocket, Viewer>();
const starting = new Set<string>();
const stopping = new Set<string>();
const expectedNativeIds = new Map<string, string>();
// Native hooks and async observations from a previous launch must never attach
// to a new run of the same contact, even when the native session ID is unchanged.
const launchIds = new Map<string, string>();
let closing = false;
const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
let backends: BackendInfo[] = demo ? demoBackends : await getBackendInfo();
if (demo) seedDemo(store, process.cwd());
const publisher = new StatePublisher(store, { instanceId, backends, defaultCwd: process.cwd(), demo });

function state(): AppState {
  return publisher.snapshot();
}
function broadcast() {
  if (closing) return;
  const patch = publisher.takePatch();
  if (!patch) return;
  const chunk = `event: patch\ndata: ${JSON.stringify(patch)}\n\n`;
  for (const [client, viewer] of sse) {
    // A sleeping tab must not retain an unbounded queue of obsolete full states.
    if (client.destroyed || client.writableLength > 2_097_152) { sse.delete(client); client.destroy(); }
    // A share sees one session. Its tiny filtered snapshot replaces patches
    // that could otherwise mention other contacts, groups or activities.
    else client.write(viewer.principal.kind === 'share' ? `event: state\ndata: ${JSON.stringify(viewState(viewer.principal))}\n\n` : chunk);
  }
}
function viewState(principal: Principal): AppState {
  const full = state();
  if (principal.kind !== 'share') return full;
  return {
    ...full, defaultCwd: '', groups: [],
    sessions: full.sessions.filter(item => item.id === principal.sessionId && !item.archived),
    activities: full.activities.filter(activity => activity.sessionId === principal.sessionId),
  };
}
function principalOf(res: express.Response): Principal { return res.locals.principal as Principal; }
/** Drops live connections whose device was revoked, expired or re-keyed. */
function revalidateViewers() {
  for (const [client, viewer] of sse) if (viewer.device && !auth.principal(viewer.device)) { sse.delete(client); client.end(); }
  for (const socket of wss.clients) { const viewer = viewers.get(socket); if (viewer?.device && !auth.principal(viewer.device)) socket.close(4401, '访问已撤销'); }
  voiceConnections.revalidate(device => !!auth.principal(device));
  chatApi.revalidate(device => !!auth.principal(device));
}
function terminalEvent(id: string, event: unknown, channel: 'sessionId' | 'shellId' = 'sessionId') {
  const message = JSON.stringify(event);
  for (const socket of wss.clients) {
    if ((socket as WebSocket & { sessionId?: string; shellId?: string })[channel] !== id || socket.readyState !== WebSocket.OPEN) continue;
    // Reconnection reconstructs the terminal snapshot; dropping a stalled viewer
    // is safer than dropping arbitrary ANSI chunks or accumulating unlimited output.
    if (socket.bufferedAmount > 2_097_152) socket.terminate();
    else socket.send(message);
  }
}
let scheduled: NodeJS.Timeout | null = null;
function scheduleBroadcast() {
  if (closing || scheduled) return;
  scheduled = setTimeout(() => { scheduled = null; broadcast(); }, 180);
}
function fail(message: string, status = 400): never { throw Object.assign(new Error(message), { status }); }
function text(value: unknown, name: string, max = 200, required = true): string {
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > max || /\x00/.test(value)) fail(`${name}无效（最多 ${max} 字符）`);
  return value.trim();
}
function backend(value: unknown): Backend {
  if (typeof value !== 'string' || !['claude', 'codex', 'dsh'].includes(value)) fail('未知后端');
  return value as Backend;
}
function directory(value: unknown) {
  const path = normalizeDirectoryInput(value);
  try { if (!statSync(path).isDirectory()) fail('工作目录不是目录'); }
  catch { fail('工作目录不存在或无法访问'); }
  return path;
}
function session(id: string) { return store.session(id) || fail('会话不存在', 404); }
function updatePreview(item: Session, transcript: ConversationTranscript, persisted = true) {
  if (closing || demo || item.forkPending || !item.nativeSessionId) return;
  const current = store.session(item.id);
  // An in-flight read may complete after a pending Fork gets its own identity.
  if (!current || current.forkPending || current.backend !== item.backend || current.nativeSessionId !== item.nativeSessionId) return;
  const preview = conversationPreview(transcript);
  if (!preview || (current.lastUserInput === preview.text && current.lastUserInputAt === (preview.createdAt ?? null))) return;
  // A saved rollout can lag a just-accepted graphical message, or an older
  // async read can finish after the next input. Never move a preview backward.
  if (current.lastUserInputAt && (!preview.createdAt || Date.parse(preview.createdAt) < Date.parse(current.lastUserInputAt))) return;
  store.updateSession(item.id, { lastUserInput: preview.text, lastUserInputAt: preview.createdAt ?? null, ...(persisted && current.backend === 'claude' ? { claudeUnwritten: undefined } : {}) });
  scheduleBroadcast();
}
function groupId(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const id = text(value, '群组 ID');
  if (!store.group(id)) fail('群组不存在', 404);
  return id;
}
function info(id: Backend) { return backends.find(b => b.id === id)!; }
/** DeepSeek Harness runs in a PTY like Claude/Codex when dsh-tui is installed; otherwise through its native Web UI. */
const dshWeb = (item: Pick<Session, 'backend'>) => item.backend === 'dsh' && !demo && !info('dsh').capabilities.terminal;
function status(id: string, patch: Partial<Session>, activity?: string) {
  if (closing) return;
  const old = session(id);
  const attention = patch.status && ['waiting_input', 'waiting_approval', 'error'].includes(patch.status)
    && (patch.lastAttentionKey ? patch.lastAttentionKey !== old.lastAttentionKey : patch.status !== old.status)
    // The generic native waiting flag can arrive before its item-specific
    // approval request. Enriching the identity is still the same interruption.
    && !(patch.status === 'waiting_approval' && old.status === 'waiting_approval');
  const updated = store.updateSession(id, { ...(patch.status && patch.status !== 'error' ? { errorCode: null } : {}), ...patch, ...(attention ? { unread: old.unread + 1 } : {}) });
  if (activity) store.activity(id, 'status', activity);
  scheduleBroadcast();
  return updated;
}
function codexStatus(nativeId: string, event: { status: SessionStatus; detail: string; timestamp: string; attentionKey?: string }) {
  if (closing) return;
  const item = publisher.sessions().find(s => s.backend === 'codex' && s.nativeSessionId === nativeId && s.running && !s.forkPending && codexRuns.get(s.id)?.launchId === launchIds.get(s.id) && codexRuns.get(s.id)?.nativeId === nativeId);
  if (!item || stopping.has(item.id)) return;
  if (item.status !== event.status || item.statusDetail !== event.detail || item.statusSource !== 'native' || (event.attentionKey && item.lastAttentionKey !== event.attentionKey))
    status(item.id, { status: event.status, statusSource: 'native', statusDetail: event.detail, lastActivity: event.timestamp, ...(event.attentionKey ? { lastAttentionKey: event.attentionKey } : {}) });
}
codexBridge.onStatus(codexStatus);
claudeBridge.onStatus((nativeId, event) => {
  if (closing) return;
  const item = publisher.sessions().find(s => s.backend === 'claude' && s.nativeSessionId === nativeId && claudeRuns.get(s.id)?.nativeId === nativeId && claudeRuns.get(s.id)?.launchId === launchIds.get(s.id));
  if (!item || stopping.has(item.id)) return;
  status(item.id, { status: event.status, statusSource: 'native', statusDetail: event.detail, lastActivity: event.timestamp, ...(event.attentionKey ? { lastAttentionKey: event.attentionKey } : {}), ...(event.running === false ? { running: false } : {}) });
  if (event.attentionKey && event.status === 'waiting_input') void conversations.readLatest(item).then(transcript => updatePreview(item, transcript)).catch(() => {});
  if (event.running === false) { claudeRuns.delete(item.id); launchIds.delete(item.id); }
});
async function ensureCodexBridge() {
  await codexBridge.start();
  return codexBridge;
}
function observeNative(item: Session) {
  if (demo || !item.running || closing || codexRuns.has(item.id) || claudeRuns.has(item.id)) return;
  const launchId = launchIds.get(item.id);
  nativeStatus.start(item, event => {
    if (closing || stopping.has(item.id) || launchIds.get(item.id) !== launchId || !store.session(item.id)?.running) return;
    status(item.id, { status: event.status, statusSource: 'native', statusDetail: event.detail, lastActivity: event.timestamp });
  });
}

app.disable('x-powered-by');
app.use((req, res, next) => {
  const remote = isRemote(req);
  if (remote ? !allowedRemoteRequest(req, remoteSettings().publicUrl, remoteSettings().localPort) : !allowedRequest(req, port, wildcardHost)) return res.status(403).json({ error: '请求来源不被允许' });
  const device = remote ? readCookie(req.headers.cookie, DEVICE_COOKIE) : undefined;
  res.locals.remote = remote;
  res.locals.device = device;
  res.locals.principal = remote ? auth.principal(device) : LOCAL_OWNER;
  if (req.path.startsWith('/api/')) {
    const decision = authorize(res.locals.principal, remote, req.method, req.path);
    if (!decision.allowed) return res.status(decision.status).json({ error: decision.error, code: decision.status === 401 ? 'AUTH_REQUIRED' : undefined });
    const principal = res.locals.principal as Principal | null;
    if (principal?.kind === 'share' && req.method === 'POST') shareActivity(principal, req.path);
  }
  if (remote && req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

// Every action taken through a share is attributed in the session's activity.
const shareActions: [RegExp, string][] = [
  [/\/start$/, '启动了会话'], [/\/stop$/, '停止了会话'], [/\/chat\/messages$/, '发送了消息'],
  [/\/attachments$/, '添加了图片附件'], [/\/input$/, '填入了原生输入'],
  [/\/chat\/requests\//, '处理了审批'], [/\/chat\/interrupt$/, '停止了生成'], [/\/terminal\/image$/, '粘贴了图片'],
];
function shareActivity(principal: Extract<Principal, { kind: 'share' }>, path: string) {
  const action = shareActions.find(([pattern]) => pattern.test(path))?.[1];
  if (action) { store.activity(principal.sessionId, 'share', `${principal.name}（分享）${action}`); scheduleBroadcast(); }
}
function csrfValid(req: express.Request, res: express.Response) {
  const principal = res.locals.principal as Principal | null;
  return !!principal && validToken(req.headers['x-sessiondeck-token'], auth.csrf(principal));
}

type PendingTerminalImage = { id: string; generation: string; type: TerminalImageType };
const pendingTerminalImages = new WeakMap<express.Request, PendingTerminalImage>();
const imageExtension: Record<TerminalImageType, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
function imageType(value: unknown): TerminalImageType | null {
  const type = typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : '';
  return (TERMINAL_IMAGE_TYPES as readonly string[]).includes(type) ? type as TerminalImageType : null;
}
function captureTerminalImage(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!csrfValid(req, res)) return res.status(403).json({ error: '操作凭证已过期，请刷新页面' });
  const type = imageType(req.headers['content-type']);
  if (!type) return res.status(415).json({ error: '仅支持 PNG、JPEG、GIF 或 WebP 图片' });
  const length = req.headers['content-length'];
  if (typeof length === 'string' && /^\d+$/.test(length) && Number(length) > MAX_TERMINAL_IMAGE_BYTES)
    return res.status(413).json({ error: '图片不能超过 10 MiB' });
  const id = String(req.params.id);
  const item = store.session(id);
  const generation = terminals.generation(id);
  const suppliedGeneration = req.headers['x-sessiondeck-terminal'];
  if (typeof suppliedGeneration !== 'string' || !generation || suppliedGeneration !== generation)
    return res.status(409).json({ error: '原生终端已重启，请重新连接后粘贴图片' });
  if (!item || !['codex', 'claude', 'dsh'].includes(item.backend) || !item.running || item.backend !== 'claude' && item.interactionMode === 'chat')
    return res.status(409).json({ error: '只有正在运行的 Agent 原生终端可以接收图片' });
  if (item.status === 'waiting_approval') return res.status(409).json({ error: '原生会话正在等待审批，请先完成审批后再添加图片' });
  pendingTerminalImages.set(req, { id, generation, type });
  next();
}
// This route must precede express.json and the generic JSON-body guard. The
// capture middleware runs before the raw parser receives any request bytes.
app.post('/api/sessions/:id/terminal/image', captureTerminalImage,
  express.raw({ type: () => true, limit: MAX_TERMINAL_IMAGE_BYTES }),
  async (req, res, next) => {
    const pending = pendingTerminalImages.get(req);
    const body = Buffer.isBuffer(req.body) ? req.body : null;
    let temporary: string | null = null;
    let target: string | null = null;
    try {
      if (!pending || !body?.length) fail('图片正文为空');
      if (body.length > MAX_TERMINAL_IMAGE_BYTES) fail('图片不能超过 10 MiB', 413);
      if (!hasImageSignature(body, pending.type)) fail('图片内容与声明的格式不匹配', 415);
      const name = randomUUID();
      temporary = join(terminalImageDir, `.upload-${name}${imageExtension[pending.type]}`);
      target = join(terminalImageDir, `${name}${imageExtension[pending.type]}`);
      await writeFile(temporary, body, { mode: 0o600 });
      await chmod(temporary, 0o600);
      // The PTY may have been stopped/replaced while the body was buffered.
      const current = store.session(pending.id);
      if (!current || !current.running || current.backend !== 'claude' && current.interactionMode === 'chat' || terminals.generation(pending.id) !== pending.generation)
        fail('原生终端已重启，请重新粘贴图片', 409);
      await rename(temporary, target);
      temporary = null;
      terminals.stagePath(pending.id, target, pending.generation, current.backend);
      res.json({ staged: true });
    } catch (error) {
      if (temporary) await unlink(temporary).catch(() => undefined);
      if (target) await unlink(target).catch(() => undefined);
      next(error);
    }
  });
registerAttachments(app, express.raw, attachments, { csrf: csrfValid, allowed: id => { const item = store.session(id); return !demo && !!item && !item.archived && ['codex', 'claude', 'dsh'].includes(item.backend); } });
app.use(express.json({ limit: '128kb' }));
// Login and share redemption run before a device exists; the remote listener
// already requires a matching Origin for them, and SameSite blocks the cookie.
const preAuth = new Set(['/api/auth/login', '/api/auth/redeem', '/api/auth/logout']);
app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD'].includes(req.method) && !preAuth.has(req.originalUrl.split('?')[0]) && !csrfValid(req, res))
    return res.status(403).json({ error: '操作凭证已过期，请刷新页面' });
  if (!['GET', 'HEAD'].includes(req.method) && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)))
    return res.status(400).json({ error: '请求正文必须是 JSON 对象' });
  next();
});

app.get('/api/config', (_req, res) => res.json({ csrfToken: auth.csrf(principalOf(res)) }));
app.get('/api/state', (_req, res) => res.json(viewState(principalOf(res))));
app.get('/api/scratchpad', (_req, res) => res.json(scratchpad.read()));
app.patch('/api/scratchpad', (req, res) => res.json(scratchpad.save(req.body)));

function authStatus(res: express.Response): AuthStatus {
  const principal = res.locals.principal as Principal | null;
  const remote = res.locals.remote as boolean;
  if (!principal) return { kind: 'anonymous', remote: true, passwordSet: auth.hasPassword() };
  if (principal.kind === 'share') return { kind: 'share', remote, sessionId: principal.sessionId, mode: principal.mode, name: principal.name };
  const deviceName = remote ? pairing()?.name?.trim() : undefined;
  return { kind: 'owner', remote, passwordSet: auth.hasPassword(), ...(deviceName ? { deviceName } : {}) };
}
function setDevice(req: express.Request, res: express.Response, token: string, expiresAt: string | null) {
  const secure = req.headers['x-forwarded-proto'] === 'https';
  const maxAge = expiresAt ? Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000)) : 10 * 365 * 86400;
  res.setHeader('Set-Cookie', `${DEVICE_COOKIE}=${encodeURIComponent(token)}; Path=${cookiePath(req)}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
}
const clientAddress = (req: express.Request) => String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
const userAgent = (req: express.Request) => String(req.headers['user-agent'] ?? '').slice(0, 200);
app.get('/api/auth/status', (_req, res) => res.json(authStatus(res)));
app.post('/api/auth/login', async (req, res) => {
  if (!res.locals.remote) return res.json(authStatus(res));
  const { token: device, device: info } = await auth.login(req.body.password, clientAddress(req), userAgent(req));
  setDevice(req, res, device, info.expiresAt);
  res.locals.principal = auth.principal(device);
  res.json(authStatus(res));
});
app.post('/api/auth/redeem', (req, res) => {
  const { token: device, device: info } = auth.redeemShare(req.body.token, req.body.name, userAgent(req));
  // Redeeming on the loopback listener would be pointless: it is always owner.
  if (!res.locals.remote) fail('分享链接需要通过远程地址打开', 409);
  setDevice(req, res, device, info.expiresAt);
  res.locals.principal = auth.principal(device);
  res.json(authStatus(res));
});
app.post('/api/auth/logout', (req, res) => {
  const principal = res.locals.principal as Principal | null;
  if (principal) auth.logout(principal);
  res.setHeader('Set-Cookie', `${DEVICE_COOKIE}=; Path=${cookiePath(req)}; HttpOnly; SameSite=Lax; Max-Age=0`);
  revalidateViewers();
  res.json({ ok: true });
});
app.post('/api/auth/password', async (req, res) => {
  await auth.setPassword(req.body.password);
  revalidateViewers();
  res.json(authStatus(res));
});
app.get('/api/auth/devices', (_req, res) => res.json(auth.ownerDevices()));
app.delete('/api/auth/devices/:id', (req, res) => { auth.revokeDevice(String(req.params.id)); revalidateViewers(); res.json({ ok: true }); });

function remoteStatus(): RemoteStatus {
  const settings = remoteSettings();
  const pair = pairing();
  return { settings, tunnel: settings.mode === 'invite' ? frpTunnel.status() : tunnel.status(), listening: remoteServer.listening, caddy: settings.mode === 'invite' ? '' : caddyConfig(settings), pairing: pair ? { deviceId: pair.deviceId, name: pair.name, serverUrl: pair.serverUrl, pairedAt: pair.pairedAt } : null, pairingStage };
}
async function applyRemote() {
  const settings = remoteSettings();
  const wanted = settings.enabled || envRemotePort !== null;
  const address = remoteServer.address();
  const boundPort = address && typeof address === 'object' ? address.port : null;
  if (remoteServer.listening && (!wanted || boundPort !== settings.localPort)) {
    remoteServer.closeAllConnections();
    await new Promise<void>(accept => remoteServer.close(() => accept()));
  }
  if (wanted && !remoteServer.listening && !closing) {
    await new Promise<void>((accept, reject) => {
      const failed = (error: NodeJS.ErrnoException) => reject(Object.assign(new Error(error.code === 'EADDRINUSE' ? `远程监听端口 ${settings.localPort} 已被占用` : error.message), { status: 409 }));
      remoteServer.once('error', failed);
      remoteServer.listen(settings.localPort, '127.0.0.1', () => { remoteServer.off('error', failed); accept(); });
    });
  }
  await tunnel.configure(settings.mode !== 'invite' && settings.enabled && remoteServer.listening ? settings : null, sshPassword());
  const pair = pairing();
  if (settings.mode === 'invite' && settings.enabled && !pair) fail('配对信息不可用，请重新输入邀请码', 409);
  await frpTunnel.configure(settings.mode === 'invite' && settings.enabled && remoteServer.listening ? pair : null, settings.localPort);
}
app.get('/api/remote', (_req, res) => res.json(remoteStatus()));
app.post('/api/remote', async (req, res) => res.json(await changeRemote(async () => {
  const current = remoteSettings();
  const mode = req.body.mode ?? current.mode ?? 'ssh';
  if (!['ssh', 'invite'].includes(mode)) fail('远程连接方式无效');
  const pair = pairing();
  let next: RemoteSettings;
  if (mode === 'invite') {
    if (!pair) fail('请先输入邀请码完成配对', 409);
    // The relay assigns these values; never accept a URL or port from the browser.
    next = { ...current, mode, publicUrl: pair!.publicUrl, serverPort: pair!.serverPort, enabled: req.body.enabled === true };
  } else next = { ...normalizeRemote(req.body, { ...current, mode: 'ssh' }), mode: 'ssh' };
  if (next.localPort === port) fail('远程监听端口不能与本机 Web 端口相同');
  if (next.enabled && !auth.hasPassword()) fail('请先设置所有者密码');
  if (typeof req.body.sshPassword === 'string') auth.setSetting('remote-ssh-password', req.body.sshPassword ? secrets.seal(req.body.sshPassword) : null);
  const { localPort, hasPassword: _hasPassword, ...saved } = next;
  auth.setSetting('remote', envRemotePort ? saved : { ...saved, localPort });
  await applyRemote();
  return remoteStatus();
})));
app.post('/api/remote/pair', async (req, res) => res.json(await changeRemote(async () => {
  if (!auth.hasPassword()) fail('请先设置所有者密码');
  if (pairing()) fail('请先解除已有配对，再使用新的邀请码', 409);
  const input = pendingPairing(req.body.invite, req.body.name);
  const saved = sealedSetting<PendingPairing>('remote-pairing-pending');
  const pending = saved?.invite === input.invite ? saved : input;
  // Persist the claim before redeeming: a lost HTTP response can be retried safely.
  auth.setSetting('remote-pairing-pending', secrets.seal(JSON.stringify(pending)));
  try {
    pairingStage = 'installing';
    await ensureFrp(dataDir, 'frpc', decodeInvite(pending.invite).serverUrl);
    pairingStage = 'redeeming';
    const pair = await redeemPairing(pending);
    auth.setSetting('remote-pairing', secrets.seal(JSON.stringify(pair)));
    auth.setSetting('remote-pairing-pending', null);
    auth.setSetting('remote', { ...remoteSettings(), mode: 'invite', enabled: true, publicUrl: pair.publicUrl, serverPort: pair.serverPort });
    pairingStage = 'connecting';
    await applyRemote();
    return { ...remoteStatus(), pairingStage: null };
  } finally { pairingStage = null; }
})));
app.delete('/api/remote/pair', async (_req, res) => res.json(await changeRemote(async () => {
  const pair = pairing();
  if (!pair) fail('尚未配对', 409);
  // Stop exposure even if the relay is offline; retain credentials for retrying revoke.
  auth.setSetting('remote', { ...remoteSettings(), enabled: false });
  await applyRemote();
  await revokePairing(pair!);
  auth.setSetting('remote-pairing', null);
  auth.setSetting('remote', { ...remoteSettings(), mode: 'ssh', enabled: false, publicUrl: '' });
  return remoteStatus();
})));

const shareUrl = (secret: string) => `${remoteSettings().publicUrl || `http://127.0.0.1:${remoteSettings().localPort}`}/#/share/${secret}`;
app.get('/api/sessions/:id/shares', (req, res) => { session(String(req.params.id)); res.json(auth.shares(String(req.params.id))); });
app.post('/api/sessions/:id/shares', (req, res) => {
  const item = session(String(req.params.id));
  const mode = req.body.mode as ShareMode;
  if (mode !== 'read' && mode !== 'write') fail('分享权限无效');
  const ttl = req.body.ttlDays === null ? null : Number(req.body.ttlDays);
  if (ttl !== null && (!Number.isInteger(ttl) || ttl < 1 || ttl > 365)) fail('有效期无效');
  const { token: secret, share } = auth.createShare(item.id, mode, ttl, text(req.body.label ?? '', '备注', 80, false));
  store.activity(item.id, 'share', `创建了${mode === 'write' ? '可协作' : '只读'}分享链接`); broadcast();
  res.status(201).json({ share, url: shareUrl(secret), remoteReady: !!remoteSettings().publicUrl && remoteSettings().enabled });
});
app.delete('/api/shares/:id', (req, res) => { auth.revokeShare(String(req.params.id)); revalidateViewers(); broadcast(); res.json({ ok: true }); });
app.get('/api/shells', (_req, res) => res.json(shells.list()));
app.post('/api/shells', (req, res) => {
  if (closing) fail('终端服务正在关闭', 503);
  const source = req.body.sessionId === undefined ? undefined : session(text(req.body.sessionId, '会话 ID'));
  res.status(201).json(shells.create(directory(source?.cwd ?? process.cwd()), source?.id));
});
app.delete('/api/shells/:id', async (req, res) => {
  const id = String(req.params.id);
  if (!shells.get(id)) fail('终端不存在', 404);
  await shells.remove(id);
  for (const socket of wss.clients) if ((socket as WebSocket & { shellId?: string }).shellId === id) socket.close(1000, 'Shell removed');
  res.json({ removed: true });
});
const chatApi = registerAgentChat(app, {
  store, adapters: createAgentChatAdapters([['codex', codexBridge], ['claude', claudeBridge]]), conversations, instanceId, demo, updatePreview, attachments, submissions,
  closing: () => closing,
  supported: item => !!info(item.backend).capabilities.graphicalChat,
  ready: item => { const run = (item.backend === 'claude' ? claudeRuns : codexRuns).get(item.id); return run?.nativeId === item.nativeSessionId && run?.launchId === launchIds.get(item.id); },
  busy: id => starting.has(id) || stopping.has(id),
  sessions: () => publisher.sessions(),
  broadcast: scheduleBroadcast,
});
app.post('/api/directories/list', async (req, res) => {
  res.json(await listDirectories(req.body.path, { showHidden: req.body.showHidden === true }));
});
app.get('/api/sessions/:id/input', (req, res) => {
  const item = session(String(req.params.id));
  const requestId = req.query.requestId;
  if (requestId !== undefined && (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(requestId))) fail('发送标识无效');
  res.json({ generation: terminals.generation(item.id), nativeSessionId: item.nativeSessionId, directSubmit: true, ...(typeof requestId === 'string' ? { submission: submissions.get(item.id, requestId) ?? null } : {}) });
});
app.post('/api/sessions/:id/input', async (req, res) => {
  const item = session(String(req.params.id));
  if (demo || item.backend === 'codex' || item.archived || !item.running || item.forkPending || starting.has(item.id) || stopping.has(item.id)) fail('请先启动会话后发送消息',409);
  if (req.body.submit !== undefined && typeof req.body.submit !== 'boolean') fail('发送方式无效');
  const submit = req.body.submit === true;
  if (item.status === 'waiting_approval') fail('请先在原生终端中处理审批',409);
  const generation = terminals.generation(item.id);
  if (!generation || req.body.generation !== generation) fail('原生终端已变化，请核对后重新填入',409);
  if (typeof req.body.text !== 'string' || req.body.text.length > 30000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(req.body.text)) fail('内容无效或超过 30000 字符');
  if (typeof req.body.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(req.body.requestId)) fail('发送标识无效');
  const images = attachments.resolve(item.id, req.body.attachments);

  if (!req.body.text.trim() && !images.length) fail('内容不能为空');
  // Keep hashes of older staging requests compatible; a send cannot reuse a staging ID.
  const payload = [req.body.text,req.body.attachments ?? [], ...(submit ? [true] : [])];
  const { created, submission } = submissions.begin(item.id,req.body.requestId, generation, JSON.stringify(payload));
  if (!created) return res.json({ ...submission, staged:!submit, submitted:submit && submission.status === 'accepted' });
  try {
    if (submit) {
      await terminals.submit(item.id, req.body.text, images, generation, item.backend, () => {
        const current = store.session(item.id);
        if (!current || current.archived || !current.running || current.nativeSessionId !== item.nativeSessionId || starting.has(item.id) || stopping.has(item.id)) fail('会话状态已变化，请核对原生会话',409);
        if (current.status === 'waiting_approval') fail('请先在原生终端中处理审批',409);
      });
    } else {
      // Group/task staging remains a separate, user-confirmed operation.
      for (const image of images) terminals.stagePath(item.id, image, generation, item.backend);
      if (req.body.text.trim()) terminals.stage(item.id, (images.length ? ' ' : '') + req.body.text);
    }
    res.json({ ...submissions.finish(item.id,req.body.requestId,{status:'accepted'}), staged:!submit, submitted:submit });
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : '原生发送结果未知';
    const result = submissions.finish(item.id,req.body.requestId,{status:'unknown',error});
    // Pasted content may already be native: keep the request ID pending.
    res.status(202).json({ ...result, staged:!submit, submitted:false });
  }
});
app.get('/api/sessions/:id/conversation', async (req, res) => {
  const item = session(String(req.params.id));
  if (demo) return res.json({ messages: [], truncated: false, notice: '演示终端不保存原生对话；真实会话的已保存记录会显示在这里。' });
  const transcript = await conversations.read(item);
  const current = closing ? undefined : store.session(item.id);
  if (!current || current.nativeSessionId !== item.nativeSessionId || current.forkPending !== item.forkPending) return res.status(409).json({ error: '会话身份已更新，请重新读取对话' });
  updatePreview(item, transcript);
  res.json(transcript);
});
app.get('/api/sessions/:id/workspace/tree', async (req, res) => {
  const item = session(String(req.params.id));
  res.json(await listWorkspace(item.cwd, req.query.path));
});
app.get('/api/sessions/:id/workspace/file', async (req, res) => {
  const item = session(String(req.params.id));
  res.json(await readWorkspaceFile(item.cwd, req.query.path));
});
app.get('/api/sessions/:id/workspace/raw/*path', async (req, res) => {
  const item = session(String(req.params.id));
  // Express 5 exposes `*path` as a segment array; join it back for workspace paths.
  const rawPath = req.params.path;
  const relative = (Array.isArray(rawPath) ? rawPath.join('/') : String(rawPath ?? '')).replace(/^\/+/, '');
  const content = await openWorkspaceContent(item.cwd, relative);
  const range = parseByteRange(typeof req.headers.range === 'string' ? req.headers.range : undefined, content.size);
  if (range === 'invalid') {
    await content.handle.close().catch(() => {});
    res.setHeader('Content-Range', `bytes */${content.size}`);
    return res.status(416).end();
  }
  res.setHeader('Content-Type', content.mime);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  // Keep HTML previews framed only by this origin. Opaque-origin iframe sandbox
  // on the client is the main isolation; this CSP also blocks form/API exfil if
  // the same URL is opened outside the sandbox.
  if (content.kind === 'html') {
    res.setHeader('Content-Security-Policy', "default-src 'self' https: data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' https: data: blob:; font-src 'self' https: data:; media-src 'self' https: data: blob:; connect-src 'none'; form-action 'none'; frame-ancestors 'self'; base-uri 'self'; object-src 'none'");
  } else if (content.kind === 'other') {
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(content.path.split('/').pop() || 'file')}`);
  }
  if (content.size === 0) {
    await content.handle.close().catch(() => {});
    res.setHeader('Content-Length', '0');
    return res.status(200).end();
  }
  if (range) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${content.size}`);
    res.setHeader('Content-Length', String(range.end - range.start + 1));
  } else {
    res.setHeader('Content-Length', String(content.size));
  }
  const stream = streamWorkspaceContent(content, range);
  stream.on('error', () => { if (!res.headersSent) res.status(500); res.end(); });
  req.on('close', () => stream.destroy());
  stream.pipe(res);
});
app.get('/api/sessions/:id/workspace/git/status', async (req, res) => {
  const item = session(String(req.params.id));
  res.json(await gitStatus(item.cwd));
});
app.get('/api/sessions/:id/workspace/git/diff', async (req, res) => {
  const item = session(String(req.params.id));
  res.json(await gitDiff(item.cwd, req.query.path));
});
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const principal = principalOf(res);
  res.write(`event: state\ndata: ${JSON.stringify(viewState(principal))}\n\n`);
  sse.set(res, { principal, device: res.locals.device });
  // A named ping (not a comment) lets the browser notice a stalled stream,
  // for example behind a proxy that buffers or compresses event streams.
  const heartbeat = setInterval(() => res.write('event: ping\ndata: {}\n\n'), 20_000);
  req.on('close', () => { sse.delete(res); clearInterval(heartbeat); });
});

app.get('/api/voice', (_req, res) => res.json(voiceEngine.status()));
app.get('/api/sessions/:id/voice', (req, res) => { session(String(req.params.id)); res.json(voiceEngine.status()); });
app.post('/api/voice', (req, res) => {
  if (demo) fail('演示模式不修改语音设置', 409);
  if (typeof req.body.enabled !== 'boolean') fail('无效的语音设置');
  if (req.body.enabled && !voiceEngine.status().installed) fail('请先安装语音插件', 409);
  auth.setSetting('voice-enabled', req.body.enabled);
  if (!req.body.enabled) { voiceConnections.close(); voiceEngine.disable(); }
  res.json(voiceEngine.status());
});
app.post('/api/voice/install', (_req, res) => {
  if (demo || closing) fail('当前模式不能安装语音插件', 409);
  voiceEngine.install(); res.status(202).json(voiceEngine.status());
});
app.post('/api/voice/warmup', (_req, res) => {
  if (demo || closing) fail('当前模式不能启动语音插件', 409);
  if (!voiceEngine.status().enabled || !voiceEngine.status().installed) fail('请先安装并启用语音插件', 409);
  void voiceEngine.ready().catch(() => {});
  res.status(202).json(voiceEngine.status());
});

const agentSetup = new AgentSetup();
const startupService = new StartupService({ root, dataDir, port, host });
app.get('/api/setup/agents', async (_req, res) => {
  // Demo instances must not read the owner's real authentication/config files.
  if (demo) return res.json([]);
  res.json(await agentSetup.list());
});
app.post('/api/setup/agents/:id/config', async (req, res) => {
  if (demo) fail('演示模式不修改原生配置', 409);
  res.json(await agentSetup.save(backend(req.params.id), req.body));
});
app.post('/api/setup/agents/:id/terminal', async (req, res) => {
  if (demo) fail('演示模式不安装或登录真实 Agent', 409);
  if (closing) fail('终端服务正在关闭', 503);
  if (process.platform !== 'linux') fail('安装引导终端目前支持 Linux / WSL2，请使用页面中的命令手动配置', 409);
  const command = await agentSetup.command(backend(req.params.id), req.body.action);
  res.status(201).json(shells.create(directory(homedir()), null, command));
});
app.get('/api/setup/startup', async (_req, res) => {
  if (demo) return res.json({ supported: false, enabled: false, active: false, wsl: false, linger: false, conflict: false, unitPath: '', note: '演示模式不修改本机启动设置' });
  res.json(await startupService.status());
});
app.post('/api/setup/startup', async (req, res) => {
  if (demo) fail('演示模式不修改本机启动设置', 409);
  if (typeof req.body.enabled !== 'boolean') fail('无效的自动启动设置');
  res.json(await startupService.change(req.body.enabled));
});

app.post('/api/backends/refresh', async (_req, res) => { backends = demo ? demoBackends : await getBackendInfo(); publisher.setBackends(backends); broadcast(); res.json(backends); });
app.get('/api/discover', async (req, res) => {
  const filter = req.query.backend ? backend(req.query.backend) : undefined;
  const existing = new Set(publisher.sessions().filter(s => !s.forkPending).map(s => `${s.backend}:${s.nativeSessionId}`));
  const found: DiscoveredSession[] = demo
    ? !filter || filter === 'codex' ? [{ backend: 'codex', nativeSessionId: 'demo-import', title: '可导入的演示会话', cwd: process.cwd(), lastActivity: new Date().toISOString() }] : []
    : await discoverSessions(filter);
  const sessions = await Promise.all(found.filter(s => !existing.has(`${s.backend}:${s.nativeSessionId}`)).map(async item => ({
    ...item, cwdAvailable: await stat(item.cwd).then(value => value.isDirectory(), () => false),
  })));
  res.json({ sessions });
});
app.post('/api/import', (req, res) => {
  const id = backend(req.body.backend);
  const nativeSessionId = text(req.body.nativeSessionId, '原生会话 ID', 200);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(nativeSessionId)) fail('原生会话 ID 格式无效');
  if (!demo) validateNativeId(id, nativeSessionId);
  if (!info(id).capabilities.resume) fail('这个后端尚不支持恢复会话');
  const existing = publisher.sessions().find(s => s.backend === id && s.nativeSessionId === nativeSessionId && !s.forkPending);
  if (existing) return res.json(existing);
  const title = text(req.body.title, '名称');
  let cwd: string;
  try { cwd = directory(req.body.cwd); }
  catch (cause) { throw Object.assign(cause instanceof Error ? cause : new Error('工作目录不可用'), { code: 'IMPORT_CWD_UNAVAILABLE' }); }
  const item = store.addSession({ backend: id, title, cwd, nativeSessionId, origin: 'imported', status: 'unknown', statusDetail: '已导入历史，启动后通过原生能力恢复' });
  store.activity(item.id, 'import', `导入了 ${item.title}`); broadcast(); res.status(201).json(item);
});
app.post('/api/sessions', (req, res) => {
  const id = backend(req.body.backend);
  const item = store.addSession({ backend: id, title: text(req.body.title, '名称'), cwd: directory(req.body.cwd), groupId: groupId(req.body.groupId), executionMode: executionMode(req.body.executionMode) });
  store.activity(item.id, 'create', `创建了 ${item.title}`); broadcast(); res.status(201).json(item);
});
app.patch('/api/sessions/:id', (req, res) => {
  const item = session(String(req.params.id));
  const patch: Partial<Session> = {};
  if ('title' in req.body) patch.title = text(req.body.title, '名称');
  for (const key of ['pinned', 'archived'] as const) if (key in req.body) {
    if (typeof req.body[key] !== 'boolean') fail('无效的布尔值');
    if (key === 'archived' && starting.has(item.id)) fail('会话正在启动，请稍后再归档');
    if (key === 'archived' && req.body[key] && item.running) fail('请先停止会话，再归档');
    patch[key] = req.body[key];
  }
  if ('status' in req.body) {
    const choice = req.body.status as SessionStatus;
    if (!['idle', 'waiting_input', 'waiting_approval', 'unknown'].includes(choice)) fail('不支持的手动状态');
    Object.assign(patch, { status: choice, statusSource: 'manual', statusDetail: '由你手动标记' });
  }
  const updated = store.updateSession(item.id, patch); broadcast(); res.json(updated);
});
app.post('/api/sessions/:id/read', (req, res) => { const item = store.updateSession(session(String(req.params.id)).id, { unread: 0 }); broadcast(); res.json(item); });

app.post('/api/native-event/:id', (req, res) => {
  const item = session(String(req.params.id));
  if (demo || !item.running || stopping.has(item.id) || req.body?.source !== item.backend || typeof req.query.launch !== 'string' || launchIds.get(item.id) !== req.query.launch) return res.json({ ok: true });
  const patch = nativeHookPatch(item, req.body?.payload, expectedNativeIds.get(item.id));
  if (!patch || publisher.sessions().some(other => other.id !== item.id && other.backend === item.backend && !other.forkPending && other.nativeSessionId === patch.nativeSessionId)) return res.json({ ok: true });
  if (item.backend === 'claude' && req.body?.payload?.hook_event_name === 'UserPromptSubmit') patch.claudeUnwritten = undefined;
  // Replayed Stop notifications should not repeatedly increment unread counts.
  const changed = item.status !== patch.status || item.nativeSessionId !== patch.nativeSessionId || item.forkPending;
  if (!changed) return res.json({ ok: true });
  status(item.id, { ...patch, lastActivity: new Date().toISOString() }, patch.statusDetail);
  observeNative(session(item.id));
  res.json({ ok: true });
});

app.post('/api/sessions/:id/fork', async (req, res) => {
  const parent = session(String(req.params.id));
  if (!info(parent.backend).capabilities.fork) fail('当前后端没有可用的原生 Fork 能力');
  if (!parent.nativeSessionId || parent.forkPending) fail('原生会话 ID 尚未确定，请先启动来源会话并完成初始化');
  const title = text(req.body.title || `${parent.title} · 分支`, '名称');
  const cwd = req.body.cwd ? directory(req.body.cwd) : parent.cwd;
  const targetGroupId = groupId(req.body.groupId);
  let child: Session;
  if (dshWeb(parent)) {
    const native = await dsh.forkSession(parent.nativeSessionId, cwd);
    child = store.addSession({ backend: parent.backend, title, cwd, groupId: targetGroupId, parentId: parent.id, executionMode: parent.executionMode ?? 'default', origin: 'forked', ...native, running: true, status: 'idle', statusSource: 'native', statusDetail: '已通过原生能力 Fork，点击进入' });
  } else if (parent.backend === 'codex' && !demo && info('codex').capabilities.nativeControl) {
    if (!parent.nativeSessionId || parent.forkPending) fail('Codex 原生会话 ID 尚未确定，请先启动来源会话');
    const bridge = await ensureCodexBridge();
    // Codex's native fork returns a new exact thread immediately. Persist that
    // identity before exposing the card; a failed fork never becomes a fake child.
    const native = await bridge.forkSession(parent.nativeSessionId, cwd, parent.executionMode);
    child = store.addSession({ backend: parent.backend, title, cwd, groupId: targetGroupId, parentId: parent.id, executionMode: parent.executionMode ?? 'default', origin: 'forked', nativeSessionId: native.nativeSessionId, running: false, status: 'idle', statusSource: 'native', statusDetail: '已通过 Codex 原生能力 Fork，点击进入' });
    bridge.releaseSession(native.nativeSessionId);
  } else {
    child = store.addSession({ backend: parent.backend, title, cwd, groupId: targetGroupId, parentId: parent.id, executionMode: parent.executionMode ?? 'default', origin: 'forked', nativeSessionId: demo ? `demo-${randomUUID()}` : parent.nativeSessionId, forkPending: !demo, statusDetail: demo ? '演示分支已创建' : '待启动：将调用原生 Fork，原会话保持独立' });
  }
  store.activity(child.id, 'fork', `从 ${parent.title} 分叉为 ${child.title}`); broadcast(); res.status(201).json(child);
});

app.post('/api/sessions/:id/handoff', async (req, res) => {
  const parent = session(String(req.params.id));
  const target = backend(req.body?.backend);
  if (target === parent.backend) fail('同平台请使用原生 Fork');
  const title = text(req.body?.title || `${parent.title} · ${info(target).label}`, '名称');
  const cwd = req.body?.cwd ? directory(req.body.cwd) : parent.cwd;
  const transcript = demo ? { messages: [], truncated: false } : await conversations.read(parent);
  const prompt = handoffPrompt(parent, transcript, target, typeof req.body?.summary === 'string' ? req.body.summary : undefined);
  const child = store.addSession({ backend: target, title, cwd, groupId: parent.groupId, parentId: parent.id, origin: 'handoff', statusDetail: '已创建跨平台交接联系人，等待继续工作' });
  store.activity(child.id, 'handoff', `从 ${parent.title} 交接到 ${info(target).label}`); broadcast();
  res.status(201).json({ session: child, prompt, source: parent.id, target: target });
});

app.post('/api/sessions/:id/start', async (req, res) => {
  let item = session(String(req.params.id));
  const mode = req.body?.mode ?? 'terminal';
  if (!['terminal', 'chat'].includes(mode)) fail('未知会话交互方式');
  if (mode === 'chat' && (demo || !['codex', 'claude'].includes(item.backend) || !info(item.backend).capabilities.graphicalChat)) fail('这个后端目前不支持原生图形化聊天');
  if (item.archived) fail('请先恢复归档联系人');
  if (stopping.has(item.id) || terminals.isStopping(item.id)) fail('会话正在停止，请稍后再启动', 409);
  if (starting.has(item.id)) fail('会话正在连接，请稍后重试', 409);
  // Claude cannot attach its TUI to stream-json. A confirmed, idle handoff
  // closes the current writer completely before resuming the saved identity.
  if (item.running && !demo && item.backend === 'claude') {
    const structured = claudeRuns.has(item.id);
    if ((mode === 'chat') === structured) {
      status(item.id, { interactionMode: mode, executionTransport: structured ? 'structured' : 'pty' });
      broadcast(); return res.json(session(item.id));
    }
    const snapshot = structured ? claudeBridge.chatSnapshot(item.nativeSessionId!) : undefined;
    if (!['idle', 'waiting_input'].includes(item.status) || snapshot?.activeTurnId || snapshot?.requests.length || terminals.isSubmitting(item.id)) fail('请先完成或停止当前任务，并处理审批后再切换执行方式', 409);
    if (req.body?.handoff !== true) fail('切换将退出当前 Claude 进程，并恢复同一份已保存的会话；需要确认交接', 409);
    starting.add(item.id); stopping.add(item.id);
    try {
      if (structured) await claudeBridge.closeSession(item.nativeSessionId!);
      else await terminals.stop(item.id);
      claudeRuns.delete(item.id); launchIds.delete(item.id); expectedNativeIds.delete(item.id);
      status(item.id, { running: false, status: 'stopped', statusSource: 'process', statusDetail: '旧执行者已退出，正在恢复会话' });
      item = session(item.id);
    } finally { starting.delete(item.id); stopping.delete(item.id); }
  }
  if (item.running && mode === 'terminal' && !demo && item.backend === 'codex' && codexRuns.has(item.id) && !terminals.has(item.id)) {
    if (starting.has(item.id)) fail('原生终端正在连接，请稍后重试', 409);
    starting.add(item.id);
    try {
      const executable = await findExecutable('codex');
      if (!executable) fail('未找到 Codex 原生命令');
      terminals.start(item, codexBridge.remoteLaunch(item.nativeSessionId!, executable, item.cwd));
      status(item.id, { interactionMode: 'terminal' });
      broadcast(); return res.json(session(item.id));
    } finally { starting.delete(item.id); }
  }
  if (item.running && !demo && item.backend === 'codex' && codexRuns.has(item.id)) {
    if (starting.has(item.id)) fail('会话正在连接，请稍后重试', 409);
    // Switching the preferred interface must also update group routing. An
    // already attached terminal can stay connected to the same native thread.
    if (item.interactionMode !== mode) { status(item.id, { interactionMode: mode }); broadcast(); }
    return res.json(session(item.id));
  }
  if (item.running || starting.has(item.id)) return res.json(item);
  if (item.executionMode === 'auto' && !info(item.backend).capabilities.autoMode) fail('当前后端版本不支持原生 Auto，请更新后端并刷新检测');
  if (!info(item.backend).installed) fail(`${info(item.backend).label} 尚未安装或不可用`);
  directory(item.cwd);
  starting.add(item.id);
  const launchId = randomUUID();
  launchIds.set(item.id, launchId);
  expectedNativeIds.delete(item.id);
  try {
    if (dshWeb(item)) {
      const native = item.nativeSessionId ? await dsh.openSession(item.nativeSessionId) : await dsh.createSession(item.cwd, item.title);
      // Keep the identity even if the native permission command is unavailable.
      status(item.id, { ...native, forkPending: false });
      if (item.executionMode === 'auto') await dsh.setAutoMode(native.nativeSessionId);
      status(item.id, { ...native, running: true, executionTransport: 'web', status: 'idle', statusSource: 'native', statusDetail: '原生 Web 会话已就绪', forkPending: false, lastActivity: new Date().toISOString() });
    } else if (item.backend === 'codex' && !demo && info('codex').capabilities.nativeControl) {
        const bridge = await ensureCodexBridge();
        const executable = await findExecutable('codex');
        if (!executable) fail('Codex 原生命令已不可用，请重新检测后端');
        let native;
        if (item.forkPending) {
          if (!item.nativeSessionId) fail('Codex Fork 来源 ID 尚未确定');
          native = await bridge.forkSession(item.nativeSessionId, item.cwd, item.executionMode);
        } else if (item.nativeSessionId) {
          native = await bridge.openSession(item.nativeSessionId, item.cwd, { allowCwdChange: item.origin === 'imported', executionMode: item.executionMode });
        } else {
          native = await bridge.createSession(item.cwd, item.title, item.executionMode);
        }
        // Persist native identity even if the subsequent PTY fails. Retrying
        // this card must resume the created thread instead of making another.
        status(item.id, { nativeSessionId: native.nativeSessionId, forkPending: false });
        codexRuns.set(item.id, { nativeId: native.nativeSessionId, launchId });
        status(item.id, { running: true, interactionMode: mode, executionTransport: 'structured', status: 'unknown', statusSource: 'process', statusDetail: mode === 'chat' ? '正在连接 Codex 图形化会话' : '正在连接 Codex 原生终端', lastActivity: new Date().toISOString() });
        if (mode === 'terminal') terminals.start(session(item.id), bridge.remoteLaunch(native.nativeSessionId, executable, item.cwd));
        await bridge.getStatus(native.nativeSessionId);
    } else {
      // A server shutdown may happen after stdin accepts input but before the
      // completion event. Consult native storage before reusing empty-session flags.
      if (!demo && item.backend === 'claude' && item.claudeUnwritten) {
        const saved = await conversations.readLatest({ ...item, forkPending: false });
        if (saved.messages.some(message => message.role === 'user')) {
          store.updateSession(item.id, { claudeUnwritten: undefined });
          item = session(item.id);
        }
      }
      const command: LaunchCommand = demo ? demoCommand() : await buildLaunch(item, dataDir);
      if (!demo && item.backend === 'claude') {
        // Persist the preallocated identity before the first hook/history write.
        // Reopening an empty TUI or fork must reuse its original launch shape.
        status(item.id, { nativeSessionId: command.nativeSessionId, forkPending: false, claudeUnwritten: item.claudeUnwritten ?? (!item.nativeSessionId || item.forkPending ? { sourceId: item.forkPending ? item.nativeSessionId : null } : undefined) });
        if (mode === 'chat') {
          claudeRuns.set(item.id, { nativeId: command.nativeSessionId!, launchId });
          status(item.id, { running: true, interactionMode: 'chat', executionTransport: 'structured', status: 'unknown', statusSource: 'process', statusDetail: '正在连接 Claude 流式图形会话', lastActivity: new Date().toISOString() });
          await claudeBridge.start(command.nativeSessionId!, item.cwd, command);
          store.activity(item.id, 'start', `打开了 ${item.title}`); broadcast(); return res.json(session(item.id));
        }
        const hookCommand = [process.execPath, join(root, 'server/native-hook.cjs'), `http://127.0.0.1:${port}/api/native-event/${item.id}?launch=${launchId}`, token, 'claude'].map(shellQuote).join(' ');
        const hooks = Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'Notification', 'PermissionRequest'].map(event => [event, [{ hooks: [{ type: 'command', command: hookCommand, timeout: 3 }] }]]));
        command.args.push('--settings', JSON.stringify({ hooks }));
      }
      if (!demo && item.backend === 'codex') {
        const notify = [process.execPath, join(root, 'server/native-hook.cjs'), `http://127.0.0.1:${port}/api/native-event/${item.id}?launch=${launchId}`, token, 'codex'];
        command.args.push('-c', `notify=${JSON.stringify(notify)}`);
      }
      if (command.nativeSessionId) expectedNativeIds.set(item.id, command.nativeSessionId);
      status(item.id, { running: true, interactionMode: 'terminal', executionTransport: 'pty', status: 'unknown', statusSource: 'process', statusDetail: '正在连接原生终端' });
      terminals.start(item, command);
      status(item.id, { lastActivity: new Date().toISOString() });
      observeNative(session(item.id));
      if (!demo) void resolveIdentity(item.id, new Date().toISOString(), launchId);
    }
    store.activity(item.id, 'start', `打开了 ${item.title}`); broadcast(); res.json(session(item.id));
  } catch (error) {
    if (launchIds.get(item.id) === launchId) launchIds.delete(item.id);
    expectedNativeIds.delete(item.id);
    const nativeRun = codexRuns.get(item.id);
    codexRuns.delete(item.id);
    if (nativeRun) codexBridge.releaseSession(nativeRun.nativeId);
    const claudeRun = claudeRuns.get(item.id);
    if (claudeRun) {
      await claudeBridge.closeSession(claudeRun.nativeId);
      claudeRuns.delete(item.id);
    }
    const errorCode = error instanceof Error && 'code' in error && error.code === 'NATIVE_SESSION_BUSY' ? error.code : null;
    status(item.id, { running: false, status: 'error', errorCode, statusSource: 'process', statusDetail: error instanceof Error ? error.message : '启动失败' });
    throw error;
  } finally { starting.delete(item.id); }
});
app.post('/api/sessions/:id/stop', async (req, res) => {
  const item = session(String(req.params.id));
  if (starting.has(item.id)) fail('会话正在启动，请稍后再停止');
  if (stopping.has(item.id)) fail('会话正在停止，请等待回收完成', 409);
  if (!item.running) return res.json(item);
  stopping.add(item.id);
  status(item.id, { status: 'unknown', statusSource: 'process', statusDetail: '正在停止，等待原生任务和进程退出' });
  broadcast();
  try {
    if (dshWeb(item)) {
      if (item.nativeSessionId) await dsh.stopSession(item.nativeSessionId);
      launchIds.delete(item.id);
      status(item.id, { running: false, nativeUrl: null, status: 'stopped', statusSource: 'native', statusDetail: '已取消当前原生任务，可重新进入会话' });
    } else if (item.backend === 'claude' && !demo && claudeRuns.has(item.id) && item.nativeSessionId) {
      await claudeBridge.closeSession(item.nativeSessionId);
      claudeRuns.delete(item.id); launchIds.delete(item.id); expectedNativeIds.delete(item.id);
      status(item.id, { running: false, status: 'stopped', statusSource: 'native', statusDetail: '已停止 Claude 图形会话，可恢复原生上下文' });
    } else if (item.backend === 'codex' && !demo && codexRuns.has(item.id) && item.nativeSessionId) {
      // Interrupt only this thread's active turn, then close its TUI. The
      // native session remains resumable and its approvals stay Codex-owned.
      await codexBridge.stopSession(item.nativeSessionId);
      await terminals.stop(item.id);
      codexBridge.releaseSession(item.nativeSessionId);
      codexRuns.delete(item.id); launchIds.delete(item.id); expectedNativeIds.delete(item.id);
      status(item.id, { running: false, status: 'stopped', statusSource: 'native', statusDetail: '已停止 Codex 当前任务，可重新进入会话' });
    } else {
      await terminals.stop(item.id);
      status(item.id, { running: false, status: 'stopped', statusSource: 'process', statusDetail: '已停止，可恢复原生会话' });
    }
    broadcast(); res.json(session(item.id));
  } catch (error) {
    status(item.id, { status: 'error', statusSource: 'process', statusDetail: `停止未完成：${error instanceof Error ? error.message : '请核对原生进程'}` });
    throw error;
  } finally { stopping.delete(item.id); }
});

app.post('/api/groups', (req, res) => {
  const group = store.addGroup(text(req.body.title, '群组名称'), text(req.body.goal ?? '', '共同目标', 4000, false));
  store.activity(null, 'group', `创建了群组 ${group.title}`); broadcast(); res.status(201).json(group);
});
app.patch('/api/groups/:id', (req, res) => {
  const patch: { title?: string; goal?: string } = {};
  if ('title' in req.body) patch.title = text(req.body.title, '群组名称');
  if ('goal' in req.body) patch.goal = text(req.body.goal, '共同目标', 4000, false);
  const group = store.updateGroup(String(req.params.id), patch); broadcast(); res.json(group);
});
app.get('/api/groups/:id', (req, res) => {
  if (req.query.since !== undefined && typeof req.query.since !== 'string') fail('历史版本无效');
  if (req.query.before !== undefined && typeof req.query.before !== 'string') fail('历史游标无效');
  res.json(store.groupDetail(String(req.params.id), {
    ...(req.query.before !== undefined ? { before: Number(req.query.before) } : {}),
    ...(typeof req.query.since === 'string' ? { since: req.query.since } : {}),
  }));
});
app.get('/api/groups/:id/messages/:messageId', (req, res) => {
  const message = store.message(String(req.params.messageId));
  if (!message || message.groupId !== String(req.params.id)) fail('来源消息不存在', 404);
  res.json(message);
});
app.post('/api/groups/:id/messages', (req, res) => {
  const id = String(req.params.id);
  const kind = req.body.kind ?? 'note';
  if (!['note', 'task', 'result'].includes(kind)) fail('消息类型无效');
  const ids = req.body.recipientIds ?? [];
  if (!Array.isArray(ids) || ids.length > 50 || ids.some(x => typeof x !== 'string')) fail('收件人无效');
  const senderId = req.body.senderId ? text(req.body.senderId, '来源会话') : null;
  const sourceMessageId = req.body.sourceMessageId ? text(req.body.sourceMessageId, '转交来源') : null;
  const message = store.addMessage({ groupId: id, kind, text: text(req.body.text, '消息', 30_000), recipientIds: ids, senderId, senderName: senderId ? session(senderId).title : '你', sourceMessageId });
  broadcast(); res.status(201).json(message);
});
const deliveryLocks = new Set<string>();
app.post('/api/deliveries/:id/send', async (req, res) => {
  const id = String(req.params.id);
  const delivery = store.delivery(id) || fail('投递记录不存在', 404);
  if (delivery.status !== 'pending' || deliveryLocks.has(id)) fail('消息已处理或正在处理');
  const target = session(delivery.sessionId);
  if (!target.running || target.archived) fail('请先进入并启动目标会话');
  if (stopping.has(target.id) || terminals.isStopping(target.id)) fail('目标会话正在停止');
  if (target.status === 'waiting_approval') fail('请先在原生会话中处理当前审批，再填入任务');
  const targetWeb = dshWeb(target);
  if (targetWeb && !target.nativeSessionId) fail('原生会话尚未准备好');
  const agentChat = !demo && target.interactionMode === 'chat' && (target.backend === 'codex' ? codexRuns : claudeRuns).has(target.id);
  if (!targetWeb && !agentChat && !terminals.has(target.id)) fail('会话尚未启动或已经退出');
  deliveryLocks.add(id);
  try {
    const deliveryStatus = targetWeb || agentChat ? 'sent' : 'staged';
    const pending = sendDelivery(store, id, deliveryStatus, async () => {
      if (agentChat) {
        try { await (target.backend === 'claude' ? claudeBridge : codexBridge).sendPrompt(target.nativeSessionId!, delivery.text); }
        catch (error) {
          if ((error as { deliveryUnknown?: boolean }).deliveryUnknown === false) throw new DeliveryNotAcceptedError(error instanceof Error ? error.message : 'Codex 未接收任务');
          throw error;
        }
      } else if (deliveryStatus === 'sent') await dsh.prompt(target.nativeSessionId!, delivery.text);
      else terminals.stage(target.id, delivery.text);
    });
    broadcast();
    const updated = await pending;
    store.activity(target.id, 'delivery', deliveryStatus === 'staged' ? '群组消息已填入终端，等待你按回车发送' : '群组消息已发送到原生会话');
    broadcast(); res.json(updated);
  } finally { deliveryLocks.delete(id); broadcast(); }
});
app.post('/api/deliveries/:id/resolve', (req, res) => {
  const resolution = req.body.resolution;
  if (!['confirmed', 'not_received', 'cancelled'].includes(resolution)) fail('请选择核对后的投递结果');
  const item = store.resolveDelivery(String(req.params.id), text(req.body.attemptId, '投递尝试'), resolution);
  store.activity(item.sessionId, 'delivery', resolution === 'confirmed' ? '已人工确认投递成功' : resolution === 'not_received' ? '已确认未收到，恢复待投递' : '已关闭待确认的投递');
  broadcast(); res.json(item);
});
app.post('/api/deliveries/:id/cancel', (req, res) => {
  const id = String(req.params.id);
  if (deliveryLocks.has(id)) fail('消息正在发送，请稍后再操作');
  const item = store.updateDelivery(id, 'cancelled'); broadcast(); res.json(item);
});

const identityTimers = new Set<NodeJS.Timeout>();
async function resolveIdentity(id: string, startedAt: string, launchId: string, attempt = 0) {
  if (closing || launchIds.get(id) !== launchId) return;
  const item = store.session(id);
  if (!item || !item.running || (item.nativeSessionId && !item.forkPending)) return;
  // A timestamp/cwd match is not proof of identity: another CLI may start there.
  // Claude is launched with a chosen --session-id and Codex reports its thread
  // ID through the native notification, so both must match an expected ID.
  // dsh-tui mints its own ID; the only evidence is a single new session log in
  // this contact's directory created after launch, which is what the resolver
  // already requires (one candidate, cwd equal, created at or after start).
  const expected = expectedNativeIds.get(id);
  if (!expected && item.backend !== 'dsh') return;
  try {
    const exclude = publisher.sessions().filter(s => s.id !== id && s.nativeSessionId && !s.forkPending).map(s => s.nativeSessionId!);
    const nativeSessionId = await resolveNativeSessionId(item, startedAt, exclude);
    if (closing || launchIds.get(id) !== launchId || !store.session(id)?.running) return;
    const alreadyLinked = publisher.sessions().some(other => other.id !== id && !other.forkPending && other.nativeSessionId === nativeSessionId && other.backend === item.backend);
    if (nativeSessionId && (expected ? nativeSessionId === expected : item.backend === 'dsh') && !alreadyLinked && (!item.forkPending || nativeSessionId !== item.nativeSessionId)) {
      status(id, { nativeSessionId, forkPending: false }); observeNative(session(id)); return;
    }
  } catch { /* Not persisted yet; keep the card honest and retry. */ }
  const timer = setTimeout(() => { identityTimers.delete(timer); void resolveIdentity(id, startedAt, launchId, attempt + 1); }, attempt < 30 ? 2000 : 10_000);
  identityTimers.add(timer);
}

terminals.on('data', (id: string, data: string) => {
  terminalEvent(id, { type: 'data', data });
  const item = store.session(id);
  if (item && Date.now() - Date.parse(item.lastActivity) > 2000) { store.updateSession(id, { lastActivity: new Date().toISOString() }); scheduleBroadcast(); }
});
terminals.on('hint', (id: string, hint: { status: SessionStatus; detail: string }) => {
  if (stopping.has(id) || terminals.isStopping(id)) return;
  if (session(id).statusSource === 'native') return;
  if (session(id).status !== hint.status) status(id, { status: hint.status, statusSource: 'terminal', statusDetail: hint.detail }, hint.detail);
});
terminals.on('input', (id: string, data: string) => {
  const item = session(id);
  // Claude does not emit Stop when Escape interrupts a turn or rejects a tool.
  // A key press is not proof of cancellation (it can also dismiss a menu), so
  // stop asserting the preceding execution state and wait for native evidence.
  // Escape sequences such as arrow keys and bracketed paste are not cancels.
  if (!demo && !codexRuns.has(id) && item.statusSource === 'native'
    && ['running', 'waiting_approval'].includes(item.status) && (data === '\x1b' || data === '\x03')) {
    status(id, { status: 'unknown', statusSource: 'process', statusDetail: '已发送取消键，请在原生界面确认是否中断', lastActivity: new Date().toISOString() });
    return;
  }
  // Typing in a native prompt is not evidence that its agent started a turn.
  // Keep authoritative approval/execution state until the backend changes it.
  if (session(id).statusSource !== 'native' && session(id).status !== 'unknown') status(id, { status: 'unknown', statusSource: 'process', statusDetail: '已发送输入，等待后端状态', lastActivity: new Date().toISOString() });
});
terminals.on('exit', (id: string, exitCode: number) => {
  nativeStatus.stop(id);
  launchIds.delete(id);
  expectedNativeIds.delete(id);
  const nativeRun = codexRuns.get(id);
  codexRuns.delete(id);
  // A remote TUI and its app-server have different process lifetimes. If a
  // TUI dies, interrupt its thread before releasing the observer. A restart is
  // held until that cleanup finishes, so a late interrupt cannot hit a new turn.
  if (nativeRun && !stopping.has(id)) {
    stopping.add(id);
    void codexBridge.stopSession(nativeRun.nativeId).catch(error => {
      if (!closing) status(id, { status: 'error', statusSource: 'native', statusDetail: `终端已退出，无法确认任务取消：${error instanceof Error ? error.message : '连接异常'}` });
    }).finally(() => { codexBridge.releaseSession(nativeRun.nativeId); stopping.delete(id); });
  }
  status(id, { running: false, status: exitCode === 0 ? 'stopped' : 'error', statusSource: 'process', statusDetail: `原生进程已退出（${exitCode}）` }, '会话进程已退出');
  terminalEvent(id, { type: 'exit', exitCode });
});
shells.on('data', (id: string, data: string) => terminalEvent(id, { type: 'data', data }, 'shellId'));
shells.on('exit', (id: string, exitCode: number) => terminalEvent(id, { type: 'exit', exitCode }, 'shellId'));
// A phone and a desktop can watch the same PTY. Sizing it to whichever
// viewer resized last reflows the native TUI under everyone else, so the PTY
// takes the smallest width and height among the viewers that may type.
function applySharedSize(id: string) {
  let cols = Infinity, rows = Infinity;
  for (const socket of wss.clients) {
    const client = socket as WebSocket & { sessionId?: string; size?: { cols: number; rows: number } };
    if (client.sessionId !== id || client.readyState !== WebSocket.OPEN || !client.size) continue;
    cols = Math.min(cols, client.size.cols); rows = Math.min(rows, client.size.rows);
  }
  if (Number.isFinite(cols) && Number.isFinite(rows)) terminals.resize(id, cols, rows);
}
function upgrade(req: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) {
  const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
  const voiceMatch = /^\/api\/sessions\/([^/]+)\/voice$/.exec(url.pathname);
  if (voiceMatch) {
    const remote = isRemote(req);
    const device = remote ? readCookie(req.headers.cookie, DEVICE_COOKIE) : undefined;
    const principal = remote ? auth.principal(device) : LOCAL_OWNER;
    const allowed = remote ? allowedRemoteRequest(req, remoteSettings().publicUrl, remoteSettings().localPort) : allowedRequest(req, port, wildcardHost);
    const decision = authorize(principal, remote, 'GET', url.pathname);
    const item = store.session(voiceMatch[1]!);
    if (!allowed || !decision.allowed || !principal || !validToken(url.searchParams.get('token'), auth.csrf(principal))) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    if (demo || closing || !item || item.archived) { socket.write('HTTP/1.1 409 Conflict\r\n\r\n'); socket.destroy(); return; }
    voiceWss.handleUpgrade(req, socket, head, ws => voiceConnections.attach(ws, device));
    return;
  }
  const shellMatch = /^\/api\/shells\/([^/]+)\/terminal$/.exec(url.pathname);
  if (!url.pathname.startsWith('/api/terminal/') && !shellMatch) return; // Vite owns its own HMR upgrade.
  const remote = isRemote(req);
  const device = remote ? readCookie(req.headers.cookie, DEVICE_COOKIE) : undefined;
  const principal = remote ? auth.principal(device) : LOCAL_OWNER;
  const allowed = remote ? allowedRemoteRequest(req, remoteSettings().publicUrl, remoteSettings().localPort) : allowedRequest(req, port, wildcardHost);
  // Shells are owner-only; a session terminal needs at least read access to it.
  const scope = shellMatch ? 'owner' : 'session';
  const sessionTarget = shellMatch ? null : decodeURIComponent(url.pathname.slice('/api/terminal/'.length));
  const permitted = !!principal && (principal.kind === 'owner' || (scope === 'session' && principal.sessionId === sessionTarget));
  if (!allowed || !principal || !permitted || !validToken(url.searchParams.get('token'), auth.csrf(principal))) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
  const viewer: Viewer = { principal, device };
  // Read-only shares watch the same PTY stream; their keystrokes are discarded.
  const canInput = principal.kind === 'owner' || principal.mode === 'write';
  let announced = false;
  const attribute = () => {
    if (announced || principal.kind !== 'share') return;
    announced = true;
    store.activity(principal.sessionId, 'share', `${principal.name}（分享）在终端输入`); scheduleBroadcast();
  };
  if (shellMatch) {
    const id = shellMatch[1]!;
    const shell = shells.get(id);
    if (!shell || closing) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      viewers.set(ws, viewer);
      ws.on('error', () => ws.close());
      (ws as WebSocket & { shellId: string }).shellId = id;
      ws.send(JSON.stringify({ type: 'data', data: shells.buffer(id) }));
      ws.send(JSON.stringify({ type: 'ready', terminalId: shells.generation(id), running: shell.running, exitCode: shell.exitCode }));
      ws.on('message', raw => {
        try {
          const message = JSON.parse(raw.toString());
          if (message.type === 'input' && typeof message.data === 'string' && message.data.length <= 32768) shells.input(id, message.data);
          else if (message.type === 'resize') shells.resize(id, message.cols, message.rows);
        } catch (error) { ws.send(JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : '终端输入失败' })); }
      });
    });
    return;
  }
  const id = sessionTarget!;
  if (!store.session(id)) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => {
    viewers.set(ws, viewer);
    ws.on('error', () => ws.close());
    (ws as WebSocket & { sessionId: string }).sessionId = id;
    ws.on('close', () => applySharedSize(id));
    ws.send(JSON.stringify({ type: 'data', data: terminals.buffer(id) }));
    // The browser uses this per-PTY UUID to prevent an image upload from
    // landing in a replacement process after a stop/restart race.
    ws.send(JSON.stringify({ type: 'ready', terminalId: terminals.generation(id), readOnly: !canInput }));
    ws.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === 'input' && typeof message.data === 'string' && message.data.length <= 32768) {
          if (!canInput) return;
          if (stopping.has(id)) throw new Error('会话正在停止，暂时无法输入');
          attribute();
          terminals.input(id, message.data);
        }
        else if (message.type === 'resize' && canInput && Number.isInteger(message.cols) && Number.isInteger(message.rows)) {
          (ws as WebSocket & { size?: { cols: number; rows: number } }).size = { cols: message.cols, rows: message.rows };
          applySharedSize(id);
        }
      } catch (error) { ws.send(JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : '终端输入失败' })); }
    });
  });
}
server.on('upgrade', upgrade);
remoteServer.on('upgrade', upgrade);
const viewerCheck = setInterval(revalidateViewers, 30_000);
viewerCheck.unref();

let nativePolling = false;
let nativeAgain = false;
let nativeScheduled: NodeJS.Timeout | null = null;
function scheduleNativePoll() {
  if (demo || closing) return;
  if (nativePolling) { nativeAgain = true; return; }
  if (!nativeScheduled) nativeScheduled = setTimeout(() => { nativeScheduled = null; void pollNative(); }, 100);
}
async function pollNative() {
  if (demo || closing || nativePolling) return;
  nativePolling = true;
  try {
    const pending = publisher.sessions().filter(s => s.running && !stopping.has(s.id) && s.nativeSessionId && (dshWeb(s) || codexRuns.has(s.id)))
      .map(item => ({ item, launchId: launchIds.get(item.id) }));
    const apply = ({ item, launchId }: typeof pending[number], next: { status: SessionStatus; detail?: string; attentionKey?: string }) => {
      if (closing) return;
      const current = store.session(item.id);
      if (!current?.running || stopping.has(item.id) || current.nativeSessionId !== item.nativeSessionId || launchIds.get(item.id) !== launchId) return;
      if (current.status !== next.status || current.statusDetail !== next.detail || (next.attentionKey && current.lastAttentionKey !== next.attentionKey))
        status(item.id, { status: next.status, statusSource: 'native', statusDetail: next.detail || '来自原生会话状态', lastActivity: new Date().toISOString(), ...(next.attentionKey ? { lastAttentionKey: next.attentionKey } : {}) });
    };
    const dshItems = pending.filter(({ item }) => item.backend === 'dsh');
    const codexItems = pending.filter(({ item }) => item.backend === 'codex');
    // The DSH snapshot is shared by the round; a slow backend does not block
    // other backends. Both native history and Codex recovery stay bounded.
    await Promise.all([
      (async () => {
        const statuses = await dsh.getStatuses(dshItems.map(({ item }) => item.nativeSessionId!));
        for (const entry of dshItems) apply(entry, statuses.get(entry.item.nativeSessionId!)!);
      })(),
      ...Array.from({ length: Math.min(4, codexItems.length) }, async () => {
        while (codexItems.length && !closing) {
          const entry = codexItems.shift()!;
          try { apply(entry, await codexBridge.getStatus(entry.item.nativeSessionId!)); }
          catch { /* The periodic recovery retries unavailable observers. */ }
        }
      }),
    ]);
  } finally {
    nativePolling = false;
    if (nativeAgain) { nativeAgain = false; scheduleNativePoll(); }
  }
}
dsh.onStatusChange(scheduleNativePoll);
const nativePoll = setInterval(() => { void pollNative(); }, 3000);
nativePoll.unref();

// Read saved prompts in bounded batches, independently from status and unread
// notifications. Idle contacts also refresh, so externally continued sessions
// acquire their latest input without launching or resuming a native process.
const previewChecked = new Map<string, { identity: string; at: number }>();
let previewPolling = false;
async function pollPreviews() {
  if (demo || closing || previewPolling) return;
  previewPolling = true;
  try {
    const contacts = publisher.sessions();
    const liveIds = new Set(contacts.map(item => item.id));
    for (const id of previewChecked.keys()) if (!liveIds.has(id)) previewChecked.delete(id);
    const pending = contacts.filter(item => {
      if (item.archived || item.forkPending || !item.nativeSessionId) return false;
      const checked = previewChecked.get(item.id);
      return !checked || checked.identity !== `${item.backend}:${item.nativeSessionId}` || Date.now() - checked.at >= (item.running ? 5000 : 60_000);
    }).sort((a, b) => (previewChecked.get(a.id)?.at ?? 0) - (previewChecked.get(b.id)?.at ?? 0)).slice(0, 8);
    await Promise.all(Array.from({ length: Math.min(2, pending.length) }, async () => {
      while (pending.length && !closing) {
        const item = pending.shift()!;
        previewChecked.set(item.id, { identity: `${item.backend}:${item.nativeSessionId}`, at: Date.now() });
        try { updatePreview(item, await conversations.read(item)); }
        catch { /* Native history can disappear or become temporarily unreadable. */ }
      }
    }));
  } finally { previewPolling = false; }
}
const previewPoll = setInterval(() => { void pollPreviews(); }, 5000);
previewPoll.unref();
void pollPreviews();

app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));
if (process.argv.includes('--dev')) {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({ root, server: { middlewareMode: true, hmr: { server }, allowedHosts: wildcardHost ? true : undefined }, appType: 'spa' });
  app.use(vite.middlewares);
} else {
  const dist = resolve(process.env.SESSIONDECK_CLIENT_DIR || join(root, 'dist/client'));
  if (!existsSync(join(dist, 'index.html'))) console.warn('尚未构建前端，请先 npm run build，或使用 npm run dev。');
  app.get('/manifest.webmanifest', (req, res, next) => {
    const base = isRemote(req) ? remoteBase(remoteSettings()) : '';
    if (!base) return next();
    res.type('application/manifest+json').send(remoteManifest(readFileSync(join(dist, 'manifest.webmanifest'), 'utf8'), base));
  });
  app.use(express.static(dist, { index: false }));
  app.get('/{*path}', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(remoteHtml(readFileSync(join(dist, 'index.html'), 'utf8'), isRemote(req) ? remoteBase(remoteSettings()) : ''));
  });
}
app.use((error: Error & { status?: number; code?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(error.status || 400).json({ error: error.message || '操作失败', code: error.code });
});

server.once('error', error => {
  console.error((error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请设置 SESSIONDECK_PORT 为其他端口。` : error.message);
  shutdown(1);
});
server.listen(port, host, () => {
  console.log(`Dili${demo ? ' [演示模式，不调用真实模型]' : ''} → http://${host.includes(':') ? `[${host}]` : host}:${port}\n本地数据：${dataDir}`);
  void applyRemote().then(() => {
    if (remoteServer.listening) console.log(`远程访问监听 → http://127.0.0.1:${remoteSettings().localPort}（需要登录）`);
  }).catch(error => console.error(`远程访问未启动：${error instanceof Error ? error.message : String(error)}`));
});
function shutdown(exitCode = 0) {
  if (closing) return; closing = true;
  clearInterval(nativePoll);
  clearInterval(previewPoll);
  clearInterval(viewerCheck);
  chatApi.close();
  voiceConnections.close();
  const voiceClosed = voiceEngine.close();
  for (const ws of voiceWss.clients) ws.terminate();
  if (nativeScheduled) clearTimeout(nativeScheduled);
  if (scheduled) clearTimeout(scheduled);
  for (const timer of identityTimers) clearTimeout(timer);
  terminals.removeAllListeners(); shells.removeAllListeners(); nativeStatus.close();
  for (const client of sse.keys()) client.end();
  for (const ws of wss.clients) ws.terminate();
  const httpClosed = Promise.all([
    new Promise<void>(accept => server.close(() => accept())),
    remoteServer.listening ? new Promise<void>(accept => remoteServer.close(() => accept())) : Promise.resolve(),
  ]);
  server.closeAllConnections(); remoteServer.closeAllConnections();
  // Keep the storage lease until native children and their callbacks are gone.
  // Exiting directly in server.close used to orphan a slow native process and
  // let a replacement instance race it against the same native history.
  void (async () => {
    const results = await Promise.allSettled([voiceClosed, httpClosed, tunnel.close(), frpTunnel.close(), terminals.close(), shells.close(), dsh.close(), codexBridge.close(), claudeBridge.close()]);
    for (const result of results) if (result.status === 'rejected') { console.error('关闭原生资源失败：', result.reason instanceof Error ? result.reason.message : String(result.reason)); exitCode = 1; }
    try { publisher.close(); store.close(); }
    finally { await instanceLock.release(); }
    process.exit(exitCode);
  })().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
}
process.on('SIGTERM', () => shutdown()); process.on('SIGINT', () => shutdown());
