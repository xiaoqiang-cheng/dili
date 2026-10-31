import { useEffect, useState } from 'react';
import { timeoutSignal } from './timeout-signal';
import { latestStableTag, compareVersions } from '../shared/versions';
import { appUrl } from './urls';
const repository = 'https://github.com/xiaoqiang-cheng/dili';
const current = __DILI_VERSION__;
export default function AppVersion() {
  const [open, setOpen] = useState(false);
  const [latest, setLatest] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [available, setAvailable] = useState(false);
  const [checked, setChecked] = useState(false);
  async function check(automatic = false) {
    setBusy(true); setError('');
    try {
      const response = await fetch('https://api.github.com/repos/xiaoqiang-cheng/dili/tags?per_page=100', { signal: timeoutSignal(10_000), headers: { Accept: 'application/vnd.github+json' } });
      if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? '仓库查询限流，请稍后重试' : '暂时无法检查版本');
      const tag = latestStableTag(await response.json());
      setLatest(tag); setChecked(true);
      try { localStorage.setItem('dili.version-check.v1', JSON.stringify({ tag, time: Date.now() })); } catch { /* Storage is optional. */ }
    } catch (cause) { if (!automatic) setError(cause instanceof TypeError ? '无法连接仓库，请检查网络后重试' : cause instanceof Error ? cause.message : '检查失败'); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    let disposed = false;
    let cached = false;
    try {
      const value = JSON.parse(localStorage.getItem('dili.version-check.v1') || 'null');
      if (value && typeof value.time === 'number' && Date.now() >= value.time && Date.now() - value.time < 86_400_000 && (value.tag === null || typeof value.tag === 'string')) {
        setLatest(value.tag); setChecked(true); cached = true;
      }
    } catch { /* An invalid cache is ignored. */ }
    if (!cached) void check(true);
    const checkBuild = async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        const response = await fetch(appUrl('/build-info.json'), { cache: 'no-store', signal: timeoutSignal(5000) });
        if (!response.ok) return;
        const info = await response.json();
        if (!disposed && typeof info.build === 'string') setAvailable(info.build !== __DILI_BUILD__);
      } catch { /* Old and offline installations remain usable. */ }
    };
    void checkBuild(); const timer = window.setInterval(() => void checkBuild(), 300_000);
    document.addEventListener('visibilitychange', checkBuild);
    return () => { disposed = true; clearInterval(timer); document.removeEventListener('visibilitychange', checkBuild); };
  }, []);
  const newer = latest && compareVersions(latest, current) > 0;
  return <div className="app-version-anchor">
    <button className={`version-badge ${newer || available ? 'has-update' : ''}`} aria-label="Dili 版本与更新" aria-expanded={open} onClick={() => setOpen(!open)} title="查看版本与更新">v{current}{(newer || available) && <i aria-label="有更新" />}</button>
    {open && <><button className="version-dismiss" aria-label="关闭版本信息" onClick={() => setOpen(false)} /><section className="app-version" aria-label="Dili 版本与更新">
    <span title={`界面构建 ${__DILI_BUILD__}`}>Dili 界面 v{current}</span>
    <a href={`${repository}/blob/main/docs/installation.md`} target="_blank" rel="noreferrer">电脑安装指南 ↗</a>
    <button className="text-button" disabled={busy} onClick={() => void check()}>{busy ? '正在检查…' : '检查更新'}</button>
    {newer ? <a href={`${repository}/tree/${encodeURIComponent(latest)}`} target="_blank" rel="noreferrer">发现新版 {latest} ↗</a>
      : checked && <span>{latest ? '未发现更高正式版本' : '仓库暂无正式版本标签'}</span>}
    {available && <button className="text-button" onClick={() => {
      if (confirm('加载新版界面将刷新当前页面，请先保存未发送的内容。Agent 服务不会重启。继续？')) location.reload();
    }}>加载新版界面</button>}
    {error && <span role="status">{error}</span>}
    <small>界面支持热更新；后端升级需在电脑端按仓库指南操作，安排服务重启。</small>
  </section></>}
  </div>;
}
