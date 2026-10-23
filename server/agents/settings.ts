import { randomUUID } from 'node:crypto';
import type { AgentChatSettings, AgentChatSettingsUpdate } from '../../shared/chat.ts';

export const settingsError = (message: string): never => { throw Object.assign(new Error(message), { status: 409 }); };
export function checkSettingsUpdate(settings: AgentChatSettings, update: AgentChatSettingsUpdate) {
  if (settings.disabledReason) settingsError(settings.disabledReason);
  if (update.version !== settings.version) settingsError('原生设置已变化，请刷新设置后重试');
  const choices = update.field === 'model' ? settings.models : settings.permissions;
  const reason = update.field === 'model' ? settings.modelReason : settings.permissionReason;
  if (reason || !choices.some(choice => choice.id === update.value)) settingsError(reason || '该选项不在原生支持列表中');
}
export function settingsVersion(previous: AgentChatSettings | undefined, next: Omit<AgentChatSettings, 'version'>): AgentChatSettings {
  const comparable = (value: AgentChatSettings | Omit<AgentChatSettings, 'version'>) => JSON.stringify({ ...value, version: '', disabledReason: '' });
  return { ...next, version: previous && comparable(previous) === comparable(next) ? previous.version : randomUUID() };
}
