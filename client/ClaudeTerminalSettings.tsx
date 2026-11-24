import { useEffect, useState } from 'react';
import { LoaderCircle, RotateCcw } from 'lucide-react';
import type { Session } from '../shared/types';
import { api } from './api';
import AgentChatQuickSettings from './AgentChatQuickSettings';
import { useAgentChatSettings } from './useAgentChatSettings';

/** The same contact-level model and permission controls as the graphical
 * composer. A terminal process keeps its launch settings, so a saved change
 * offers an explicit, confirmed restart that resumes the same native session. */
export default function ClaudeTerminalSettings({ session, readOnly }: { session: Session; readOnly?: boolean }) {
  const identity = `${session.nativeSessionId}:${session.running}:${session.executionTransport}`;
  const controller = useAgentChatSettings(session.id, identity, session.archived || !!readOnly);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState('');
  const { read, settings } = controller;
  const saved = JSON.stringify(session.nativeSettings ?? {});
  // Contact settings also change from the graphical view or the TUI's Shift+Tab.
  useEffect(() => { void read(); }, [read, saved]);
  const restart = async () => {
    if (!window.confirm('重启将退出当前 Claude 终端进程，并用会话设置恢复同一份已保存会话。当前任务和审批必须先处理完成。继续重启？')) return;
    setRestarting(true); setError('');
    try { await api(`/sessions/${session.id}/start`, { mode: 'terminal', restart: true, handoff: true }); await read(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '重启失败'); }
    finally { setRestarting(false); }
  };
  return <div className="claude-terminal-settings">
    <AgentChatQuickSettings controller={controller} blockedReason={session.archived ? '恢复会话后可修改设置。' : readOnly ? '只读访问不能修改设置。' : undefined} />
    {settings?.restartRequired && session.running && !readOnly && <button type="button" className="agent-chat-quick-button claude-terminal-restart" disabled={restarting} title="终端仍按启动时的设置运行" onClick={() => void restart()}>{restarting ? <LoaderCircle size={13} className="spin" /> : <RotateCcw size={13} />}<span>重启以应用</span></button>}
    {error && <span role="alert" className="claude-terminal-settings-error" title={error}>{error}</span>}
  </div>;
}
