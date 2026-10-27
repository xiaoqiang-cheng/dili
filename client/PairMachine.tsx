import { useEffect, useRef, useState } from 'react';
import { appUrl } from './urls';
import { api } from './api';
import type { RemoteStatus } from '../shared/auth';
import { clearPairingInvite, pairingInvite } from './machine-links';

/** Runs on the target origin, so credentials never pass through the launcher. */
export default function PairMachine({ local }: { local: boolean }) {
  const [params] = useState(() => new URLSearchParams(location.hash.split('?')[1]));
  const [invite, setInvite] = useState(pairingInvite);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const request = useRef<Promise<string> | null>(null);
  let back: URL | null = null;
  try { const value = new URL(params.get('return') || ''); if (['https:', 'http:'].includes(value.protocol) && !value.username && !value.password && value.hash === '#/machines' && params.get('nonce')) back = value; } catch { /* Invalid return links never redirect. */ }
  const target = new URL(appUrl('/'), location.origin).href;
  const remote = params.get('remote') === '1';
  const returnUrl = back?.href;
  useEffect(() => {
    if (!returnUrl) return;
    if (remote && !local) { setError('首次配对只能在运行 Dili 的电脑上进行。请在该电脑的机器卡片填写邀请码。'); return; }
    if (remote && !invite) { setError('请重新填写邀请码'); return; }
    let active = true;
    request.current ??= (async () => {
      let destination = '';
      if (remote) {
        const existing = await api<RemoteStatus>('/remote');
        let status = existing.pairing && existing.settings.mode === 'invite' && existing.settings.enabled
          ? existing : await api<RemoteStatus>('/remote/pair', { invite, name: params.get('name') || 'Dili 机器' });
        const deadline = Date.now() + 45_000;
        while (status.tunnel.state === 'connecting' && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          status = await api<RemoteStatus>('/remote');
        }
        if (!status.settings.publicUrl || status.tunnel.state !== 'connected') throw new Error(status.tunnel.error || '远程连接未就绪，请稍后重试或检查机器的连接设置');
        destination = status.settings.publicUrl;
      }
      const callback = new URL(returnUrl);
      const result = new URLSearchParams({ paired: target, nonce: params.get('nonce') || '' });
      if (destination) result.set('remote', destination);
      callback.hash = `/machines?${result}`;
      return callback.href;
    })();
    void request.current.then(url => {
      if (active) { clearPairingInvite(); location.replace(url); }
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : '连接失败'); });
    return () => { active = false; };
  }, [returnUrl, target, remote, local, attempt]);
  return <main className="machines-page"><h1>{remote ? '连接远程机器' : '正在进入机器'}</h1>
    {!back ? <p role="alert">返回地址无效，请从机器列表重新添加。</p> : error ? <><p role="alert">{error}</p>{remote && local && <form onSubmit={event => { event.preventDefault(); request.current = null; setError(''); setAttempt(value => value + 1); }}><label>邀请码<input type="password" autoComplete="off" required maxLength={1600} value={invite} onChange={event => setInvite(event.target.value)} /></label><button className="button primary">重试连接</button></form>}<a href={back.href}>返回机器列表</a></> : <p role="status">{remote ? '正在准备远程连接，首次下载客户端可能需要约 90 秒…' : '验证成功，正在自动保存并进入联系人…'}</p>}
  </main>;
}
