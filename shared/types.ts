import type { ChatAttachment } from './attachments.ts';
import type { ExecutionMode } from './execution.ts';

export type Backend = 'claude' | 'codex' | 'dsh';
export type SessionStatus = 'idle' | 'running' | 'waiting_input' | 'waiting_approval' | 'error' | 'stopped' | 'unknown';
export type StatusSource = 'native' | 'terminal' | 'manual' | 'process';

export interface BackendInfo {
  id: Backend;
  label: string;
  installed: boolean;
  version: string | null;
  capabilities: {
    terminal: boolean; resume: boolean; fork: boolean; discovery: boolean; nativeControl?: boolean; graphicalChat?: boolean; autoMode?: boolean;
    /** Native permission modes reported by the installed CLI (Claude). */
    permissionModes?: string[];
    /** The CLI can offer bypassPermissions as a switchable mode without enabling it. */
    bypassOption?: boolean;
    additionalDirectories?: boolean;
  };
  note?: string;
}

export interface NativeSettings { model?: string; permission?: string }
export interface MemberWorktree {
  /** Worktree root created by Dili; cwd is this root or the same subdirectory as the group workspace. */
  path: string;
  branch: string;
  /** Repository root of the group workspace the branch merges back into. */
  repository: string;
  /** Commit the branch started from. */
  base: string;
}
export interface WorktreeStatus { branch: string; ahead: number; behind: number; uncommitted: number; workspaceDirty: number; merged: boolean }

export interface Session {
  id: string;
  backend: Backend;
  title: string;
  cwd: string;
  /** Extra native workspace permissions; primary cwd stays unchanged. */
  additionalDirectories?: string[];
  /** Saved while the executor was running; applied on its next launch. */
  directoriesPending?: boolean;
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
  /** Contact-scoped native settings shared by every executor of this contact
   * (Claude graphical and terminal). Absent fields follow native defaults. */
  nativeSettings?: NativeSettings;
  /** Group member working in its own git worktree instead of the group workspace. */
  worktree?: MemberWorktree;
  /** Group rules this member last received (briefingVersion); a change resends them. */
  groupBriefing?: string;
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
  /** Custom group prompt; empty means DEFAULT_GROUP_PROMPT. */
  prompt?: string;
  /** Shared working directory for members; isolated worktrees branch from its repository. */
  workspace?: string;
  pinned?: boolean;
  /** Hide from active contacts without deleting history or changing members. */
  archived?: boolean;
  /** Member replies not yet seen by the user. */
  unread?: number;
  lastMessage?: { text: string; senderName: string; at: string } | null;
  createdAt: string;
  updatedAt: string;
}

/** Authoritative read receipt, including member reminders cleared by reading. */
export interface GroupReadReceipt extends Group {
  members: Pick<Session, 'id' | 'unread' | 'updatedAt'>[];
  instanceId: string;
  revision: number;
}

export interface GroupMessage {
  attachments?: ChatAttachment[];
  id: string;
  groupId: string;
  senderId: string | null;
  senderName: string;
  /** reply: a member's answer to a group task, collected automatically. */
  kind: 'note' | 'task' | 'result' | 'reply';
  text: string;
  recipientIds: string[];
  /** Existing message this handoff continues; always from the same group. */
  sourceMessageId?: string | null;
  /** Member answers quoted into a task; only these cross to the recipients. */
  references?: string[];
  /** reply only: the delivery it answers and the native message it came from. */
  deliveryId?: string;
  nativeMessageId?: string;
  /** reply only: the member's task turn ended in an error without an answer. */
  failed?: boolean;
  /** reply only: the member is working on this task again; the answer may still change. */
  pending?: boolean;
  /** reply only: a later human turn closed the task; the answer is final. */
  closedAt?: string;
  /** reply only: answer to the one-time join briefing (a greeting), not a task. */
  briefing?: boolean;
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
  /** Short task number written into the text; locates the turn in native history. */
  tag?: string;
  /** The one-time join briefing rather than a user task. */
  briefing?: boolean;
  /** Set once the member's reply was collected into the group. */
  replyMessageId?: string;
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
