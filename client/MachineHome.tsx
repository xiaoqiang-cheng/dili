import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Plus, Monitor, Trash2, ArrowLeft } from 'lucide-react';
import AuthGate from './AuthGate';
import InstallApp from './InstallApp';
import InviteRequest from './InviteRequest';
import QrScanner from './QrScanner';
import DeviceQr from './DeviceQr';
import { api } from './api';
import type { RemoteStatus } from '../shared/auth';
import { capturePairingInvite, openMachine, publicMachineUrl, preferredMachineUrl } from './machine-links';
import { appUrl } from './urls';
import './machines.css';

import { readMachines, machineUrl, type Machine } from './machine-store';
export { machineUrl } from './machine-store';
const KEY = 'dili.machines.v1';
export default function MachineRoot() {
  capturePairingInvite();
  const [hash, setHash] = useState(() => {
    if (!location.hash && document.querySelector('meta[name="dili-launcher"]')) location.hash = '/machines';
    return location.hash;
  });
  useEffect(() => { const change = () => setHash(location.hash); window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change); }, []);
  if (hash.startsWith('#/machines')) return <MachineHome />;
  return <AuthGate />;
}
function MachineHome() {
  const [machines, setMachines] = useState(readMachines);
  const [adding, setAdding] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [remote, setRemote] = useState<RemoteStatus | null>(null);
  const [url, setUrl] = useState('');
  const [localUrl, setLocalUrl] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [connecting, setConnecting] = useState(false);
  const handledCallback = useRef(false);
  const launcher = !!document.querySelector('meta[name="dili-launcher"]');
  const current = new URL(appUrl('/'), location.origin).href;
  const cards = !launcher && !machines.some(item => item.url === current) ? [{ url: current, name: '当前机器' }, ...machines] : machines;
  const persist = (next: Machine[]) => {
    try { localStorage.setItem(KEY, JSON.stringify(next)); setMachines(next); return true; }
    catch { setError('浏览器无法保存机器列表，请允许网站存储后重试。'); return false; }
  };
  useEffect(() => {
    const sync = () => setMachines(readMachines()); window.addEventListener('storage', sync);
    const params = new URLSearchParams(location.hash.split('?')[1]);
    const paired = params.get('paired');
    if (paired && !handledCallback.current) {
      handledCallback.current = true;
      try {
        const target = machineUrl(paired);
        const pending = JSON.parse(sessionStorage.getItem('dili.machine.pending') || 'null') as (Machine & { nonce: string }) | null;
        // Only accept the machine this tab explicitly started pairing with.
        if (pending?.url === target && pending.nonce === params.get('nonce')) {
          const destination = publicMachineUrl(params.get('remote') ? machineUrl(params.get('remote')!) : target);
          if (params.has('remote') && new URL(destination).protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(destination).hostname)) throw new Error('远程地址必须使用 HTTPS');
          const bound: Machine = { url: destination, name: pending.name, localUrl: pending.localUrl || (params.get('local') ? machineUrl(params.get('local')!) : undefined), machineId: params.get('machineId') || undefined };
          if (persist([...readMachines().filter(item => item.url !== target && item.url !== destination), bound])) {
            sessionStorage.removeItem('dili.machine.pending');
            setConnecting(true);
            void preferredMachineUrl(bound).then(address => location.replace(openMachine(address)));
            return () => window.removeEventListener('storage', sync);
          }
        }
      } catch { setError('连接记录无法恢复，请重新添加机器。'); }
      history.replaceState(null, '', appUrl('/#/machines'));
    }
    return () => window.removeEventListener('storage', sync);
  }, []);
  const scanned = useCallback((value: string) => {
    setScanning(false); setError('');
    try {
      const link = new URL(value);
      if (link.origin !== 'https://dili.discoverpaw.com' || !link.hash.startsWith('#/machines?')) throw new Error('请扫描 Dili 设备二维码');
      const params = new URLSearchParams(link.hash.split('?')[1]);
      setLocalUrl(params.get('local') ? machineUrl(params.get('local')!) : ''); setUrl(machineUrl(publicMachineUrl(params.get('add') || ''))); setName((params.get('name') || '').slice(0, 80)); setAdding(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '二维码无法识别'); }
  }, []);
  useEffect(() => {
    const params = new URLSearchParams(location.hash.split('?')[1]);
    if (params.has('add')) scanned(new URL('https://dili.discoverpaw.com/' + location.hash).href);
    if (params.get('apply') === '1') setRequesting(true);
    if (!launcher) void api<RemoteStatus>('/remote').then(setRemote).catch(() => {});
  }, [launcher, scanned]);
  function connect(value: string, label: string, invite = '', localAddress = '') {
    setError('');
    try {
      const target = machineUrl(publicMachineUrl(value));
      if (invite && !/^SD1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(invite.trim())) throw new Error('请填写 SD1. 开头的完整邀请码');
      const machine = { url: target, name: label.trim() || new URL(target).host, nonce: crypto.randomUUID(), ...(localAddress ? { localUrl: machineUrl(localAddress) } : {}) };
      sessionStorage.setItem('dili.machine.pending', JSON.stringify(machine));
      const params = new URLSearchParams({ return: new URL(appUrl('/#/machines'), location.origin).href, nonce: machine.nonce, name: machine.name });
      if (invite) { params.set('remote', '1'); params.set('invite', invite.trim()); }
      location.assign(`${target}#/pair?${params}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '无法连接机器'); }
  }
  function add(event: FormEvent) { event.preventDefault(); connect(url, name, '', localUrl); }
  if (connecting) return <main className="machines-page"><p role="status">正在进入机器…</p></main>;
  return <main className="machines-page"><header><div><h1>我的机器</h1><p>连接你的 Dili，继续与 Agent 一起工作。</p></div></header>
    <div className="machine-actions"><InstallApp /><button className="button secondary" onClick={() => { setScanning(true); setRequesting(false); }}>扫码添加</button><button className="text-button" onClick={() => { if (!launcher) { location.assign('https://dili.discoverpaw.com/#/machines?apply=1'); return; } setRequesting(value => !value); setScanning(false); }}>申请邀请码</button><a className="text-button" href="https://dili.discoverpaw.com/connect/" target="_blank" rel="noreferrer">中继管理 ↗</a></div>
    {requesting && <InviteRequest />}
    {scanning && <QrScanner found={scanned} close={() => setScanning(false)} />}
    {remote?.settings.enabled && remote.tunnel.state === 'connected' && <DeviceQr url={remote.settings.publicUrl} name={remote.pairing?.name} />}
    {error && <p role="alert" className="form-error">{error}</p>}
    <section className="machine-grid" aria-label="机器列表">{cards.map(machine => <article className={machines.some(item => item.url === machine.url) ? "machine-card" : "machine-current-card"} key={machine.url}><a href={openMachine(machine.url)} onClick={event => {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); setConnecting(true);
      void preferredMachineUrl(machine).then(target => location.assign(openMachine(target)));
    }}><Monitor size={30} /><strong>{machine.name}</strong><small>{machine.url}</small><span>打开联系人 →</span></a><MachineInvite connect={invite => connect(machine.url, machine.name, invite, machine.localUrl)} />{machines.some(item => item.url === machine.url) && <button aria-label={`移除 ${machine.name}`} onClick={() => { if (confirm(`从列表移除「${machine.name}」？机器上的会话不会删除。`)) persist(machines.filter(item => item.url !== machine.url)); }}><Trash2 size={16} /></button>}</article>)}
      <button className="machine-add" aria-label="添加机器" onClick={() => { setAdding(true); setError(''); }}><Plus size={38} /><span>发现你的机器</span></button></section>
    {adding && <section className="machine-form" aria-label="添加机器"><button className="text-button" onClick={() => setAdding(false)}><ArrowLeft size={16} />取消</button><h2>连接机器</h2><form onSubmit={add}><label>机器链接<input autoFocus type="url" required placeholder="https://你的机器地址/" value={url} onChange={event => setUrl(event.target.value)} /></label><label>本地链接（可选）<input type="url" placeholder="http://localhost:实际端口/" value={localUrl} onChange={event => setLocalUrl(event.target.value)} /></label><label>名称（可选）<input maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder="例如：工作电脑" /></label><p>下一步会打开该机器验证密码。验证后自动保存机器并进入联系人；密码不会存入列表。</p><button className="button primary">下一步：验证机器</button></form></section>}
    <p className="machine-discovery-note">浏览器不能自动扫描局域网。请先填写机器链接；可在机器卡片中填写邀请码，生成并切换到远程链接。首次启用远程连接需在运行 Dili 的电脑上操作。</p>
    <a className="machine-install-guide" href="https://github.com/xiaoqiang-cheng/dili/blob/main/docs/installation.md" target="_blank" rel="noreferrer">电脑安装指南 ↗</a><footer>电脑与 Android：在浏览器菜单中安装应用。iPhone：Safari → 分享 → 添加到主屏幕。远程安装和麦克风需要 HTTPS。</footer>
  </main>;
}


function MachineInvite({ connect }: { connect: (invite: string) => void }) {
  const [invite, setInvite] = useState('');
  return <form className="machine-invite" onSubmit={event => { event.preventDefault(); connect(invite); setInvite(''); }}>
    <label>邀请码<input aria-label="远程连接邀请码" type="password" autoComplete="off" maxLength={1600} placeholder="SD1.…" required value={invite} onChange={event => setInvite(event.target.value)} /></label>
    <button className="button secondary" disabled={!invite.trim()}>转为远程连接</button>
  </form>;
}
