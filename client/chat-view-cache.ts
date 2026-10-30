import type { AppState, ConversationTranscript, Session } from '../shared/types';
import type { AgentChatSnapshot } from '../shared/chat';

const identity = (session: Session) => JSON.stringify([session.backend, session.nativeSessionId, session.forkPending, session.cwd]);
/** Recent reading material only: never persisted and never an authority for actions. */
class ViewCache<T> {
  private entries = new Map<string, { identity: string; value: T; size: number; saved: number }>();
  get(session: Session): T | null {
    const entry = this.entries.get(session.id);
    if (!entry) return null;
    if (entry.identity !== identity(session) || Date.now() - entry.saved > 600_000) { this.entries.delete(session.id); return null; }
    this.entries.delete(session.id); this.entries.set(session.id, entry);
    return entry.value;
  }
  put(session: Session, value: T) {
    this.entries.delete(session.id);
    const size = JSON.stringify(value).length;
    if (size > 1_000_000) return;
    this.entries.set(session.id, { identity: identity(session), value, size, saved: Date.now() });
    let total = [...this.entries.values()].reduce((sum, entry) => sum + entry.size, 0);
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= 8 && total <= 2_000_000) break;
      this.entries.delete(key); total -= entry.size;
    }
  }
  sync(sessions: Session[]) {
    const known = new Map(sessions.map(session => [session.id, identity(session)]));
    for (const [key, entry] of this.entries) if (known.get(key) !== entry.identity) this.entries.delete(key);
  }
  clear() { this.entries.clear(); }
}
export const chatViews = new ViewCache<AgentChatSnapshot>();
export const transcriptViews = new ViewCache<ConversationTranscript>();
let instance: string | undefined;
export function syncChatViews(state: Pick<AppState, 'instanceId' | 'sessions'>) {
  if (instance !== state.instanceId) { chatViews.clear(); transcriptViews.clear(); instance = state.instanceId; }
  chatViews.sync(state.sessions); transcriptViews.sync(state.sessions);
}

export function cachedChatView(session: Session): AgentChatSnapshot | null {
  const snapshot = chatViews.get(session);
  // Approval buttons, queued submissions and active-turn controls must wait for
  // the live connection to confirm the current state, even on a warm reopen.
  return snapshot ? { ...snapshot, connected: false, requests: [], activeTurnId: null } : null;
}
