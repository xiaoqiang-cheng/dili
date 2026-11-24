import type { ConversationTranscript, Session } from '../shared/types.ts';
import { taskTagLine } from '../shared/group-prompt.ts';
import type { Store } from './store.ts';

export interface DirectTurn { userId: string; userText: string; replyText: string; closed: boolean }

/** Turns the agent starts itself continue the previous turn; they are not the user's. */
const automaticTurn = (text: string) => /^\s*<(?:task-notification|system-reminder)\b/.test(text);

/** Turns the user typed directly in a topic participant's session, after it
 * joined the topic. History before its first topic message is the fork source's
 * and stays private; turns carrying a topic task number are already in the topic.
 * A turn counts once its answer exists; `closed` means a later human turn
 * exists, so the answer is final. */
export function directTurns(transcript: ConversationTranscript, tags: string[], joinedAt?: string): DirectTurn[] {
  const messages = transcript.messages;
  const markers = tags.map(taskTagLine);
  const topicTurn = (text: string) => markers.some(marker => text.includes(marker));
  const first = messages.findIndex(message => message.role === 'user' && topicTurn(message.text));
  // Without a visible topic turn (a truncated window), only turns dated after
  // joining are safe to attribute to the topic.
  const joined = joinedAt ? Date.parse(joinedAt) : NaN;
  const start = first >= 0 ? first + 1 : Number.isFinite(joined) ? messages.findIndex(message => message.createdAt !== undefined && Date.parse(message.createdAt) >= joined) : -1;
  if (start < 0) return [];
  const turns: DirectTurn[] = [];
  for (let index = start; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role !== 'user' || automaticTurn(message.text) || topicTurn(message.text)) continue;
    let reply = '', closed = false;
    for (const next of messages.slice(index + 1)) {
      if (next.role === 'user') { if (automaticTurn(next.text)) continue; closed = true; break; }
      if (next.text.trim() && !next.tool) reply = next.text.trim();
    }
    if (reply) turns.push({ userId: message.id, userText: message.text.trim(), replyText: reply, closed });
  }
  return turns;
}

const FINISHED = new Set(['idle', 'waiting_input', 'error', 'stopped']);

/** Mirrors a topic participant's own-session turns into the topic, so talking in
 * the topic and talking in the member's chat are the same conversation. */
export class TopicMirror {
  private running = new Set<string>();
  private timers = new Map<string, NodeJS.Timeout>();
  private closed = false;
  constructor(private readonly options: { store: Store; read(session: Session): Promise<ConversationTranscript>; turnOpen(session: Session): boolean; onChange(): void; delayMs?: number }) {}

  statusChanged(session: Session) {
    if (this.closed || !session.groupId || !FINISHED.has(session.status)) return;
    if (this.options.store.group(session.groupId)?.kind !== 'topic') return;
    clearTimeout(this.timers.get(session.id));
    const timer = setTimeout(() => { this.timers.delete(session.id); void this.collect(session.id); }, this.options.delayMs ?? 1500);
    timer.unref?.();
    this.timers.set(session.id, timer);
  }

  private async collect(sessionId: string) {
    if (this.closed || this.running.has(sessionId)) return;
    const session = this.options.store.session(sessionId);
    if (!session?.groupId || !FINISHED.has(session.status) || this.options.turnOpen(session)) return;
    const tags = this.options.store.deliveries().filter(item => item.sessionId === sessionId && item.tag).map(item => item.tag!);
    this.running.add(sessionId);
    try {
      const transcript = await this.options.read(session);
      const current = this.options.store.session(sessionId);
      if (this.closed || current?.groupId !== session.groupId || current.nativeSessionId !== session.nativeSessionId) return;
      let changed = false;
      for (const turn of directTurns(transcript, tags, session.createdAt)) changed = this.options.store.mirrorTurn(sessionId, turn) || changed;
      if (changed) this.options.onChange();
    } catch { /* Unreadable history is retried on the next status change. */ }
    finally { this.running.delete(sessionId); }
  }

  close() { this.closed = true; for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); }
}
