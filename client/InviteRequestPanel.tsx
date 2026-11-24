import { useCallback, useEffect, useState } from 'react';
import { Check, LoaderCircle, Mail, RefreshCw, Undo2 } from 'lucide-react';
import { t } from '../shared/i18n';
import { api } from './api';

type RequestState = {
  email: string; name: string; createdAt: string; serverUrl: string;
  status: 'pending' | 'approved' | 'rejected' | 'unknown';
  inviteStatus: 'ready' | 'used' | 'expired' | 'revoked' | null;
  invite?: string; error?: string;
};
const POLL_MS = 60_000;

/** Asks the official relay for an invite from this machine. Once approved the code
 * fills the pairing form below; it never has to travel between devices. */
export default function InviteRequestPanel({ onInvite }: { onInvite: (invite: string) => void }) {
  const [request, setRequest] = useState<RequestState | null | undefined>(undefined);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const check = useCallback(async () => {
    const result = await api<{ request: RequestState | null; error?: string }>('/remote/invite-request');
    setRequest(result.request);
    if (result.error) setError(result.error);
  }, []);
  useEffect(() => { void check().catch(cause => setError(cause instanceof Error ? cause.message : t('invite.checkFailed'))); }, [check]);
  // While waiting for review, look again now and then, and on returning to the page.
  useEffect(() => {
    if (request?.status !== 'pending') return;
    const again = () => { if (document.visibilityState === 'visible') void check().catch(() => {}); };
    const timer = window.setInterval(again, POLL_MS);
    document.addEventListener('visibilitychange', again);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', again); };
  }, [request?.status, check]);
  const run = async (key: string, operation: () => Promise<void>) => {
    setBusy(key); setError('');
    try { await operation(); } catch (cause) { setError(cause instanceof Error ? cause.message : t('invite.checkFailed')); } finally { setBusy(''); }
  };
  const withdraw = () => run('withdraw', async () => { await api('/remote/invite-request', {}, 'DELETE'); setRequest(null); });

  if (request === undefined) return null;
  const errorLine = (error || request?.error) && <p role="alert" className="form-error">{error || request?.error}</p>;
  if (!request) return <details className="invite-request-panel" open={!!error}>
    <summary><Mail size={14} />{t('invite.ask')}</summary>
    <p className="form-note">{t('invite.askNote')}</p>
    <form className="invite-request-form" onSubmit={event => { event.preventDefault(); void run('submit', async () => { setRequest((await api<{ request: RequestState }>('/remote/invite-request', { email: email.trim(), name: name.trim() })).request); }); }}>
      <label className="form-label">{t('invite.name')}<input value={name} onChange={event => setName(event.target.value)} maxLength={80} required autoComplete="name" /></label>
      <label className="form-label">{t('invite.email')}<input type="email" value={email} onChange={event => setEmail(event.target.value)} maxLength={254} required autoComplete="email" placeholder="you@example.com" /></label>
      <button className="button secondary small-button" disabled={!!busy || !email.trim() || !name.trim()}>{busy === 'submit' ? <LoaderCircle size={13} className="spin" /> : <Mail size={13} />}{t('invite.submit')}</button>
    </form>
    {errorLine}
  </details>;

  const ready = request.status === 'approved' && request.invite;
  const message = ready ? t('invite.ready')
    : request.status === 'pending' ? t('invite.pending', { email: request.email })
    : request.status === 'rejected' ? t('invite.rejected')
    : request.status === 'approved' ? t(request.inviteStatus === 'used' ? 'invite.used' : request.inviteStatus === 'revoked' ? 'invite.revoked' : 'invite.expired')
    : t('invite.unknown');
  const finished = request.status === 'rejected' || (request.status === 'approved' && !ready);
  return <div className="invite-request-panel" role="status">
    <p><strong>{t('invite.title')}</strong> · {message}</p>
    <div className="invite-actions">
      {ready && <button type="button" className="button primary small-button" onClick={() => onInvite(request.invite!)}><Check size={13} />{t('invite.fill')}</button>}
      {!ready && !finished && <button type="button" className="button secondary small-button" disabled={!!busy} onClick={() => void run('check', check)}>{busy === 'check' ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}{t('invite.check')}</button>}
      <button type="button" className="text-button" disabled={!!busy} onClick={() => void withdraw()}><Undo2 size={13} />{t(finished ? 'invite.again' : 'invite.withdraw')}</button>
    </div>
    {errorLine}
  </div>;
}
