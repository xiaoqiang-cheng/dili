import { randomUUID } from 'node:crypto';
import type { AgentChatChoice, AgentChatSettings, AgentChatSettingsUpdate } from '../../shared/chat.ts';

export const settingsError = (message: string): never => { throw Object.assign(new Error(message), { status: 409 }); };
export function settingChoicesFor(settings: AgentChatSettings, field: AgentChatSettingsUpdate['field']): AgentChatChoice[] {
  return field === 'model' ? settings.models : field === 'permission' ? settings.permissions : settings.efforts ?? [];
}
export function settingReasonFor(settings: AgentChatSettings, field: AgentChatSettingsUpdate['field']): string | undefined {
  return field === 'model' ? settings.modelReason : field === 'permission' ? settings.permissionReason : settings.effortReason ?? (settings.efforts ? undefined : '当前 Agent 未报告推理强度');
}
export function checkSettingsUpdate(settings: AgentChatSettings, update: AgentChatSettingsUpdate) {
  if (settings.disabledReason) settingsError(settings.disabledReason);
  if (update.version !== settings.version) settingsError('原生设置已变化，请刷新设置后重试');
  const reason = settingReasonFor(settings, update.field);
  if (reason || !settingChoicesFor(settings, update.field).some(choice => choice.id === update.value)) settingsError(reason || '该选项不在原生支持列表中');
}
export function settingsVersion(previous: AgentChatSettings | undefined, next: Omit<AgentChatSettings, 'version'>): AgentChatSettings {
  const comparable = (value: AgentChatSettings | Omit<AgentChatSettings, 'version'>) => JSON.stringify({ ...value, version: '', disabledReason: '' });
  return { ...next, version: previous && comparable(previous) === comparable(next) ? previous.version : randomUUID() };
}
