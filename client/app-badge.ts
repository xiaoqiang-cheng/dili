import type { AppState, Session } from '../shared/types';

const waiting = (session: Session) => (session.status === 'waiting_input' || session.status === 'waiting_approval' || session.status === 'error') && session.unread > 0;

/** What needs the user: personal contacts' reminders, group replies, and group
 * members blocked on approval or an error. A member's finished turn already shows
 * up as its group reply, so it is not counted twice. */
export function badgeCount(state: Pick<AppState, 'sessions' | 'groups'> | null | undefined): number {
  if (!state) return 0;
  const sessions = state.sessions.reduce((count, session) => count + (!session.archived && waiting(session)
    && (!session.groupId || session.status === 'waiting_approval' || session.status === 'error') ? session.unread : 0), 0);
  const groups = state.groups.reduce((count, group) => count + (group.archived ? 0 : group.unread ?? 0), 0);
  return sessions + groups;
}

/** Uses only state already delivered to the page; never starts background work. */
export function updateAppBadge(count: number) {
  if (count > 0) {
    void navigator.setAppBadge?.(count).catch(() => {});
  } else {
    void navigator.clearAppBadge?.().catch(() => {});
  }
}
