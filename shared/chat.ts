/** Dili's bounded view of native Agent items; the native session owns execution. */
export interface AgentChatItem {
  id: string;
  /** Provisional stream items replaced by this native, saved message. */
  replaces?: string[];
  turnId?: string;
  type: 'user' | 'assistant' | 'command' | 'fileChange' | 'tool' | 'plan' | 'notice';
  text: string;
  imageCount?: number;
  title?: string;
  output?: string;
  status: 'inProgress' | 'completed' | 'failed';
}

export interface AgentChatRequest {
  /** Opaque handle bound to the native connection and original request. */
  id: string;
  kind: 'approval' | 'question' | 'unsupported';
  title: string;
  description?: string;
  details?: string;
  options?: { id: string; label: string }[];
  questions?: { id: string; header: string; question: string; isOther?: boolean; isSecret?: boolean; options?: { label: string; description: string }[] }[];
}

export interface AgentChatSnapshot {
  instanceId?: string;
  nativeSessionId: string | null;
  revision: number;
  connected: boolean;
  activeTurnId: string | null;
  items: AgentChatItem[];
  requests: AgentChatRequest[];
  truncated: boolean;
  /** Native cursor for loading older turns; null means the beginning is loaded. */
  historyCursor?: string | null;
  notice?: string;
}

export interface AgentChatHistoryPage {
  nativeSessionId: string;
  items: AgentChatItem[];
  nextCursor: string | null;
  truncated: boolean;
}

export interface AgentChatPatch extends Omit<AgentChatSnapshot, 'items'> {
  baseRevision: number;
  /** Only changed items. Order also removes items evicted from the bounded view. */
  items: AgentChatItem[];
  order: string[];
}

export interface AgentChatAnswer {
  decision?: string;
  answers?: Record<string, string[]>;
}

export interface AgentChatSubmission {
  requestId: string;
  status: 'sending' | 'accepted' | 'unknown' | 'rejected';
  turnId?: string;
  error?: string;
}

/** Only session-scoped, non-secret native settings cross this boundary. */
export interface AgentChatChoice { id: string; label: string; description?: string }
export interface AgentChatSettings {
  nativeSessionId: string;
  version: string;
  model: string | null;
  models: AgentChatChoice[];
  permission: string | null;
  /** Explains a reported native policy that is not one of the offered presets. */
  permissionLabel?: string;
  permissions: AgentChatChoice[];
  modelReason?: string;
  permissionReason?: string;
  disabledReason?: string;
  scope: string;
}
export interface AgentChatSettingsUpdate {
  version: string;
  field: 'model' | 'permission';
  value: string;
}

// Compatibility names retained while platform implementations migrate to the
// shared Agent chat protocol.
export type CodexChatItem = AgentChatItem;
export type CodexChatRequest = AgentChatRequest;
export type CodexChatSnapshot = AgentChatSnapshot;
export type CodexChatHistoryPage = AgentChatHistoryPage;
export type CodexChatPatch = AgentChatPatch;
export type CodexChatAnswer = AgentChatAnswer;
export type CodexChatSubmission = AgentChatSubmission;
