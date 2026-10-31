import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import ModalShell from './Modal';
import { api } from './api';
import { t } from '../shared/i18n';

interface DebugSnapshot {
  instanceId: string;
  pid: number;
  node: string;
  platform: string;
  uptimeSeconds: number;
  memoryRssBytes: number;
  demo: boolean;
  revision: number;
  replay: { retained: number; latestRevision: number };
  sessions: { total: number; running: number; attention: number; archived: number };
  groups: number;
  connections: { stateStreams: number; websockets: number };
  terminals: { sessions: number; shells: number };
  idleSleepMinutes: number;
  dataDir: string;
  backends: { id: string; installed: boolean; version: string | null; graphicalChat: boolean; terminal: boolean }[];
}

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分`;
  return `${Math.floor(seconds / 86400)} 天 ${Math.floor(seconds % 86400 / 3600)} 小时`;
}

function size(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function DebugPanel({ close }: { close: () => void }) {
  const [snapshot, setSnapshot] = useState<DebugSnapshot | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => {
    setBusy(true);
    api<DebugSnapshot>('/debug')
      .then(value => { setSnapshot(value); setError(''); })
      .catch(cause => setError(cause instanceof Error ? cause.message : '无法读取运行诊断'))
      .finally(() => setBusy(false));
  };
  useEffect(load, []);
  return <ModalShell title={t('debug.title')} subtitle={t('debug.subtitle')} close={close} wide>
    {error && <p className="form-error" role="alert">{error}</p>}
    {!snapshot && !error && <p className="form-note">正在读取本地进程信息…</p>}
    {snapshot && <div className="debug-grid">
      <div><span>实例</span><code>{snapshot.instanceId}</code></div>
      <div><span>进程</span><small>PID {snapshot.pid} · Node {snapshot.node} · {snapshot.platform}</small></div>
      <div><span>运行时长</span><small>{duration(snapshot.uptimeSeconds)} · 内存 {size(snapshot.memoryRssBytes)}</small></div>
      <div><span>状态修订</span><small>r{snapshot.revision} · 补发窗口 {snapshot.replay.retained} 条（最新 r{snapshot.replay.latestRevision}）</small></div>
      <div><span>会话</span><small>{snapshot.sessions.total} 个 · 运行 {snapshot.sessions.running} · 待处理 {snapshot.sessions.attention} · 归档 {snapshot.sessions.archived} · 群 {snapshot.groups}</small></div>
      <div><span>连接</span><small>状态流 {snapshot.connections.stateStreams} · WebSocket {snapshot.connections.websockets} · 终端 {snapshot.terminals.sessions} · Shell {snapshot.terminals.shells}</small></div>
      <div><span>闲置休眠</span><small>{snapshot.idleSleepMinutes > 0 ? `已开启 · ${snapshot.idleSleepMinutes} 分钟` : '未开启'} · {snapshot.demo ? '演示模式' : '本地模式'}</small></div>
      <div><span>数据目录</span><code>{snapshot.dataDir}</code></div>
      <div><span>后端</span><small>{snapshot.backends.map(item => `${item.id}${item.installed ? '' : '（未安装）'}${item.version ? ` ${item.version}` : ''}`).join(' · ')}</small></div>
    </div>}
    <div className="modal-footer"><span className="appearance-note">用于远程排障；数据不会离开这台机器。</span><button className="button secondary" type="button" disabled={busy} onClick={load}><RefreshCw size={14} className={busy ? 'spin' : ''} />{t('common.refresh')}</button><button className="button primary" type="button" onClick={close}>完成</button></div>
  </ModalShell>;
}
