import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import type { AgentChatSettings, AgentChatSettingsUpdate } from '../shared/chat';
import { api } from './api';
import ModalShell from './Modal';
import './agent-chat-settings.css';

export default function AgentChatSettingsPanel({ sessionId, busy, close }: { sessionId: string; busy: boolean; close(): void }) {
  const [settings, setSettings] = useState<AgentChatSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selection, setSelection] = useState({ model: '', permission: '' });
  const alive = useRef(true);
  const path = `/sessions/${sessionId}/chat/settings`;
  function accept(next: AgentChatSettings) {
    if (!alive.current) return;
    setSettings(next); setSelection({ model: next.model ?? '', permission: next.permission ?? '' });
  }
  async function read() {
    setLoading(true); setError(''); setNotice('');
    try { accept(await api<AgentChatSettings>(path)); }
    catch (cause) { if (alive.current) { setSettings(null); setError(cause instanceof Error ? cause.message : '读取设置失败'); } }
    finally { if (alive.current) setLoading(false); }
  }
  useEffect(() => { alive.current = true; void read(); return () => { alive.current = false; }; }, [sessionId]);
  async function save(field: AgentChatSettingsUpdate['field']) {
    if (!settings || saving || loading || busy) return;
    setSaving(true); setError(''); setNotice('');
    try {
      const next = await api<AgentChatSettings>(path, { version: settings.version, field, value: selection[field] });
      accept(next);
      if (alive.current) setNotice('原生设置已确认，将用于后续任务。');
    } catch (cause) {
      // A timed-out control can still have applied. Invalidate the form and
      // require native readback before retrying; keep the error visible.
      if (alive.current) {
        setSettings(null);
        setError(cause instanceof Error ? cause.message : '设置修改失败，请刷新确认');
      }
    } finally { if (alive.current) setSaving(false); }
  }
  return createPortal(<ModalShell title="会话设置" subtitle="直接使用当前 Agent 的原生模型和权限能力" close={close}>
    <div className="agent-chat-settings">
      <button type="button" className="text-button" disabled={loading || saving} onClick={() => void read()}><RefreshCw size={14} />刷新原生设置</button>
      {loading && <p role="status"><LoaderCircle size={15} className="spin" />正在读取原生设置…</p>}
      {error && <p role="alert" className="codex-request-error">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {settings && <>
        {(busy || settings.disabledReason) && <p role="status">{settings.disabledReason || '请等待当前任务或审批结束，再刷新设置。'}</p>}
        {(['model', 'permission'] as const).map(field => {
          const choices = field === 'model' ? settings.models : settings.permissions;
          const reason = field === 'model' ? settings.modelReason : settings.permissionReason;
          const label = field === 'model' ? '模型' : '权限模式';
          const disabled = busy || !!settings.disabledReason || saving || loading || !!reason || !choices.length;
          const value = selection[field];
          return <div className="agent-setting-field" key={field}>
            <label htmlFor={`agent-setting-${field}`}>{label}</label>
            <div><select id={`agent-setting-${field}`} value={value} disabled={disabled} onChange={event => setSelection(previous => ({ ...previous, [field]: event.target.value }))}>
              {!choices.some(choice => choice.id === value) && <option value={value}>{value || (field === 'permission' ? settings.permissionLabel : undefined) || '原生未报告当前值'}</option>}
              {choices.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
            </select><button type="button" className="button secondary small-button" disabled={disabled || !value || value === settings[field]} onClick={() => void save(field)}>应用{label}</button></div>
            <p>{reason || choices.find(choice => choice.id === value)?.description}</p>
          </div>;
        })}
        <p className="agent-settings-scope">{settings.scope}</p>
      </>}
    </div>
  </ModalShell>, document.body);
}
