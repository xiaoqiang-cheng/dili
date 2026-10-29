import { useState, type FormEvent } from 'react';
import { Folder, LoaderCircle, Plus } from 'lucide-react';
import type { BackendInfo, Session } from '../shared/types';
import { api } from './api';
import DirectoryField from './DirectoryField';
import ModalShell from './Modal';

export default function WorkspacePermissions({ session, backend, close, refresh }: { session: Session; backend: BackendInfo; close: () => void; refresh: () => Promise<unknown> }) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const supported = !!backend.capabilities.additionalDirectories;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !supported) return;
    setBusy(true); setError('');
    try {
      await api(`/sessions/${session.id}/directories`, { path });
      await refresh(); setPath('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '无法添加工作区'); }
    finally { setBusy(false); }
  };
  return <ModalShell title="工作区权限" subtitle={`为「${session.title}」增加可操作的目录。`} close={busy ? () => {} : close}>
    <form onSubmit={submit}><div className="modal-fields">
      <div className="form-label"><span>主工作区</span><code style={{ overflowWrap: 'anywhere' }}>{session.cwd}</code></div>
      {!!session.additionalDirectories?.length && <div className="form-label"><span>附加工作区</span>{session.additionalDirectories.map(directory => <code key={directory} style={{ overflowWrap: 'anywhere' }}>{directory}</code>)}</div>}
      {!supported ? <p className="form-note">{session.backend === 'dsh' ? '当前 DeepSeek Harness 原生沙箱以单个工作目录为边界，尚无追加目录权限接口。可为目标目录新建联系人。' : '当前 CLI 未检测到附加目录能力，请升级后在设置中刷新检测。'}</p> : <>
        <DirectoryField label="新增可操作目录" value={path} onChange={setPath} disabled={busy || session.archived} help="选择运行 Agent 的电脑上的目录，或粘贴路径／file:// 链接。" />
        <p className="form-note"><Folder size={15} />Codex 空闲时立即生效；Claude 和兼容终端在下次恢复会话时生效。</p>
        <p className="form-note">沿用原生审批、沙箱和网络策略。只追加指定目录；此处不提供权限撤销。</p>
      </>}
      {session.directoriesPending && <p className="form-note" role="status">已保存，待下次恢复原生会话后生效。</p>}
      {session.archived && <p className="form-note">请先恢复归档联系人。</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      <div className="modal-footer"><button type="button" className="button secondary" disabled={busy} onClick={close}>完成</button>{supported && <button className="button primary" disabled={busy || session.archived || !path.trim()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}添加工作区</button>}</div>
    </form>
  </ModalShell>;
}
