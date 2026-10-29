import { useState, type FormEvent } from 'react';
import { FolderPlus, LoaderCircle } from 'lucide-react';
import type { BackendInfo, Group, GroupDirectoryResponse, GroupDirectoryResult, Session } from '../shared/types';
import { BackendAvatar } from './App';
import { api } from './api';
import DirectoryField from './DirectoryField';
import ModalShell from './Modal';
import './workspace-permissions.css';

const resultLabels: Record<GroupDirectoryResult['status'], string> = {
  applied: '已生效', pending: '已保存，待恢复会话生效', unchanged: '已添加，无需重复保存', failed: '授权失败',
};

export default function GroupWorkspacePermissions({ group, members, backends, close, refresh }: {
  group: Group; members: Session[]; backends: BackendInfo[]; close: () => void; refresh: () => Promise<unknown>;
}) {
  const unavailable = (member: Session) => member.archived ? '已归档，请先恢复联系人' : member.backend === 'dsh'
    ? 'DeepSeek 原生沙箱暂不支持追加目录' : !backends.find(item => item.id === member.backend)?.capabilities.additionalDirectories
      ? '当前 CLI 不支持追加目录，请升级后刷新检测' : '';
  const [path, setPath] = useState(group.workspace ?? '');
  const [selected, setSelected] = useState(() => members.filter(member => !unavailable(member)).map(member => member.id));
  const [results, setResults] = useState<GroupDirectoryResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const eligible = members.filter(member => !unavailable(member));
  const chosen = eligible.filter(member => selected.includes(member.id)).map(member => member.id);
  const failed = results.filter(result => result.status === 'failed' && eligible.some(member => member.id === result.sessionId)).map(result => result.sessionId);
  const submit = async (ids: string[]) => {
    if (busy || !ids.length || !path.trim() || group.archived) return;
    setBusy(true); setError('');
    try {
      const response = await api<GroupDirectoryResponse>(`/groups/${group.id}/directories`, { path, sessionIds: ids });
      setPath(response.path);
      setResults(previous => [...previous.filter(result => !ids.includes(result.sessionId)), ...response.results]);
      await refresh().catch(() => setError('授权结果已返回，但联系人列表刷新失败，请稍后刷新。'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法完成批量授权');
      await refresh().catch(() => {});
    } finally { setBusy(false); }
  };
  const onSubmit = (event: FormEvent) => { event.preventDefault(); void submit(chosen); };
  return <ModalShell title="群工作区权限" subtitle={`为「${group.title}」的所选成员追加可操作目录。`} close={busy ? () => {} : close}>
    <form onSubmit={onSubmit}><div className="modal-fields">
      <DirectoryField label="授权目录" value={path} onChange={value => { setPath(value); setResults([]); setError(''); }} disabled={busy || group.archived} help="选择运行 Agent 的电脑上的目录，或粘贴路径／file:// 链接。" />
      <p className="form-note">只授权当前所选成员，不改变工作位置，也不自动授权以后入群的成员。沿用各平台的原生审批和沙箱策略。</p>
      <div className="workspace-member-heading"><strong>选择成员 · {chosen.length}/{eligible.length}</strong><button className="text-button" type="button" disabled={busy || !eligible.length} onClick={() => setSelected(chosen.length === eligible.length ? [] : eligible.map(member => member.id))}>{chosen.length === eligible.length ? '取消全选' : '全选可授权成员'}</button></div>
      <div className="workspace-members" role="group" aria-label="授权成员">
        {members.map(member => {
          const reason = unavailable(member), result = results.find(item => item.sessionId === member.id);
          return <label className={`workspace-member${reason ? ' unavailable' : ''}`} key={member.id}>
            <input type="checkbox" aria-label={`授权 ${member.title}`} checked={!reason && selected.includes(member.id)} disabled={busy || !!reason || group.archived} onChange={event => setSelected(previous => event.target.checked ? [...previous, member.id] : previous.filter(id => id !== member.id))} />
            <BackendAvatar backend={member.backend} small />
            <span className="workspace-member-info"><strong>{member.title}</strong><small title={member.cwd}>{member.cwd}</small>{reason && <small>{reason}</small>}{result && <small className={result.status === 'failed' ? 'form-error' : 'workspace-member-result'} role="status">{result.error || resultLabels[result.status]}</small>}</span>
          </label>;
        })}
        {!members.length && <p className="form-note">群组暂无成员，请先添加联系人。</p>}
      </div>
      <p className="form-note">Codex 空闲时立即生效；Claude 与兼容终端在下次恢复时生效。不会停止正在执行的任务；忙碌而无法应用的成员可稍后重试。</p>
      {!!results.length && <p className="form-note" role="status">授权结果：{results.filter(result => result.status !== 'failed').length} 位已处理，{results.filter(result => result.status === 'failed').length} 位失败。</p>}
      {chosen.length > 100 && <p className="form-error">每次最多选择 100 位成员。</p>}
      {group.archived && <p className="form-error">请先恢复归档群组。</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div><div className="modal-footer workspace-permissions-footer">
      <button className="button secondary" type="button" disabled={busy} onClick={close}>完成</button>
      {!!failed.length && <button className="button secondary" type="button" disabled={busy || !path.trim() || group.archived} onClick={() => void submit(failed)}>仅重试失败成员</button>}
      <button className="button primary" disabled={busy || !path.trim() || !chosen.length || chosen.length > 100 || group.archived}>{busy ? <LoaderCircle size={15} className="spin" /> : <FolderPlus size={15} />}{busy ? '正在授权…' : `授权所选成员${chosen.length ? `（${chosen.length}）` : ''}`}</button>
    </div></form>
  </ModalShell>;
}
