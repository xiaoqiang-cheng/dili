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
  try {
    const update = count > 0 ? navigator.setAppBadge?.(count) : navigator.clearAppBadge?.();
    void update?.catch(() => {});
  } catch { /* Unsupported browser policies must not interrupt the workspace. */ }
  void updateTabBadge(count);
}

let icon: HTMLLinkElement | null = null;
let original = '';
let originalType = '';
let image: Promise<HTMLImageElement> | undefined;
let latest = 0;
/** A tab favicon fallback for browsers/OSes without installed-app badging. */
async function updateTabBadge(count: number) {
  latest = count;
  icon ??= document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!icon) return;
  if (!original) { original = icon.href; originalType = icon.type; }
  if (!count) { icon.href = original; icon.type = originalType; return; }
  try {
    image ??= new Promise<HTMLImageElement>((resolve, reject) => {
      const logo = new Image();
      logo.onload = () => resolve(logo); logo.onerror = () => reject(new Error('Icon unavailable'));
      logo.src = original;
    });
    const logo = await image;
    if (count !== latest) return;
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(logo, 0, 0, 64, 64);
    ctx.fillStyle = '#dc3545'; ctx.beginPath(); ctx.arc(46, 18, 18, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffffff'; ctx.font = `bold ${count > 99 ? 17 : count > 9 ? 21 : 25}px system-ui`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(count > 99 ? '99+' : String(count), 46, 19);
    icon.type = 'image/png'; icon.href = canvas.toDataURL('image/png');
  } catch { image = undefined; /* Keep the original logo if image loading fails. */ }
}
