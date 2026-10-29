import type { AppState, GroupReadReceipt, StatePatch } from '../shared/types';

/** Read receipts work even when SSE is offline. A delayed receipt must not
 * clear reminders delivered after it, or advance past unrelated pending patches. */
export function applyGroupRead(previous: AppState | null, receipt: GroupReadReceipt): AppState | null {
  if (!previous || previous.instanceId !== receipt.instanceId || (previous.revision ?? 0) > receipt.revision) return previous;
  const { members, instanceId: _instance, revision: _revision, ...group } = receipt;
  const reads = new Map(members.map(member => [member.id, member]));
  return { ...previous,
    groups: previous.groups.map(item => item.id === group.id ? { ...item, unread: group.unread } : item),
    sessions: previous.sessions.map(item => {
      const read = reads.get(item.id);
      return read && item.groupId === group.id ? { ...item, unread: read.unread } : item;
    }),
  };
}

/** A partial read does not advance the global patch cursor. Retain it across
 * overlapping old snapshots until a newer server revision supersedes it. */
export function applyPendingGroupReads(next: AppState, receipts: Map<string, GroupReadReceipt>): AppState {
  for (const [id, receipt] of receipts) {
    if (next.instanceId !== receipt.instanceId || (next.revision ?? 0) > receipt.revision) receipts.delete(id);
    else next = applyGroupRead(next, receipt)!;
  }
  return next;
}

function upsert<T extends { id: string }>(previous: T[], updates?: T[]): T[] {
  if (!updates?.length) return previous;
  const result = new Map(previous.map(item => [item.id, item]));
  for (const item of updates) result.set(item.id, item);
  return [...result.values()];
}

/** null requests a fresh snapshot; obsolete patches preserve object identity. */
export function applyStatePatch(previous: AppState | null, patch: StatePatch): AppState | null {
  if (!previous || patch.instanceId !== previous.instanceId || typeof previous.revision !== 'number') return null;
  if (!Number.isSafeInteger(patch.revision) || !Number.isSafeInteger(patch.baseRevision) || patch.revision < patch.baseRevision) return null;
  if (patch.revision <= previous.revision) return previous;
  if (patch.baseRevision > previous.revision) return null;
  const activities = patch.activities ? upsert([...previous.activities].reverse(), patch.activities.upsert)
    .filter(item => !patch.activities!.remove.includes(item.id)).reverse().slice(0, 100) : previous.activities;
  return { ...previous, revision: patch.revision, sessions: upsert(previous.sessions, patch.sessions), groups: upsert(previous.groups, patch.groups), activities, backends: patch.backends ?? previous.backends };
}
