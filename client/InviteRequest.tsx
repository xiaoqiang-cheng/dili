import { useEffect, useState } from 'react';
import { timeoutSignal } from './timeout-signal';

type Receipt = { id: string; claim: string };
type Status = { status: 'pending' | 'approved' | 'rejected'; invite?: string; inviteStatus?: string };
const KEY = 'dili.invite-request';
export default function InviteRequest() {
  const [receipt, setReceipt] = useState<Receipt | null>(() => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } });
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function call(path: string, body: object) {
    const response = await fetch(`/connect/api/requests${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: timeoutSignal(15_000) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || '申请失败'); return result;
  }
  async function refresh(value: Receipt) { setBusy(true); setError(''); try { setStatus(await call(`/${encodeURIComponent(value.id)}/status`, { claim: value.claim })); } catch (cause) { setError(cause instanceof Error ? cause.message : '查询失败'); } finally { setBusy(false); } }
  useEffect(() => { if (receipt) void refresh(receipt); }, [receipt]);
  return <section className="invite-request" aria-label="申请中继邀请码"><h2>连接，随时随地</h2><p>申请中继邀请码，将电脑上的 Dili 安全连接到手机。</p>{error && <p role="alert">{error}</p>}{receipt ? <><p role="status">{!status ? '正在查询申请…' : status.status === 'pending' ? '申请已提交，等待管理员审核。' : status.status === 'rejected' ? '本次申请未通过，可重新申请。' : status.inviteStatus === 'ready' ? '申请已通过，请复制邀请码到电脑上的机器卡片。' : `邀请码${({ used: '已使用', expired: '已过期', revoked: '已撤销' } as Record<string, string>)[status.inviteStatus || ''] || '已获批'}`}</p>{status?.invite && <label>你的邀请码<textarea readOnly rows={3} value={status.invite} onFocus={event => event.target.select()} /><button className="button secondary" onClick={() => void navigator.clipboard.writeText(status.invite!).then(() => setError('已复制')).catch(() => setError('请长按选中邀请码复制'))}>复制邀请码</button></label>}<div className="machine-actions"><button className="button secondary" disabled={busy} onClick={() => void refresh(receipt)}>刷新申请状态</button>{status?.status !== 'pending' && <button className="text-button" onClick={() => { localStorage.removeItem(KEY); setReceipt(null); setStatus(null); }}>重新申请</button>}</div></> : <form onSubmit={event => {
    event.preventDefault(); const form = new FormData(event.currentTarget); setBusy(true); setError('');
    const bytes = crypto.getRandomValues(new Uint8Array(32)); const claim = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    // The receipt is private to this browser and never placed in a URL.
    void call('', { email: form.get('email'), name: form.get('name'), claim }).then(result => { const next = { id: result.id, claim }; localStorage.setItem(KEY, JSON.stringify(next)); setReceipt(next); }).catch(cause => setError(cause.message)).finally(() => setBusy(false));
  }}><label>称呼<input name="name" autoComplete="name" required maxLength={80} placeholder="如何称呼你" /></label><label>电子邮箱<input name="email" type="email" autoComplete="email" required maxLength={254} placeholder="you@example.com" /></label><button className="button primary" disabled={busy}>{busy ? '正在提交…' : '提交申请'}</button></form>}<small>邮箱仅供管理员审核联系，当前不发送自动邮件。请保留此设备的网站数据，在这里领取结果；邮箱未进行验证。</small></section>;
}
