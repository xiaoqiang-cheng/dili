import type { Backend, SessionStatus } from '../../shared/types.ts';
import type { AgentChatAnswer, AgentChatHistoryPage, AgentChatSnapshot, AgentChatSettings, AgentChatSettingsUpdate } from '../../shared/chat.ts';

export interface AgentChatAdapter {
  readChatSettings(sessionId: string): Promise<AgentChatSettings>;
  updateChatSettings(sessionId: string, update: AgentChatSettingsUpdate): Promise<AgentChatSettings>;
  readChat(sessionId: string): Promise<AgentChatSnapshot>;
  chatSnapshot(sessionId: string): AgentChatSnapshot | undefined;
  readChatHistory(sessionId: string, cursor: string): Promise<AgentChatHistoryPage>;
  onChat(listener: (sessionId: string, snapshot: AgentChatSnapshot) => void): () => void;
  sendPrompt(sessionId: string, text: string, model?: string, images?: string[], expectedTurnId?: string): Promise<{ turnId: string }>;
  getStatus(sessionId: string): Promise<{ status: SessionStatus; detail: string; timestamp: string }>;
  answerChatRequest(sessionId: string, requestId: string, answer: AgentChatAnswer): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
}

export type AgentChatAdapters = Partial<Record<Backend, AgentChatAdapter>>;

export function createAgentChatAdapters(entries: Iterable<readonly [Backend, AgentChatAdapter]>): AgentChatAdapters {
  const adapters: AgentChatAdapters = {};
  for (const [backend, adapter] of entries) {
    if (adapters[backend]) throw new Error(`Duplicate chat adapter registration for ${backend}`);
    adapters[backend] = adapter;
  }
  return adapters;
}
