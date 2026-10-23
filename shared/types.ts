import type { ExecutionMode } from './execution.ts';

export type Backend = 'claude' | 'codex' | 'dsh';
export type SessionStatus = 'idle' | 'running' | 'waiting_input' | 'waiting_approval' | 'error' | 'stopped' | 'unknown';
export type StatusSource = 'native' | 'terminal' | 'manual' | 'process';

export interface BackendInfo {
  id: Backend;
  label: string;
  installed: boolean;
  version: string | null;
  capabilities: { terminal: boolean; resume: boolean; fork: boolean; discovery: boolean; nativeControl?: boolean; graphicalChat?: boolean; autoMode?: boolean };
  note?: string;
}

export interface Session {
  id: string;
  backend: Backend;
  title: string;
  cwd: string;
  nativeSessionId: string | null;
  nativeUrl?: string | null;
  groupId: string | null;
  parentId: string | null;
  forkPending: boolean;
  status: SessionStatus;
  statusSource: StatusSource;
  statusDetail: string;
  /** Recoverable native startup errors, persisted so reconnects retain their actions. */
  errorCode?: string | null;
  lastActivity: string;
  /** Short excerpt from the latest persisted human input; never terminal output. */
  lastUserInput?: string | null;
  lastUserInputAt?: string | null;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  pinned: boolean;
  unread: number;
  /** Stable native attention identity prevents replayed events from reminding twice. */
  lastAttentionKey?: string | null;
  running: boolean;
  /** Native graphical transport or interactive PTY. */
  interactionMode?: 'chat' | 'terminal';
  /** Execution owner, separate from the currently displayed view. */
  executionTransport?: 'structured' | 'pty' | 'web';
  /** Claude print mode saves a new/forked identity only after its first input.
   * Retain the bootstrap until then so closing an empty chat remains resumable. */
  claudeUnwritten?: { sourceId: string | null };
  /** Per-contact native permission preset; absent means native defaults. */
  executionMode?: ExecutionMode;
  origin: 'created' | 'imported' | 'forked' | 'handoff';
}

export interface DiscoveredSession {
  backend: Backend;
  nativeSessionId: string;
  title: string;
  cwd: string;
  lastActivity: string;
  /** Availability on the machine running SessionDeck, checked at discovery time. */
  cwdAvailable?: boolean;
}

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt?: string;
}

export interface ConversationTranscript {
  messages: ConversationMessage[];
  updatedAt?: string;
  truncated: boolean;
  notice?: string;
}

export interface Group {
  id: string;
  title: string;
  goal: string;
  createdAt: string;
  updatedAt: string;
}

export interface GroupMessage {
  id: string;
  groupId: string;
  senderId: string | null;
  senderName: string;
  kind: 'note' | 'task' | 'result';
  text: string;
  recipientIds: string[];
  /** Existing message this handoff continues; always from the same group. */
  sourceMessageId?: string | null;
  createdAt: string;
  /** Persistent change cursor and chronological page position. */
  revision?: number;
  sequence?: number;
}

export interface Delivery {
  id: string;
  messageId: string;
  sessionId: string;
  text: string;
  status: 'pending' | 'sending' | 'unknown' | 'staged' | 'sent' | 'cancelled';
  createdAt: string;
  sentAt: string | null;
  attempts?: DeliveryAttempt[];
  lastError?: string;
}

export interface DeliveryAttempt {
  id: string;
  mode: 'sent' | 'staged';
  startedAt: string;
  finishedAt?: string;
  outcome: 'sending' | 'unknown' | 'rejected' | 'sent' | 'staged';
  resolution?: 'confirmed' | 'not_received' | 'cancelled';
}

export interface Activity {
  id: string;
  sessionId: string | null;
  type: string;
  text: string;
  createdAt: string;
}

export interface AppState {
  /** Order snapshots across HTTP and SSE; a new process has a new instance ID. */
  instanceId?: string;
  revision?: number;
  sessions: Session[];
  groups: Group[];
  backends: BackendInfo[];
  activities: Activity[];
  defaultCwd: string;
  demo: boolean;
}

export interface GroupDetail {
  group: Group;
  messages: GroupMessage[];
  deliveries: Omit<Delivery, 'text'>[];
  page?: { before: number | null; total: number };
  revision?: string;
  nextSince?: string | null;
}

export interface StatePatch {
  instanceId: string;
  baseRevision: number;
  revision: number;
  sessions?: Session[];
  groups?: Group[];
  activities?: { upsert: Activity[]; remove: string[] };
  backends?: BackendInfo[];
}
