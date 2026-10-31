import type { Backend, Group, Session, SessionStatus } from '../shared/types';
import { groupNeedsAttention } from './group-attention';

/** Contact list ordering, extracted so the tier and sort rules are testable. */

export type ContactSort = 'input' | 'name' | 'created';
export type ContactFilterStatus = SessionStatus | 'attention' | 'unread' | 'all';
export type ListMode = 'contacts' | 'attention' | 'running' | 'archive';

export type ContactEntry =
  | { kind: 'session'; id: string; session: Session }
  | { kind: 'group'; id: string; group: Group; members: Session[] };

export interface ContactQuery {
  sessions: Session[];
  groups: Group[];
  mode: ListMode;
  backend: Backend | 'all';
  status: ContactFilterStatus;
  query: string;
  sort: ContactSort;
}

const BACKEND_LABEL: Record<Backend, string> = { claude: 'Claude Code', codex: 'Codex', dsh: 'DeepSeek Harness' };

/** The agent is blocked on a person: waiting for input or approval, or failed. */
export const attention = (session: Session) => session.status === 'waiting_input' || session.status === 'waiting_approval' || session.status === 'error';
/** Red badge: blocked on a person AND not looked at since. Opening clears it. */
export const pending = (session: Session) => attention(session) && session.unread > 0;

const timestamp = (value?: string | null) => value ? Date.parse(value) || 0 : 0;
const nameOf = (entry: ContactEntry) => entry.kind === 'group' ? entry.group.title : entry.session.title;
const compareName = (a: ContactEntry, b: ContactEntry) => nameOf(a).localeCompare(nameOf(b), 'zh-CN', { numeric: true, sensitivity: 'base' });

/** Four tiers, shared by the list and the help text: pinned, red reminder,
 * active task, waiting without a reminder; everything else last. */
export function contactTier(entry: ContactEntry): number {
  if (entry.kind === 'group') {
    const live = entry.members.filter(member => !member.archived);
    return entry.group.pinned ? 0 : groupNeedsAttention(entry.group, live) ? 1 : live.some(member => member.status === 'running') ? 2 : 4;
  }
  const session = entry.session;
  return session.pinned ? 0 : pending(session) && !session.archived ? 1 : session.status === 'running' ? 2 : session.status === 'waiting_input' ? 3 : 4;
}

export function compareContacts(a: ContactEntry, b: ContactEntry, sort: ContactSort): number {
  const priority = contactTier(a) - contactTier(b);
  if (priority) return priority;
  if (sort === 'name') return compareName(a, b);
  if (sort === 'input') {
    // A group's latest message plays the role of a contact's latest input.
    const input = (entry: ContactEntry) => timestamp(entry.kind === 'group' ? entry.group.lastMessage?.at : entry.session.lastUserInputAt);
    const inputOrder = input(b) - input(a);
    if (inputOrder) return inputOrder;
  }
  const created = (entry: ContactEntry) => timestamp(entry.kind === 'group' ? entry.group.createdAt : entry.session.createdAt);
  return created(b) - created(a) || compareName(a, b);
}

function sessionVisible(session: Session, input: ContactQuery): boolean {
  const { mode, backend, status } = input;
  if (mode === 'archive' ? !session.archived : mode === 'attention' ? session.archived || !pending(session) : mode === 'running' ? session.archived || session.status !== 'running' : session.archived || !!session.groupId) return false;
  return (backend === 'all' || session.backend === backend)
    && (status === 'all' || (status === 'attention' ? attention(session) : status === 'unread' ? session.unread > 0 : session.status === status))
    && `${session.title} ${session.cwd} ${session.lastUserInput || ''} ${BACKEND_LABEL[session.backend]}`.toLowerCase().includes(input.query.trim().toLowerCase());
}

function groupVisible(group: Group, members: Session[], input: ContactQuery): boolean {
  const { mode, backend, status } = input;
  if (!['contacts', 'attention', 'archive'].includes(mode)) return false;
  if (!['all', 'attention', 'unread'].includes(status)) return false;
  if (mode === 'archive' ? !group.archived : group.archived) return false;
  if ((mode === 'attention' || status !== 'all') && !groupNeedsAttention(group, members)) return false;
  if (backend !== 'all' && !members.some(member => member.backend === backend)) return false;
  return `${group.title} ${group.goal} ${members.map(member => member.title).join(' ')}`.toLowerCase().includes(input.query.trim().toLowerCase());
}

export function buildContacts(input: ContactQuery): ContactEntry[] {
  const membersOf = (id: string) => input.sessions.filter(session => session.groupId === id);
  const entries: ContactEntry[] = [
    ...input.sessions.filter(session => sessionVisible(session, input)).map(session => ({ kind: 'session' as const, id: session.id, session })),
    ...input.groups.filter(group => groupVisible(group, membersOf(group.id), input)).map(group => ({ kind: 'group' as const, id: group.id, group, members: membersOf(group.id) })),
  ];
  return entries.sort((a, b) => compareContacts(a, b, input.sort));
}

/** Progressive rendering keeps a large contact list from mounting every card. */
export const CONTACT_RENDER_STEP = 120;

export function visibleContacts(entries: ContactEntry[], limit: number): ContactEntry[] {
  if (!Number.isFinite(limit) || limit <= 0) return entries.slice(0, CONTACT_RENDER_STEP);
  return entries.slice(0, Math.max(CONTACT_RENDER_STEP, Math.floor(limit)));
}
