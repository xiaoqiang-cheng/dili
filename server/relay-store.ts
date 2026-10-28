import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { encodeInvite, newSecret, secretHash, relayUrl } from './invite.ts';

/** bandwidthLimit is a frp rate such as "2MB" or "500KB"; null means the default. */
export interface RelayDevice { id: string; name: string; port: number; createdAt: string; revokedAt: string | null; lastSeenAt: string | null; connected: boolean; serverUrl?: string; bandwidthLimit?: string | null; lastLoginAt?: string | null }
/** Applied when a device has no own limit; matches what clients have always requested. */
export const DEFAULT_DEVICE_BANDWIDTH = '20MB';
const BANDWIDTH = /^([1-9]\d{0,4})(KB|MB)$/;
export function validBandwidth(value: unknown): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !BANDWIDTH.test(value.trim().toUpperCase())) fail('限速格式为数字加 KB 或 MB，例如 500KB、2MB');
  const [, amount, unit] = BANDWIDTH.exec(value.trim().toUpperCase())!;
  if (unit === 'MB' && Number(amount) > 1000) fail('限速最大 1000MB');
  return `${amount}${unit}`;
}
type DeviceRow = RelayDevice & { credentialHash: string; claimHash: string; inviteHash: string };
export type InviteRequest = { id: string; email: string; name: string; createdAt: string; status: 'pending' | 'approved' | 'rejected'; reviewedAt: string | null; inviteId?: string };
type RequestRow = InviteRequest & { claimHash: string; sealedInvite?: string };
type InviteRow = { id: string; label: string; hash: string; expiresAt: string | null; createdAt: string; usedAt: string | null; revokedAt: string | null; serverUrl?: string };
function fail(message: string, status = 400): never { throw Object.assign(new Error(message), { status }); }

/** Codes and client credentials are hashed; a redemption can be retried after a lost response. */
export class RelayStore {
  constructor(private readonly db: DatabaseSync, private readonly firstPort = 18700, private readonly lastPort = 18799) {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS relay_invites (id TEXT PRIMARY KEY, hash TEXT UNIQUE, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS relay_devices (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS relay_requests (id TEXT PRIMARY KEY, data TEXT NOT NULL);');
  }
  requests(): InviteRequest[] { return this.requestRows().map(({ claimHash: _claim, sealedInvite: _invite, ...row }) => row); }
  private requestRows(): RequestRow[] { return this.db.prepare('SELECT data FROM relay_requests ORDER BY rowid DESC').all().map(row => JSON.parse(String(row.data)) as RequestRow); }
  private saveRequest(row: RequestRow) { this.db.prepare('INSERT OR REPLACE INTO relay_requests VALUES (?, ?)').run(row.id, JSON.stringify(row)); }
  requestInvite(email: unknown, name: unknown, claim: unknown) {
    if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof name !== 'string' || !name.trim() || name.length > 80 || typeof claim !== 'string' || !/^[\w-]{43}$/.test(claim)) fail('请填写有效邮箱和称呼');
    const rows = this.requestRows();
    if (rows.filter(row => row.status === 'pending').length >= 1000 || rows.filter(row => row.email === email.trim().toLowerCase() && row.status === 'pending').length >= 3) fail('待处理申请过多，请稍后再试', 429);
    const row: RequestRow = { id: randomUUID(), email: email.trim().toLowerCase(), name: name.trim(), claimHash: secretHash(claim), createdAt: new Date().toISOString(), reviewedAt: null, status: 'pending' };
    this.saveRequest(row);
    return { id: row.id, status: row.status };
  }
  requestStatus(id: string, claim: unknown) {
    const row = this.requestRows().find(row => row.id === id);
    if (!row || typeof claim !== 'string' || row.claimHash !== secretHash(claim)) fail('申请不存在或领取凭证不正确', 404);
    const invite = row.inviteId ? this.invites().find(item => item.id === row.inviteId) : undefined;
    return { status: row.status, sealedInvite: row.sealedInvite, inviteStatus: invite ? invite.revokedAt ? 'revoked' : invite.usedAt ? 'used' : invite.expiresAt && Date.parse(invite.expiresAt) <= Date.now() ? 'expired' : 'ready' : null };
  }
  reviewRequest(id: string, approve: boolean, serverUrl: string, seal: (value: string) => string, hours: number | null = 168) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.requestRows().find(row => row.id === id);
      if (!row) fail('申请不存在', 404);
      if (row.status !== 'pending') fail('该申请已处理，请刷新查看', 409);
      if (approve) {
        const invite = this.createInvite(serverUrl, row.email.slice(0, 80), hours);
        row.inviteId = invite.id; row.sealedInvite = seal(invite.invite);
      }
      row.status = approve ? 'approved' : 'rejected'; row.reviewedAt = new Date().toISOString(); this.saveRequest(row);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  invites() { return this.db.prepare('SELECT data FROM relay_invites ORDER BY rowid DESC').all().map(row => { const { hash: _hash, ...data } = JSON.parse(String(row.data)) as InviteRow; return data; }); }
  devices(): RelayDevice[] { return this.rows().map(({ credentialHash: _credential, claimHash: _claim, inviteHash: _invite, ...row }) => ({ ...row, connected: !row.revokedAt && !!row.lastSeenAt && Date.now() - Date.parse(row.lastSeenAt) < 20_000 })); }
  private rows(): DeviceRow[] { return this.db.prepare('SELECT data FROM relay_devices').all().map(row => JSON.parse(String(row.data)) as DeviceRow); }
  private save(row: DeviceRow) { this.db.prepare('INSERT OR REPLACE INTO relay_devices VALUES (?, ?)').run(row.id, JSON.stringify(row)); }
  createInvite(serverUrl: string, label: string, hours: number | null) {
    if ((hours !== null && (!Number.isInteger(hours) || hours < 1 || hours > 168)) || typeof label !== 'string' || label.length > 80) fail('备注最多 80 字，有效期为 1–168 小时或永不过期');
    const secret = newSecret();
    const row: InviteRow = { id: randomUUID(), label: label.trim(), hash: secretHash(secret), createdAt: new Date().toISOString(), expiresAt: hours === null ? null : new Date(Date.now() + hours * 3600_000).toISOString(), usedAt: null, revokedAt: null, serverUrl: relayUrl(serverUrl) };
    this.db.prepare('INSERT INTO relay_invites VALUES (?, ?, ?)').run(row.id, row.hash, JSON.stringify(row));
    return { invite: encodeInvite(serverUrl, secret), id: row.id, expiresAt: row.expiresAt };
  }
  revokeInvite(id: string) {
    const result = this.db.prepare('SELECT data FROM relay_invites WHERE id=?').get(id);
    if (!result) fail('邀请码不存在', 404);
    const row = JSON.parse(String(result.data)) as InviteRow;
    row.revokedAt ??= new Date().toISOString();
    this.db.prepare('UPDATE relay_invites SET data=? WHERE id=?').run(JSON.stringify(row), id);
  }
  redeem(secret: string, claim: string, credential: string, name: string, requestedUrl?: string): RelayDevice {
    if (![secret, claim, credential].every(value => typeof value === 'string' && /^[\w-]{43}$/.test(value)) || typeof name !== 'string' || !name.trim() || name.length > 80) fail('配对参数无效');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const hash = secretHash(secret), result = this.db.prepare('SELECT data FROM relay_invites WHERE hash=?').get(hash);
      if (!result) fail('邀请码无效或已撤销', 401);
      const invite = JSON.parse(String(result.data)) as InviteRow;
      const selectedUrl = invite.serverUrl ?? (requestedUrl ? relayUrl(requestedUrl) : undefined);
      if (requestedUrl && selectedUrl !== relayUrl(requestedUrl)) fail('邀请码与所选中继地址不匹配', 409);
      if (invite.revokedAt) fail('邀请码已撤销', 410);
      const existing = this.rows().find(row => row.inviteHash === hash);
      if (existing && existing.claimHash === secretHash(claim) && existing.credentialHash === secretHash(credential) && !existing.revokedAt) {
        if (existing.serverUrl && requestedUrl && existing.serverUrl !== relayUrl(requestedUrl)) fail('设备已绑定其他中继地址', 409);
        if (!existing.serverUrl && selectedUrl) this.save({ ...existing, serverUrl: selectedUrl });
        this.db.exec('COMMIT'); return this.device(existing.id)!;
      }
      if (invite.usedAt) fail('邀请码已被使用，请生成新的邀请码', 409);
      if (invite.expiresAt && Date.parse(invite.expiresAt) <= Date.now()) fail('邀请码已过期，请生成新的邀请码', 410);
      // Never reuse a revoked port while an old client could still be draining.
      const used = new Set(this.rows().map(row => row.port));
      let port = this.firstPort;
      while (used.has(port) && port <= this.lastPort) port++;
      if (port > this.lastPort) fail('服务器设备名额已满', 409);
      const now = new Date().toISOString();
      const row: DeviceRow = { id: randomBytesId(), name: name.trim(), port, createdAt: now, revokedAt: null, lastSeenAt: null, connected: false, credentialHash: secretHash(credential), claimHash: secretHash(claim), inviteHash: hash, ...(selectedUrl ? { serverUrl: selectedUrl } : {}) };
      this.save(row); invite.usedAt = now;
      this.db.prepare('UPDATE relay_invites SET data=? WHERE id=?').run(JSON.stringify(invite), invite.id);
      this.db.exec('COMMIT'); return this.device(row.id)!;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  device(id: string) { return this.devices().find(row => row.id === id) ?? null; }
  authenticate(id: unknown, credential: unknown) {
    if (typeof id !== 'string' || typeof credential !== 'string') return null;
    const row = this.rows().find(row => row.id === id && !row.revokedAt && row.credentialHash === secretHash(credential));
    return row ? this.device(row.id) : null;
  }
  seen(id: string, login = false) { const row = this.rows().find(item => item.id === id); if (row && !row.revokedAt) { row.lastSeenAt = new Date().toISOString(); if (login) row.lastLoginAt = row.lastSeenAt; this.save(row); } }
  setBandwidth(id: string, value: unknown) {
    const row = this.rows().find(item => item.id === id);
    if (!row) fail('设备不存在', 404);
    if (row.revokedAt) fail('设备已撤销', 409);
    row.bandwidthLimit = validBandwidth(value); this.save(row);
    return this.device(id)!;
  }
  /** One-shot: the device's next heartbeat is rejected so frpc reconnects and the
   * relay re-applies its current limit. Cleared when that rejection is sent. */
  requestReconnect(id: string) {
    const row = this.rows().find(item => item.id === id);
    if (!row || row.revokedAt) fail('设备不存在或已撤销', 404);
    this.reconnects.add(id);
  }
  takeReconnect(id: string) { return this.reconnects.delete(id); }
  private reconnects = new Set<string>();
  revokeDevice(id: string) { const row = this.rows().find(item => item.id === id); if (!row) fail('设备不存在', 404); row.revokedAt ??= new Date().toISOString(); this.save(row); }
}
const randomBytesId = () => newSecret().slice(0, 16).toLowerCase().replace(/_/g, 'x').replace(/-/g, 'y');
