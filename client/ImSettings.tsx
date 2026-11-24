import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Bot, KeyRound, Link2, LoaderCircle, LogOut, MessageCircle, QrCode, RefreshCw, Unplug } from 'lucide-react';
import type { ImChannelState, ImStatus } from '../shared/im';
import { t, type MessageKey } from '../shared/i18n';
import { api } from './api';
import qrcode from './vendor/qrcode';

const STATE: Record<ImChannelState['state'], MessageKey> = { off: 'im.state.off', login: 'im.state.login', connecting: 'im.state.connecting', connected: 'im.state.connected', paused: 'im.state.paused', error: 'im.state.error' };
const badge = (state: ImChannelState['state']) => state === 'connected' ? 'running' : state === 'error' || state === 'paused' ? 'error' : 'idle';

function Qr({ value }: { value: string }) {
  const svg = useMemo(() => { const qr = qrcode(0, 'M'); qr.addData(value); qr.make(); return qr.createSvgTag({ scalable: true, margin: 4 }); }, [value]);
  return <div className="im-qr" role="img" aria-label={t('im.weixin.qrLabel')} dangerouslySetInnerHTML={{ __html: svg }} />;
}

function Binding({ kind, channel, local, run }: { kind: 'feishu' | 'weixin'; channel: ImChannelState; local: boolean; run: (key: string, action: () => Promise<unknown>, done?: string) => void }) {
  return <div className="im-binding">
    <p className="form-note">{channel.owners ? t('im.owners', { count: channel.owners }) : t(kind === 'weixin' ? 'im.weixin.noOwner' : 'im.feishu.noOwner')}{channel.chats.length ? ` · ${t('im.chats', { topics: channel.chats.map(chat => chat.topic).join('、') })}` : ''}</p>
    {channel.pairCode && <p className="im-pair-code"><KeyRound size={14} />{t('im.pairCode', { code: channel.pairCode.code })}</p>}
    {local && <div className="setup-actions">
      {kind === 'feishu' && <button className="button secondary small-button" onClick={() => run(`pair:${kind}`, () => api(`/im/${kind}/pair`, {}))}><KeyRound size={13} />{t('im.newPairCode')}</button>}
      {channel.owners > 0 && <button className="text-button" onClick={() => { if (window.confirm(t('im.unbindConfirm'))) run(`unbind:${kind}`, () => api(`/im/${kind}/owners`, {}, 'DELETE'), t('im.unbound')); }}><Unplug size={13} />{t('im.unbind')}</button>}
    </div>}
  </div>;
}

/** WeChat ClawBot and Feishu bots: talk to 嘀哩 from IM. */
export default function ImSettings({ local, notify }: { local: boolean; notify: (text: string) => void }) {
  const [status, setStatus] = useState<ImStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [verify, setVerify] = useState('');
  const load = useCallback(async () => { const next = await api<ImStatus>('/im'); setStatus(next); setAppId(current => current || next.feishu.appId || ''); }, []);
  useEffect(() => {
    void load().catch(cause => setError(cause instanceof Error ? cause.message : t('im.loadFailed')));
    // A pending QR login and connection states change on the server: follow them.
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load().catch(() => {}); }, 2500);
    return () => window.clearInterval(timer);
  }, [load]);
  const run = (key: string, action: () => Promise<unknown>, done?: string) => {
    setBusy(key); setError('');
    void action().then(() => { if (done) notify(done); return load(); }).catch(cause => setError(cause instanceof Error ? cause.message : t('im.failed'))).finally(() => setBusy(''));
  };
  const saveFeishu = (event: FormEvent, enabled: boolean) => {
    event.preventDefault();
    run('feishu', async () => { await api('/im/feishu', { appId: appId.trim(), ...(appSecret ? { appSecret } : {}), enabled }); setAppSecret(''); }, t(enabled ? 'im.feishu.saved' : 'im.feishu.disabled'));
  };
  if (!status) return <section className="backend-setting-card im-settings" aria-label={t('im.title')}><div className="backend-setting-title"><MessageCircle size={20} /><div><h2>{t('im.title')}</h2><p>{error || t('im.loading')}</p></div></div></section>;
  const { feishu, weixin, coordinator } = status;
  return <section className="backend-setting-card im-settings" aria-label={t('im.title')}>
    <div className="backend-setting-title"><MessageCircle size={20} /><div><h2>{t('im.title')}</h2><p>{t('im.subtitle')}</p></div></div>
    <p className={`form-note${coordinator ? '' : ' form-error'}`}><Bot size={14} />{coordinator ? t('im.coordinatorReady', { model: coordinator.model, source: coordinator.source === 'dsh' ? 'DeepSeek Harness' : 'Pi' }) : t('im.coordinatorMissing')}</p>
    {error && <p role="alert" className="form-error">{error}</p>}
    {!local && <p className="backend-note">{t('im.localOnly')}</p>}

    <h3>{t('im.weixin.title')} <span className={`status-badge ${badge(weixin.state)}`}><i />{t(STATE[weixin.state])}</span></h3>
    <p className="form-note">{t('im.weixin.note')}</p>
    {weixin.error && <p className="form-error">{weixin.error}</p>}
    {weixin.state === 'login' && weixin.qr ? <div className="im-login">
      <Qr value={weixin.qr} />
      <div>
        <p><strong>{t(weixin.login === 'scaned' ? 'im.weixin.scanned' : 'im.weixin.scan')}</strong></p>
        <p className="form-note">{t('im.weixin.scanHint')}</p>
        {weixin.login === 'need_verifycode' && <form className="setup-form" onSubmit={event => { event.preventDefault(); run('verify', () => api('/im/weixin/verify', { code: verify.trim() })); setVerify(''); }}>
          <label>{t('im.weixin.verify')}<input inputMode="numeric" value={verify} onChange={event => setVerify(event.target.value)} maxLength={12} autoFocus /></label>
          <button className="button primary small-button" disabled={!verify.trim()}>{t('im.weixin.submit')}</button>
        </form>}
        {local && <button className="text-button" onClick={() => run('cancel', () => api('/im/weixin/login', {}, 'DELETE'))}>{t('im.cancel')}</button>}
      </div>
    </div> : local && <div className="setup-actions">
      <button className="button secondary small-button" disabled={!!busy} onClick={() => run('login', () => api('/im/weixin/login', {}))}>{busy === 'login' ? <LoaderCircle size={13} className="spin" /> : <QrCode size={13} />}{t(weixin.state === 'off' ? 'im.weixin.login' : 'im.weixin.relogin')}</button>
      {weixin.state !== 'off' && <button className="text-button" disabled={!!busy} onClick={() => { if (window.confirm(t('im.weixin.logoutConfirm'))) run('logout', () => api('/im/weixin', {}, 'DELETE'), t('im.weixin.loggedOut')); }}><LogOut size={13} />{t('im.weixin.logout')}</button>}
    </div>}
    {weixin.state !== 'off' && weixin.state !== 'login' && <Binding kind="weixin" channel={weixin} local={local} run={run} />}

    <h3>{t('im.feishu.title')} <span className={`status-badge ${badge(feishu.state)}`}><i />{t(STATE[feishu.state])}</span>{feishu.botName && <small className="muted"> · {feishu.botName}</small>}</h3>
    <p className="form-note">{t('im.feishu.note')}</p>
    {feishu.error && <p className="form-error">{feishu.error}</p>}
    {local && <form className="setup-form" onSubmit={event => saveFeishu(event, true)}>
      <label>App ID<input value={appId} onChange={event => setAppId(event.target.value)} placeholder="cli_…" maxLength={100} autoComplete="off" /></label>
      <label>App Secret<input type="password" value={appSecret} onChange={event => setAppSecret(event.target.value)} placeholder={feishu.appId ? t('im.feishu.secretKept') : ''} maxLength={200} autoComplete="new-password" /></label>
      <div className="setup-actions">
        <button className="button primary small-button" disabled={!!busy || !appId.trim() || (!appSecret && !feishu.appId)}>{busy === 'feishu' ? <LoaderCircle size={13} className="spin" /> : <Link2 size={13} />}{t(feishu.state === 'off' ? 'im.feishu.connect' : 'im.feishu.reconnect')}</button>
        {feishu.state !== 'off' && <button type="button" className="text-button" disabled={!!busy} onClick={event => saveFeishu(event, false)}><Unplug size={13} />{t('im.feishu.disconnect')}</button>}
        {feishu.appId && <button type="button" className="text-button" disabled={!!busy} onClick={() => { if (window.confirm(t('im.feishu.removeConfirm'))) run('remove', () => api('/im/feishu', {}, 'DELETE'), t('im.feishu.removed')); }}>{t('im.feishu.remove')}</button>}
      </div>
    </form>}
    {feishu.appId && <Binding kind="feishu" channel={feishu} local={local} run={run} />}
    <details className="im-help"><summary>{t('im.feishu.setupTitle')}</summary><ol>
      <li>{t('im.feishu.step1')}</li><li>{t('im.feishu.step2')}</li><li>{t('im.feishu.step3')}</li><li>{t('im.feishu.step4')}</li><li>{t('im.feishu.step5')}</li>
    </ol></details>
    <details className="im-help"><summary>{t('im.commandsTitle')}</summary><p className="form-note im-commands">{t('im.commands')}</p></details>
    <button className="text-button" onClick={() => void load().catch(() => {})}><RefreshCw size={13} />{t('im.refresh')}</button>
  </section>;
}
