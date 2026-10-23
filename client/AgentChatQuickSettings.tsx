import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, LoaderCircle, RefreshCw, ShieldCheck, Sparkles, X } from 'lucide-react';
import AgentChatPopover from './AgentChatPopover';
import { settingChoices, settingLabel, settingReason, settingValue, type AgentSettingsController, type SettingField } from './useAgentChatSettings';
import './agent-chat-settings.css';

export default function AgentChatQuickSettings({ controller, blockedReason }: { controller: AgentSettingsController; blockedReason?: string }) {
  const [open, setOpen] = useState<SettingField | null>(null);
  const modelButton = useRef<HTMLButtonElement>(null), permissionButton = useRef<HTMLButtonElement>(null);
  const id = useId();
  const { settings, selection, setSelection, loading, saving, error, notice, busy, read, save } = controller;
  useEffect(() => { if (open) void read(); }, [open, read, busy]);

  const reason = open && settings ? settingReason(settings, open) : undefined;
  const disabled = busy || !!blockedReason || !!settings?.disabledReason || saving || loading || !!reason;
  return <div className="agent-chat-quick-settings" role="group" aria-label="原生模型和权限">
    {(['model', 'permission'] as const).map(field => <button key={field} ref={field === 'model' ? modelButton : permissionButton} type="button" className="agent-chat-quick-button" aria-label={`选择原生${settingLabel(field)}`} aria-expanded={open === field} aria-controls={open === field ? id : undefined} title={settings ? settingValue(settings, field) : `选择原生${settingLabel(field)}`} onClick={() => setOpen(previous => previous === field ? null : field)} onKeyDown={event => {
      if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(null); }
      if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(field); }
    }}>
      {field === 'model' ? <Sparkles size={13} /> : <ShieldCheck size={13} />}
      <span>{settingLabel(field)}</span><strong>{settings ? settingValue(settings, field) : '原生设置'}</strong><ChevronDown size={12} />
    </button>)}
    {open && <AgentChatPopover anchor={open === 'model' ? modelButton : permissionButton} id={id} className="agent-chat-quick-popover" label={`原生${settingLabel(open)}设置`} close={() => setOpen(null)}>
      <div className="agent-chat-quick-heading"><strong>{settingLabel(open)}</strong><div><button type="button" className="icon-button" aria-label={`刷新原生${settingLabel(open)}`} disabled={loading || saving} onClick={() => void read()}><RefreshCw size={13} /></button><button type="button" className="icon-button" aria-label="关闭快捷设置" onClick={() => { (open === 'model' ? modelButton : permissionButton).current?.focus(); setOpen(null); }}><X size={13} /></button></div></div>
      {loading && <p role="status"><LoaderCircle size={13} className="spin" />正在读取原生选项…</p>}
      {error && <p role="alert">{error}</p>}
      {settings && <>
        {(busy || blockedReason || settings.disabledReason) && <p role="status">{blockedReason || settings.disabledReason || '当前任务或审批结束后可修改。'}</p>}
        {reason ? <p role="status">{reason}</p> : settingChoices(settings, open).length ? <>
          <select aria-label={`原生${settingLabel(open)}`} value={selection[open]} disabled={disabled} onChange={event => setSelection(previous => ({ ...previous, [open]: event.target.value }))}>
            {!settingChoices(settings, open).some(choice => choice.id === selection[open]) && <option value={selection[open]}>{settingValue(settings, open)}</option>}
            {settingChoices(settings, open).map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
          </select>
          <p>{settingChoices(settings, open).find(choice => choice.id === selection[open])?.description || (open === 'model' ? '选项来自当前 Agent 的原生模型列表。' : '选项来自当前 Agent 支持的权限模式。')}</p>
          <button type="button" className="button primary small-button" disabled={disabled || !selection[open] || selection[open] === settings[open]} onClick={() => void save(open)}>{saving ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}应用{settingLabel(open)}</button>
        </> : <p>当前原生 Agent 未提供可选{settingLabel(open)}。</p>}
        {notice && <p role="status">{notice}</p>}
        <p className="agent-settings-scope">{settings.scope}</p>
      </>}
    </AgentChatPopover>}
  </div>;
}
