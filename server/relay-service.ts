import express from 'express';
import type { RelayBandwidth } from './relay-bandwidth.ts';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DEFAULT_DEVICE_BANDWIDTH, RelayStore } from './relay-store.ts';
import { NOTICE_MAX_LENGTH, RelayNotices } from './relay-notices.ts';
import { validToken } from './security.ts';
import { relayUrl } from './invite.ts';
import { FRP_ARCHIVE_HASHES, frpArchive } from '../shared/frp.ts';

export interface RelayOptions { serverUrl: string; domains?: string[]; adminToken: string; pluginToken: string; adminHtml: string; clientsDir?: string; bandwidth?: RelayBandwidth; notices?: RelayNotices; noticeWaitMs?: number }
export function createRelayApp(store: RelayStore, options: RelayOptions) {
  const app = express(), serverUrl = relayUrl(options.serverUrl);
  const notices = options.notices ?? new RelayNotices(), noticeWaitMs = options.noticeWaitMs ?? 25_000;
  const defaultUrl = new URL(serverUrl), domainUrls = new Map<string, string>();
  for (const value of [serverUrl, ...(options.domains ?? [])]) {
    const raw = String(value).trim();
    const candidate = raw.includes('://') || raw === defaultUrl.hostname || raw === defaultUrl.host
      ? (raw.includes('://') ? relayUrl(raw) : serverUrl)
      : relayUrl(`https://${raw}/connect`);
    domainUrls.set(new URL(candidate).host, candidate);
  }
  const domains = [...domainUrls.keys()];
  app.disable('x-powered-by');
  app.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY'); next(); });
  app.use(express.json({ limit: '16kb' }));
  function rateLimiter() {
    const failures = new Map<string, { count: number; until: number }>();
    const handler: express.RequestHandler = (req, res, next) => {
    const now = Date.now(), key = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).slice(0, 100);
    for (const [key, row] of failures) if (row.until <= now) failures.delete(key);
    const row = failures.get(key) ?? { count: 0, until: now + 60_000 };
    if (row.count >= 20 || [...failures.values()].reduce((sum, item) => sum + item.count, 0) >= 200) return res.status(429).json({ error: '尝试次数过多，请稍后重试' });
    row.count++; failures.set(key, row); next();
  };
    return handler;
  }
  const limit = rateLimiter(), requestLimit = rateLimiter();
  const encryptionKey = createHash('sha256').update(options.adminToken).digest();
  const seal = (value: string) => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  };
  const unseal = (value: string) => { const data = Buffer.from(value, 'base64url'), cipher = createDecipheriv('aes-256-gcm', encryptionKey, data.subarray(0, 12)); cipher.setAuthTag(data.subarray(12, 28)); return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8'); };
  app.post('/connect/api/requests', requestLimit, (req, res) => res.status(201).json(store.requestInvite(req.body.email, req.body.name, req.body.claim)));
  app.post('/connect/api/requests/:id/status', requestLimit, (req, res) => {
    const { sealedInvite, ...status } = store.requestStatus(String(req.params.id), req.body.claim);
    res.json({ ...status, ...(sealedInvite && status.inviteStatus === 'ready' ? { invite: unseal(sealedInvite) } : {}) });
  });
  app.get('/connect/', (_req, res) => res.type('html').send(readFileSync(options.adminHtml, 'utf8')));
  app.get('/connect/health', (_req, res) => res.json({ ok: true }));
  // Only pinned official archives are served; clients independently verify SHA-256.
  const archives = new Set(Object.keys(FRP_ARCHIVE_HASHES).map(frpArchive));
  app.get('/connect/clients/:archive', (req, res) => {
    const archive = String(req.params.archive);
    if (!options.clientsDir || !archives.has(archive)) return res.status(404).json({ error: '客户端安装包不可用' });
    res.sendFile(archive, { root: options.clientsDir, dotfiles: 'deny' }, error => {
      if (error && !res.headersSent) res.status(404).json({ error: '客户端安装包不可用，请使用备用下载源' });
    });
  });
  app.post('/connect/api/redeem', limit, (req, res) => {
    // Only configured addresses are accepted. Never trust forwarded host headers.
    const requestedUrl = req.body.serverUrl === undefined
      ? (domainUrls.get(req.get('host') ?? '') ?? serverUrl) : relayUrl(req.body.serverUrl);
    if (![...domainUrls.values()].includes(requestedUrl)) return res.status(400).json({ error: '中继地址未在服务器白名单中' });
    const device = store.redeem(req.body.secret, req.body.claim, req.body.credential, req.body.name, requestedUrl);
    const selectedUrl = device.serverUrl ?? requestedUrl;
    res.json({ deviceId: device.id, name: device.name, serverUrl: selectedUrl, publicUrl: `${selectedUrl}/d/${device.id}`, serverPort: device.port, pairedAt: device.createdAt });
  });
  app.post('/connect/api/devices/:id/revoke', limit, (req, res) => {
    const device = store.authenticate(String(req.params.id), req.headers.authorization?.replace(/^Bearer /, ''));
    if (!device) return res.status(401).json({ error: '设备凭证已失效' });
    store.revokeDevice(device.id); notices.forget(device.id); res.json({ ok: true });
  });
  // A paired device long-polls here with its own credential; `after` acknowledges
  // what it has already shown. Not rate limited: it is called continuously, and the
  // credential is a 256-bit secret.
  app.get('/connect/api/devices/:id/notices', async (req, res) => {
    const device = store.authenticate(String(req.params.id), req.headers.authorization?.replace(/^Bearer /, ''));
    if (!device) return res.status(401).json({ error: '设备凭证已失效' });
    const after = Number(req.query.after);
    const aborted = new AbortController();
    res.on('close', () => aborted.abort());
    const list = await notices.take(device.id, Number.isSafeInteger(after) && after > 0 ? after : 0, noticeWaitMs, aborted.signal);
    if (!res.headersSent && !aborted.signal.aborted) res.json({ notices: list });
  });
  app.use('/connect/api/admin', limit, (req, res, next) => {
    if (!validToken(req.headers.authorization?.replace(/^Bearer /, ''), options.adminToken)) return res.status(401).json({ error: '管理密钥不正确' });
    next();
  });
  app.get('/connect/api/admin/bandwidth', (_req, res) => res.json(options.bandwidth?.snapshot() ?? { available: false, error: '带宽采样未启用', history: [], current: null }));
  app.get('/connect/api/admin/state', (_req, res) => res.json({
    devices: store.devices().map(device => ({ ...device, publicUrl: `${device.serverUrl ?? serverUrl}/d/${device.id}`, effectiveBandwidth: device.bandwidthLimit ?? DEFAULT_DEVICE_BANDWIDTH, pendingNotices: notices.pending(device.id).length })),
    invites: store.invites(), requests: store.requests(), domains, defaultBandwidth: DEFAULT_DEVICE_BANDWIDTH,
  }));
  app.post('/connect/api/admin/requests/:id/review', (req, res) => {
    if (typeof req.body.approve !== 'boolean') return res.status(400).json({ error: '审批参数无效' });
    const selectedUrl = domainUrls.get(req.body.domain || domains[0]);
    if (!selectedUrl) return res.status(400).json({ error: '指定域名未在中继服务白名单中' });
    store.reviewRequest(String(req.params.id), req.body.approve, selectedUrl, seal, req.body.permanent === true ? null : req.body.hours ?? 168);
    res.json({ ok: true });
  });
  app.post('/connect/api/admin/invites', (req, res) => {
    const hours = req.body.permanent === true ? null : req.body.hours ?? 24;
    const domain = typeof req.body.domain === 'string' && req.body.domain.trim() ? req.body.domain.trim() : domains[0];
    const selectedUrl = domainUrls.get(domain);
    if (!selectedUrl) return res.status(400).json({ error: '指定域名未在中继服务白名单中' });
    res.status(201).json(store.createInvite(selectedUrl, req.body.label ?? '', hours));
  });
  app.delete('/connect/api/admin/invites/:id', (req, res) => { store.revokeInvite(String(req.params.id)); res.json({ ok: true }); });
  app.delete('/connect/api/admin/devices/:id', (req, res) => { store.revokeDevice(String(req.params.id)); notices.forget(String(req.params.id)); res.json({ ok: true }); });
  app.post('/connect/api/admin/devices/:id/notices', (req, res) => {
    const device = store.device(String(req.params.id));
    if (!device) return res.status(404).json({ error: '设备不存在' });
    if (device.revokedAt) return res.status(409).json({ error: '设备已撤销' });
    const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
    if (!text || text.length > NOTICE_MAX_LENGTH) return res.status(400).json({ error: `通知内容为 1–${NOTICE_MAX_LENGTH} 字` });
    res.status(201).json({ notice: notices.push(device.id, text), pending: notices.pending(device.id).length, connected: device.connected });
  });
  // A new limit applies when the device's tunnel reconnects; "apply now" forces that.
  app.patch('/connect/api/admin/devices/:id', (req, res) => {
    const id = String(req.params.id);
    let device = store.device(id);
    if ('note' in req.body) device = store.setNote(id, req.body.note);
    if ('bandwidthLimit' in req.body) {
      device = store.setBandwidth(id, req.body.bandwidthLimit);
      if (req.body.applyNow === true && device.connected) store.requestReconnect(device.id);
    }
    if (!device) return res.status(404).json({ error: '设备不存在' });
    res.json(device);
  });

  // Only Caddy and frps on this machine reach these paths; neither is publicly routed.
  app.get('/internal/route', (req, res) => {
    const path = String(req.headers['x-forwarded-uri'] ?? '');
    const match = /^\/connect\/d\/([a-z0-9]{16})(?:\/|\?|$)/.exec(path);
    const device = match && store.device(match[1]!);
    if (!device || device.revokedAt) return res.status(410).send('远程设备不存在或已撤销');
    const deviceOrigin = new URL(device.serverUrl || serverUrl);
    res.setHeader('X-Dili-Device-Host', deviceOrigin.host);
    res.setHeader('X-Dili-Device-Origin', deviceOrigin.origin);
    res.setHeader('X-SessionDeck-Upstream', `127.0.0.1:${device.port}`);
    res.setHeader('X-SessionDeck-Prefix', `/connect/d/${device.id}`);
    res.sendStatus(200);
  });
  app.post('/internal/frp/:token', (req, res) => {
    if (!validToken(String(req.params.token), options.pluginToken)) return res.sendStatus(403);
    const content = req.body?.content;
    if (!content || typeof content !== 'object') return res.status(400).json({ reject: true });
    const op = req.query.op;
    const user = op === 'Login' ? content : content.user;
    const device = store.authenticate(user?.user, user?.metas?.credential);
    let allowed = !!device;
    if (op === 'NewProxy') allowed &&= content.proxy_type === 'tcp' && content.proxy_name === `${device!.id}.web` && content.remote_port === device!.port && !content.group;
    if (!['Login', 'NewProxy', 'Ping', 'NewWorkConn'].includes(String(op))) allowed = false;
    if (allowed && op === 'Ping' && store.takeReconnect(device!.id)) return res.json({ reject: true, reject_reason: 'relay settings changed, reconnecting' });
    if (allowed && (op === 'Login' || op === 'Ping')) store.seen(device!.id, op === 'Login');
    // The relay, not the client, decides the device's rate: its own limit or the default.
    if (allowed && op === 'NewProxy') return res.json({ reject: false, unchange: false, content: { ...content, bandwidth_limit: device!.bandwidthLimit ?? DEFAULT_DEVICE_BANDWIDTH, bandwidth_limit_mode: 'server' } });
    res.json(allowed ? { reject: false, unchange: true } : { reject: true, reject_reason: 'invalid device credential or revoked device' });
  });
  app.use((_req, res) => res.status(404).json({ error: '接口不存在' }));
  app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status || 400).json({ error: error.message || '请求失败' }));
  return app;
}
