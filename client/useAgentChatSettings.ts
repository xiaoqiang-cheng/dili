import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { AgentChatSettings, AgentChatSettingsUpdate } from '../shared/chat';
import { api } from './api';

export type SettingField = AgentChatSettingsUpdate['field'];
export const settingLabel = (field: SettingField) => field === 'model' ? '模型' : '权限';
export const settingChoices = (settings: AgentChatSettings, field: SettingField) => field === 'model' ? settings.models : settings.permissions;
export const settingReason = (settings: AgentChatSettings, field: SettingField) => field === 'model' ? settings.modelReason : settings.permissionReason;
export function settingValue(settings: AgentChatSettings, field: SettingField) {
  return settingChoices(settings, field).find(choice => choice.id === settings[field])?.label
    || settings[field] || (field === 'permission' ? settings.permissionLabel : undefined) || '原生未报告当前值';
}

/** One native read/write state for the composer shortcuts and the full settings panel. */
export function useAgentChatSettings(sessionId: string, identity: string, busy: boolean) {
  const [settings, setSettings] = useState<AgentChatSettings | null>(null);
  const [selection, setSelection] = useState({ model: '', permission: '' });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const context = useRef({ identity, busy, alive: true });
  context.current.identity = identity; context.current.busy = busy;
  const operation = useRef<symbol | null>(null);
  const path = `/sessions/${sessionId}/chat/settings`;

  useLayoutEffect(() => {
    context.current.alive = true;
    operation.current = null;
    setSettings(null); setSelection({ model: '', permission: '' });
    setLoading(false); setSaving(false); setError(''); setNotice('');
    return () => { context.current.alive = false; operation.current = null; };
  }, [identity]);

  function accept(next: AgentChatSettings) {
    setSettings(next); setSelection({ model: next.model ?? '', permission: next.permission ?? '' });
  }

  const read = useCallback(async () => {
    if (operation.current) return;
    const job = Symbol('read-settings'); operation.current = job;
    const current = () => context.current.alive && context.current.identity === identity && operation.current === job;
    setLoading(true); setError(''); setNotice('');
    try { const next = await api<AgentChatSettings>(path); if (current()) accept(next); }
    catch (cause) { if (current()) { setSettings(null); setError(cause instanceof Error ? cause.message : '读取原生设置失败'); } }
    finally { if (current()) { operation.current = null; setLoading(false); } }
  }, [path, identity]);

  async function save(field: SettingField) {
    if (!settings || operation.current || context.current.busy || settings.disabledReason || settingReason(settings, field)
      || !settingChoices(settings, field).some(choice => choice.id === selection[field]) || selection[field] === settings[field]) return;
    const job = Symbol('save-settings'); operation.current = job;
    const current = () => context.current.alive && context.current.identity === identity && operation.current === job;
    setSaving(true); setError(''); setNotice('');
    try {
      const next = await api<AgentChatSettings>(path, { version: settings.version, field, value: selection[field] });
      if (current()) { accept(next); setNotice('原生设置已确认，将用于后续任务。'); }
    } catch (cause) {
      // An uncertain write may have applied. Require native readback before retrying.
      if (current()) { setSettings(null); setError(cause instanceof Error ? cause.message : '修改失败，请刷新确认'); }
    } finally { if (current()) { operation.current = null; setSaving(false); } }
  }

  return { settings, selection, setSelection, loading, saving, error, notice, read, save, busy };
}

export type AgentSettingsController = ReturnType<typeof useAgentChatSettings>;
