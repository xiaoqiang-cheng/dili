import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { SETTING_FIELDS, settingChoices, settingReason, settingValue, type AgentSettingsController, type SettingField } from './useAgentChatSettings';
import { t } from '../shared/i18n';
import ModalShell from './Modal';
import './agent-chat-settings.css';

export default function AgentChatSettingsPanel({ controller, close, field }: { controller: AgentSettingsController; close(): void; field?: SettingField }) {
  const { settings, loading, saving, error, notice, selection, setSelection, busy, read, save } = controller;
  useEffect(() => { void read(); }, [read, busy]);
  useEffect(() => {
    if (!settings || !field || loading) return;
    document.getElementById(`agent-setting-${field}`)?.focus();
  }, [field, settings, loading]);
  return createPortal(<ModalShell title="会话设置" subtitle="直接使用当前 Agent 的原生模型、权限和推理强度" close={close}>
    <div className="agent-chat-settings">
      <button type="button" className="text-button" disabled={loading || saving} onClick={() => void read()}><RefreshCw size={14} />刷新原生设置</button>
      {loading && <p role="status"><LoaderCircle size={15} className="spin" />正在读取原生设置…</p>}
      {error && <p role="alert" className="codex-request-error">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {settings && <>
        {(busy || settings.disabledReason) && <p role="status">{settings.disabledReason || '请等待当前任务或审批结束，再刷新设置。'}</p>}
        {SETTING_FIELDS.map(field => {
          const choices = settingChoices(settings, field);
          const reason = settingReason(settings, field);
          const label = field === 'model' ? '模型' : field === 'permission' ? '权限模式' : t('settings.effort');
          const disabled = busy || !!settings.disabledReason || saving || loading || !!reason || !choices.length;
          const value = selection[field];
          return <div className="agent-setting-field" key={field}>
            <label htmlFor={`agent-setting-${field}`}>{label}</label>
            <div><select id={`agent-setting-${field}`} value={value} disabled={disabled} onChange={event => setSelection(previous => ({ ...previous, [field]: event.target.value }))}>
              {!choices.some(choice => choice.id === value) && <option value={value}>{value || settingValue(settings, field)}</option>}
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
