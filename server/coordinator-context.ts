import type { Group, GroupMessage, ImChannelKind, Session } from '../shared/types.ts';

/** What the coordinator sees each time it is asked: its rules, then a compact
 * view of the topic. Nothing else is remembered between runs; the topic itself
 * is the memory, and older or longer content stays behind [#n] references that
 * the read tools expand on demand. */
export const COORDINATOR_NAME = '嘀哩';
const RECENT = 20, LINE = 500, POST = 1500;

const clip = (text: string, max: number) => {
  const value = text.replace(/\s+\n/g, '\n').trim();
  return value.length > max ? `${value.slice(0, max)}…（截断，read_message 可读全文）` : value;
};

export function coordinatorRules(channel?: ImChannelKind): string {
  return [
    `你是「${COORDINATOR_NAME}」，Dili 工作台话题里的协调员。用户在话题里不 @ 任何参与者时，由你来回复。`,
    '你的职责：和用户正常对话；帮用户管理这个话题的上下文（回忆之前的讨论和结论、说明谁在做什么、汇总参与者的回答）；在用户要求时把工作派给参与者。',
    '你不能执行命令、读写文件或访问代码，你只有下面列出的话题工具。需要动手的工作只能派给参与者（他们是 Claude、Codex 等编码 Agent）。',
    '规则：',
    '- 只有用户明确要求或同意时才调用 dispatch_task 派活；派活时写清楚要做什么、验收标准，并引用相关消息 [#n]。',
    '- 想拉现有会话或新建 AI 加入话题时，用 propose_participant 提议，由用户批准；不要假设已经加入。',
    '- 不要编造参与者的进度或结论，也不要说某条消息里有它没写的内容；需要细节时先用工具读取。引用话题消息时写 [#n]，只引用确实相关的那条。',
    '- 不替用户做决定：审批、合并、推送、部署都由用户本人完成。',
    '- 用中文回答，简洁直接，不寒暄。',
    ...(channel ? [`- 用户正在通过${channel === 'weixin' ? '微信' : '飞书'}和你对话：每次回复尽量不超过 150 字，不用表格；只在需要用户决策或验收时多说。`] : []),
  ].join('\n');
}

export interface TopicSnapshot {
  topic: Group;
  members: Session[];
  /** Most recent page of the topic, oldest first, with sequence numbers. */
  messages: (GroupMessage & { sequence?: number })[];
  total: number;
}

const kindLabel = (message: GroupMessage) => message.agent === 'coordinator' ? (message.proposal ? '嘀哩·提议' : '嘀哩') : message.kind === 'task' ? '派活' : message.kind === 'reply' ? (message.failed ? '回复失败' : message.pending ? '回复中' : '回复') : message.kind === 'result' ? '结果' : '发言';

export function topicSnapshot({ topic, members, messages, total }: TopicSnapshot, memberName: (id: string) => string): string {
  const roster = members.length
    ? members.map(member => `- ${member.title}（id: ${member.id}，${member.backend}，状态：${member.status}${member.statusDetail ? ` · ${clip(member.statusDetail, 80)}` : ''}）`).join('\n')
    : '- 还没有参与者';
  const recent = messages.slice(-RECENT);
  const earlier = Math.max(0, total - recent.length);
  const lines = recent.map(message => {
    const to = message.recipientIds.length ? ` → ${message.recipientIds.map(memberName).join('、')}` : '';
    return `[#${message.sequence ?? '?'}] ${message.senderName}（${kindLabel(message)}${to}${message.channel ? `，来自${message.channel === 'weixin' ? '微信' : '飞书'}` : ''}）：${clip(message.text || (message.attachments?.length ? '[图片]' : ''), LINE)}`;
  });
  return [
    `## 当前话题`,
    `标题：${topic.title}（话题 id: ${topic.id}）`,
    `原帖：${topic.goal.trim() ? clip(topic.goal, POST) : '（无）'}`,
    '## 参与者', roster,
    `## 最近的消息${earlier ? `（更早还有 ${earlier} 条，可用 read_messages 往前读）` : ''}`,
    lines.length ? lines.join('\n') : '（还没有消息）',
  ].join('\n');
}
