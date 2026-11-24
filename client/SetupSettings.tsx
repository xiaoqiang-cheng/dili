import { useEffect, useState } from 'react';
import { Download, ExternalLink, LoaderCircle, Power, RefreshCw, TerminalSquare } from 'lucide-react';
import type { AgentSetupInfo, SetupAction, StartupStatus } from '../shared/setup';
import type { ShellTerminal } from '../shared/shell';
import { api } from './api';
import { t } from '../shared/i18n';

export function AgentSetupControls({ info, local, onTerminal, refresh }: {
  info?: AgentSetupInfo; local: boolean; onTerminal: (id: string) => void; refresh: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  if (!info) return null;
  const managedProvider = info.id === 'dsh' || info.id === 'pi';
  const launch = async (action: SetupAction) => {
    if (action === 'install' && !window.confirm(`将在终端面板执行：\n${info.installCommand}\n\n安装到当前用户的 npm 全局目录，不会自动使用 sudo。是否继续？`)) return;
    setBusy(true); setMessage('');
    try { const shell = await api<ShellTerminal>(`/setup/agents/${info.id}/terminal`, { action }); onTerminal(shell.id); }
    catch (error) { setMessage(error instanceof Error ? error.message : '无法打开引导终端'); }
    finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setMessage('');
    try {
      const result = await api<{ note: string }>(`/setup/agents/${info.id}/config`, { ...(key ? { apiKey: key } : {}), baseUrl, model });
      setKey(''); setEditing(false); setMessage(result.note); await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败'); }
    finally { setBusy(false); }
  };
  return <div className="agent-setup-controls">
    <p className="backend-note">{info.note}</p>
    <small className="muted">{info.credentialPresent ? '检测到凭据配置（有效性未验证）' : '可使用原生账号登录或配置 API Key'}</small>
    <div className="setup-actions">
      <button className="button secondary small-button" disabled={busy || !local} onClick={() => void launch('install')}><Download size={14} />{info.executable ? '安装 / 更新' : '安装后端'}</button>
      <button className="button secondary small-button" disabled={busy || !local || !info.executable} onClick={() => void launch('login')}><TerminalSquare size={14} />{info.id === 'dsh' ? '原生配置引导' : '原生账号登录'}</button>
      <button className="button secondary small-button" disabled={busy || !local || !!info.error} onClick={() => { setKey(''); setBaseUrl(info.baseUrl); setModel(info.model); setMessage(''); setEditing(!editing); }}>{editing ? '收起 API 配置' : '配置 API'}</button>
      <a className="text-button" href={info.docsUrl} target="_blank" rel="noreferrer">官方说明<ExternalLink size={12} /></a>
    </div>
    {!local && <p className="backend-note">安装、登录和配置请在运行 Dili 的电脑上操作。</p>}
    {info.error && <p role="alert" className="setup-message">{info.error}</p>}
    {editing && <form className="setup-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <label>API Key<input type="password" autoComplete="new-password" value={key} onChange={event => setKey(event.target.value)} placeholder="留空保留已有凭据" maxLength={4096} disabled={busy} /></label>
      <label>API 地址<input type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder={managedProvider ? t('setup.managedApiUrl') : '留空使用原生默认地址'} maxLength={500} disabled={busy} /></label>
      <label>模型<input value={model} onChange={event => setModel(event.target.value)} placeholder={managedProvider ? t('setup.managedModel') : '留空使用原生默认模型'} maxLength={500} disabled={busy} /></label>
      <p className="backend-note">{managedProvider ? t('setup.managedApiNote') : '写入原生设置，自动备份旧文件。API Key 留空会保留凭据；地址和模型留空会恢复默认。新会话生效，保存时不调用模型。'}</p>
      <div className="setup-actions"><button className="button primary small-button" disabled={busy}>{busy && <LoaderCircle size={13} className="spin" />}保存原生配置</button><button type="button" className="text-button" disabled={busy} onClick={() => { setKey(''); setEditing(false); }}>取消</button></div>
    </form>}
    <details><summary>在其他终端使用</summary><code>{info.installCommand}</code><code>{info.loginCommand}</code><code>{info.nativeCommand}</code><small className="muted">原生配置：{info.configPath}{info.credentialPath ? `；${t('setup.credentialPath', { path: info.credentialPath })}` : ''}</small></details>
    {message && <p className="setup-message" role="status">{message}</p>}
  </div>;
}

export function StartupSettings({ local }: { local: boolean }) {
  const [status, setStatus] = useState<StartupStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = async () => { try { setStatus(await api<StartupStatus>('/setup/startup')); setError(''); } catch (cause) { setError(cause instanceof Error ? cause.message : '无法读取启动设置'); } };
  useEffect(() => { void load(); }, []);
  const change = async (enabled: boolean) => {
    setBusy(true); setError('');
    try { setStatus(await api<StartupStatus>('/setup/startup', { enabled })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '更新失败'); }
    finally { setBusy(false); }
  };
  return <section className="backend-setting-card" aria-label="自动启动">
    <div className="backend-setting-title"><Power size={20} /><div><h2>自动启动</h2><p>启动电脑后继续使用你的工作台。</p></div></div>
    <p className="backend-note">{status?.note ?? '正在读取本机启动设置…'}</p>
    {status?.supported && <><div className="setup-actions"><button className="button secondary small-button" role="switch" aria-checked={status.enabled} disabled={busy || !local || status.conflict} onClick={() => void change(!status.enabled)}>{busy ? <LoaderCircle size={14} className="spin" /> : <Power size={14} />}{status.enabled ? '自动启动已开启' : '开启自动启动'}</button>{status.legacy && <button className="button secondary small-button" disabled={busy || !local} onClick={() => void change(true)}>迁移到 dili.service</button>}<span className="muted">{status.active ? '用户服务正在运行' : '用户服务未运行'}</span></div>
      {!status.wsl && !status.linger && <p className="backend-note">如需在登录前运行，可在本机终端执行 <code>loginctl enable-linger</code>。此操作可能需要系统授权。</p>}
      <details><summary>服务位置</summary><code>{status.unitPath}</code><small className="muted">开关不会停止或重启当前服务。</small>
        <p className="backend-note">在本机终端手动重启：<code>scripts/restart-service.sh</code>。它只停止本项目、监听配置端口的 Dili 进程，不会按端口误杀其他程序；必要时先重新构建前端，再重启服务。</p>
      </details></>}
    {!local && <p className="backend-note">请在本机更改自动启动设置。</p>}
    {error && <p role="alert" className="setup-message">{error}</p>}
    <button className="text-button" disabled={busy} onClick={() => void load()}><RefreshCw size={13} />重新检测</button>
  </section>;
}
