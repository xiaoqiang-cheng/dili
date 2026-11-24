import { t } from '../shared/i18n';
import type { BackendInfo, Group, GroupMessage, Session } from '../shared/types';

/** Pinned first, then the topic with the latest activity. */
export function sortTopics(topics: Group[]): Group[] {
  const at = (topic: Group) => Date.parse(topic.lastMessage?.at ?? topic.createdAt) || 0;
  return [...topics].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || at(b) - at(a));
}

/** The card's second line: the latest message, else the opening post. */
export function topicPreview(topic: Group): string {
  if (topic.lastMessage) return `${topic.lastMessage.senderName}：${topic.lastMessage.text}`;
  return topic.goal.replace(/\s+/g, ' ').trim().slice(0, 160) || t('topic.noReplies');
}

/** An existing contact joins a topic as a native fork of its session. */
export function canJoinTopic(session: Session, backends: BackendInfo[]): { ok: true } | { ok: false; reason: string } {
  const backend = backends.find(item => item.id === session.backend);
  if (!backend?.capabilities.fork) return { ok: false, reason: t('topic.noFork', { backend: backend?.label ?? session.backend }) };
  if (!session.nativeSessionId || session.forkPending) return { ok: false, reason: t('topic.notStarted') };
  return { ok: true };
}

export { forkTitle } from '../shared/topic-names';

/** Where a topic works: its own workspace, else the directory most of its
 * participants use. '' when nobody has joined yet. */
export function topicDirectory(topic: Pick<Group, 'workspace'>, members: Pick<Session, 'cwd' | 'archived'>[]): string {
  if (topic.workspace) return topic.workspace;
  const counts = new Map<string, number>();
  for (const member of members) if (!member.archived && member.cwd) counts.set(member.cwd, (counts.get(member.cwd) ?? 0) + 1);
  let best = '', most = 0;
  for (const [cwd, count] of counts) if (count > most || (count === most && cwd < best)) { best = cwd; most = count; }
  return best;
}

/** The last two path segments, enough to tell projects apart. */
export const directoryLabel = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).slice(-2).join('/') || path;

export interface TopicCategory { key: string; label: string; path: string; topics: Group[] }

/** Channels grouped by working directory, like a server's categories. Inside a
 * category: pinned, then latest activity. Categories follow their busiest topic;
 * topics without participants come last. Two directories with the same short
 * label show their full path. */
export function topicCategories(topics: Group[], sessions: Session[]): TopicCategory[] {
  const byPath = new Map<string, Group[]>();
  for (const topic of topics) {
    const path = topicDirectory(topic, sessions.filter(session => session.groupId === topic.id));
    byPath.set(path, [...(byPath.get(path) ?? []), topic]);
  }
  const at = (topic: Group) => Date.parse(topic.lastMessage?.at ?? topic.createdAt) || 0;
  const labels = new Map<string, number>();
  for (const path of byPath.keys()) if (path) labels.set(directoryLabel(path), (labels.get(directoryLabel(path)) ?? 0) + 1);
  return [...byPath].map(([path, items]) => ({ key: path || '-', path, label: !path ? t('topic.uncategorized') : (labels.get(directoryLabel(path)) ?? 0) > 1 ? path : directoryLabel(path), topics: sortTopics(items) }))
    .sort((a, b) => Number(!a.path) - Number(!b.path) || Math.max(...b.topics.map(at)) - Math.max(...a.topics.map(at)) || a.label.localeCompare(b.label));
}

const CONTINUE_MS = 5 * 60_000;
/** A message continues the previous one (no avatar or name) when the same
 * sender posts within five minutes; a task or a mirrored turn always starts fresh. */
export function continuesPrevious(previous: Pick<GroupMessage, 'senderId' | 'senderName' | 'kind' | 'createdAt' | 'via'> | undefined, message: Pick<GroupMessage, 'senderId' | 'senderName' | 'kind' | 'createdAt' | 'via'>): boolean {
  if (!previous || message.kind === 'task' || previous.kind === 'task' || !!message.via !== !!previous.via) return false;
  if (previous.senderId !== message.senderId || previous.senderName !== message.senderName) return false;
  const gap = Date.parse(message.createdAt) - Date.parse(previous.createdAt);
  return gap >= 0 && gap < CONTINUE_MS;
}
