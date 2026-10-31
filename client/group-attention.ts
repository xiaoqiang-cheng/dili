import type { Group, Session } from '../shared/types';

/** Actionable member reminders affect attention sorting, not the group's message
 * unread count. Reading group replies does not resolve an approval or error. */
export const memberNeedsAction = (member: Session) => !member.archived && member.unread > 0 && (member.status === 'waiting_approval' || member.status === 'error');

export const groupNeedsAttention = (group: Group, members: Session[]) => (group.unread ?? 0) > 0 || members.some(memberNeedsAction);
