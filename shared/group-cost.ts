import type { Delivery, GroupMessage } from './types.ts';
import type { SessionUsage } from './usage.ts';

/**
 * Group cost accounting.
 *
 * A member session can belong to one group only, but it keeps running outside
 * the group and its native history spans everything it ever did. Summing
 * member totals would therefore count private work as group cost, and a
 * single number could not say which task paid for what.
 *
 * Only native numbers enter this module. When a member reports no usage the
 * task is listed as unknown instead of being estimated from text length.
 */

export interface GroupTaskCost {
  /** Task tag written into the member's prompt, or the delivery id for briefings. */
  key: string;
  deliveryId: string;
  memberId: string;
  memberName: string;
  /** 'briefing' is the one-time join message, not a user task. */
  kind: 'task' | 'briefing';
  createdAt: string;
  replyMessageId: string | null;
  /** Billed tokens the member reported for its whole session, or null. */
  totalTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  /** True when the member's native record was only partly readable. */
  partial: boolean;
}

export interface GroupCost {
  /** Task rows, oldest first. */
  tasks: GroupTaskCost[];
  /** Members that actually carried at least one task. */
  members: { id: string; name: string; tasks: number }[];
  /**
   * Sum over tasks whose member reported native usage; null when none did.
   * A member's number covers its whole native session, so a member that also
   * worked outside this group can overstate this row. The UI states that.
   */
  totalTokens: number | null;
  /** How many tasks could not be attributed to a native number. */
  unknown: number;
  /** True when any attributed task came from a partial native window. */
  partial: boolean;
}

type UsageSource = { id: string; title: string; usage?: SessionUsage | null };

export function groupCost(
  groupId: string,
  messages: readonly Pick<GroupMessage, 'id' | 'groupId' | 'senderId' | 'senderName' | 'kind'>[],
  deliveries: readonly Pick<Delivery, 'id' | 'sessionId' | 'tag' | 'briefing' | 'replyMessageId' | 'createdAt'>[],
  members: readonly UsageSource[],
): GroupCost {
  const senderOf = new Map(messages.filter(item => item.groupId === groupId).map(item => [item.id, item] as const));
  const memberOf = new Map(members.map(member => [member.id, member] as const));
  const tasks: GroupTaskCost[] = deliveries.map(delivery => {
    // The delivery's member answers it; a reply message names the same sender.
    const reply = delivery.replyMessageId ? senderOf.get(delivery.replyMessageId) : undefined;
    const member = memberOf.get(delivery.sessionId);
    const usage = member?.usage ?? null;
    const kind = delivery.briefing ? 'briefing' as const : 'task' as const;
    return {
      key: delivery.tag ?? delivery.id,
      deliveryId: delivery.id,
      memberId: delivery.sessionId,
      memberName: member?.title ?? reply?.senderName ?? `${delivery.sessionId.slice(0, 8)}…`,
      kind,
      createdAt: delivery.createdAt,
      replyMessageId: delivery.replyMessageId ?? null,
      totalTokens: usage ? usage.totalTokens : null,
      inputTokens: usage ? usage.inputTokens : null,
      outputTokens: usage ? usage.outputTokens : null,
      cacheReadTokens: usage ? usage.cacheReadTokens : null,
      partial: usage?.partial === true,
    };
  }).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const counted = tasks.filter(task => task.totalTokens !== null);
  const byMember = new Map<string, { id: string; name: string; tasks: number }>();
  for (const task of tasks) {
    const entry = byMember.get(task.memberId) ?? { id: task.memberId, name: task.memberName, tasks: 0 };
    entry.tasks++;
    byMember.set(task.memberId, entry);
  }
  return {
    tasks,
    members: [...byMember.values()].sort((a, b) => b.tasks - a.tasks || a.name.localeCompare(b.name, 'zh-CN')),
    totalTokens: counted.length ? counted.reduce((sum, task) => sum + (task.totalTokens ?? 0), 0) : null,
    unknown: tasks.length - counted.length,
    partial: counted.some(task => task.partial),
  };
}
