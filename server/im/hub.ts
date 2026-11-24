import { randomInt } from 'node:crypto';
import type { GroupMessage, ImChannelKind, Session } from '../../shared/types.ts';
import type { Store } from '../store.ts';
import type { Coordinator, CoordinatorTrigger } from '../coordinator.ts';

/** One message a bound IM channel received. */
export interface ImInbound {
  channel: ImChannelKind;
  /** Where to reply: a Feishu chat_id, a WeChat user id. */
  chatId: string;
  senderId: string;
  senderName?: string;
  messageId: string;
  text: string;
  /** Group chats only reach Dili when the bot is mentioned. */
  group?: boolean;
  mentioned?: boolean;
  /** Adapter data needed to reply in the same conversation (e.g. a context token). */
  replyContext?: unknown;
}

/** A transport: it delivers inbound messages to the hub and sends text back. */
export interface ImAdapter {
  readonly kind: ImChannelKind;
  send(chatId: string, text: string, replyContext?: unknown): Promise<void>;
}

/** Per channel, sealed in Dili's settings: who may talk to 嘀哩 and which topic
 * each chat is in. Credentials live in the adapter's own sealed setting. */
export interface ImBinding {
  owners: string[];
  chats: Record<string, { topicId: string; lastReplyContext?: unknown; lastInboundAt?: string }>;
  pairCode?: { code: string; expiresAt: string };
}

export interface ImHubOptions {
  store: Store;
  coordinator: Pick<Coordinator, 'trigger'>;
  binding(kind: ImChannelKind): ImBinding;
  saveBinding(kind: ImChannelKind, binding: ImBinding): void;
  decideProposal(groupId: string, proposalId: string, approve: boolean): Promise<GroupMessage>;
  onChange(): void;
  now?: () => number;
}

const LABEL: Record<ImChannelKind, string> = { weixin: '微信', feishu: '飞书' };
const PAIR_TTL = 10 * 60_000, MAX_TEXT = 1800;
const HELP = ['嘀哩指令：', '/话题 列出话题', '/切换 序号或标题 切换当前话题', '/新话题 标题 新建话题并切换', '/当前 查看当前话题', '同意 P-xxxx / 拒绝 P-xxxx 处理嘀哩的提议', '其他消息都会发给当前话题里的嘀哩。'].join('\n');

/** IM text is plain: drop Markdown markers that would show up literally. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\w-]*\n?/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1 $2')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
/** Splits long answers at paragraph boundaries for transports with message limits. */
export function chunks(text: string, max = MAX_TEXT): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const cut = Math.max(rest.lastIndexOf('\n\n', max), rest.lastIndexOf('\n', max), max * 0.6 | 0);
    parts.push(rest.slice(0, cut).trim()); rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

export type ImCommand =
  | { type: 'help' } | { type: 'list' } | { type: 'current' }
  | { type: 'switch'; target: string } | { type: 'new'; title: string }
  | { type: 'decide'; proposalId: string; approve: boolean };
/** Deterministic commands, handled by Dili itself and never by the model. */
export function parseCommand(text: string): ImCommand | null {
  const value = text.trim();
  const decide = /^(同意|批准|拒绝)\s*P-([0-9a-f]{4,8})$/i.exec(value);
  if (decide) return { type: 'decide', proposalId: `P-${decide[2]!.toLowerCase()}`, approve: decide[1] !== '拒绝' };
  const command = /^[/／](\S+)\s*([\s\S]*)$/.exec(value);
  if (!command) return null;
  const [, name, arg = ''] = command;
  if (['帮助', 'help', '?', '？'].includes(name!)) return { type: 'help' };
  if (['话题', 'topics', '列表'].includes(name!)) return { type: 'list' };
  if (['当前', 'current'].includes(name!)) return { type: 'current' };
  if (['切换', 'switch'].includes(name!) && arg.trim()) return { type: 'switch', target: arg.trim() };
  if (['新话题', 'new'].includes(name!) && arg.trim()) return { type: 'new', title: arg.trim().slice(0, 120) };
  return { type: 'help' };
}

/** Routes bound IM chats to topics and 嘀哩. Only paired owners are heard: a
 * stranger's message is dropped unless it is the current pairing code. */
export class ImHub {
  private adapters = new Map<ImChannelKind, ImAdapter>();
  private seen: string[] = [];
  private noticed = new Map<string, string>();
  constructor(private readonly options: ImHubOptions) {}

  register(adapter: ImAdapter) { this.adapters.set(adapter.kind, adapter); }
  unregister(kind: ImChannelKind) { this.adapters.delete(kind); }

  /** Adds an owner directly (WeChat: the person who scanned the login QR code). */
  saveOwner(kind: ImChannelKind, owner: string) {
    const binding = this.options.binding(kind);
    if (!binding.owners.includes(owner)) this.options.saveBinding(kind, { ...binding, owners: [...binding.owners, owner] });
    this.options.onChange();
  }
  /** Forgets every owner and chat of a channel; its credentials stay. */
  unbind(kind: ImChannelKind) { this.options.saveBinding(kind, { owners: [], chats: {} }); this.options.onChange(); }
  /** A fresh six-digit code; the first person to send it becomes an owner. */
  newPairCode(kind: ImChannelKind): string {
    const binding = this.options.binding(kind);
    const code = String(randomInt(100000, 1000000));
    this.options.saveBinding(kind, { ...binding, pairCode: { code, expiresAt: new Date(this.now() + PAIR_TTL).toISOString() } });
    return code;
  }

  private now() { return this.options.now?.() ?? Date.now(); }

  async receive(message: ImInbound): Promise<void> {
    const key = `${message.channel}:${message.messageId}`;
    if (this.seen.includes(key)) return;
    this.seen.push(key); if (this.seen.length > 1000) this.seen.splice(0, 500);
    const text = message.text.trim();
    if (!text || (message.group && !message.mentioned)) return;
    let binding = this.options.binding(message.channel);
    if (!binding.owners.includes(message.senderId)) {
      const code = binding.pairCode;
      if (code && Date.parse(code.expiresAt) > this.now() && text === code.code) {
        binding = { ...binding, owners: [...binding.owners, message.senderId], pairCode: undefined };
        this.options.saveBinding(message.channel, binding);
        this.options.onChange();
        await this.reply(message, `已绑定。之后你在这里说的话会发给 Dili 话题里的嘀哩。\n\n${HELP}`);
      }
      return;
    }
    const command = parseCommand(text);
    if (command) { await this.reply(message, await this.command(message, command)); return; }
    const topicId = this.topicFor(message);
    const posted = this.options.store.addMessage({ groupId: topicId, kind: 'note', senderId: null, senderName: '你', recipientIds: [], text, channel: message.channel });
    this.options.onChange();
    this.options.coordinator.trigger(topicId, { type: 'message', messageId: posted.id, channel: message.channel });
  }

  /** The chat's current topic; created on first use. */
  private topicFor(message: ImInbound): string {
    const binding = this.options.binding(message.channel);
    const current = binding.chats[message.chatId]?.topicId;
    const live = current ? this.options.store.group(current) : undefined;
    const topicId = live?.kind === 'topic' && !live.archived ? live.id : this.options.store.addGroup(`${LABEL[message.channel]} · 嘀哩`, `通过${LABEL[message.channel]}和嘀哩的对话。`, 'topic').id;
    this.options.saveBinding(message.channel, { ...binding, chats: { ...binding.chats, [message.chatId]: { topicId, lastReplyContext: message.replyContext, lastInboundAt: new Date(this.now()).toISOString() } } });
    return topicId;
  }

  private topics() { return this.options.store.groups().filter(item => item.kind === 'topic' && !item.archived).sort((a, b) => (b.lastMessage?.at ?? b.createdAt).localeCompare(a.lastMessage?.at ?? a.createdAt)); }

  private async command(message: ImInbound, command: ImCommand): Promise<string> {
    const { store } = this.options;
    const binding = this.options.binding(message.channel);
    const current = binding.chats[message.chatId]?.topicId;
    const select = (topicId: string) => this.options.saveBinding(message.channel, { ...binding, chats: { ...binding.chats, [message.chatId]: { ...binding.chats[message.chatId], topicId, lastReplyContext: message.replyContext } } });
    switch (command.type) {
      case 'help': return HELP;
      case 'list': {
        const topics = this.topics().slice(0, 20);
        return topics.length ? ['话题：', ...topics.map((topic, index) => `${index + 1}. ${topic.title}${topic.id === current ? '（当前）' : ''}`), '回复「/切换 序号」切换。'].join('\n') : '还没有话题，发一条消息就会新建一个。';
      }
      case 'current': {
        const topic = current ? store.group(current) : undefined;
        return topic ? `当前话题：${topic.title}` : '还没有当前话题，发一条消息就会新建一个。';
      }
      case 'switch': {
        const topics = this.topics();
        const index = /^\d+$/.test(command.target) ? Number(command.target) - 1 : -1;
        const topic = topics[index] ?? topics.find(item => item.title === command.target) ?? topics.find(item => item.title.includes(command.target));
        if (!topic) return '没有找到这个话题，回复「/话题」查看列表。';
        select(topic.id);
        return `已切换到：${topic.title}`;
      }
      case 'new': {
        const topic = store.addGroup(command.title, '', 'topic');
        select(topic.id); this.options.onChange();
        return `已新建并切换到：${topic.title}`;
      }
      case 'decide': {
        if (!current) return '当前没有话题。';
        try {
          const result = await this.options.decideProposal(current, command.proposalId, command.approve);
          return result.proposal?.status === 'approved' ? `已同意：${result.proposal.result ?? ''}` : result.proposal?.status === 'failed' ? `加入失败：${result.proposal.result ?? ''}` : '已拒绝。';
        } catch (cause) { return cause instanceof Error ? cause.message : '处理失败'; }
      }
    }
  }

  /** Forwards 嘀哩's answer to the chats whose current topic it is, when the run
   * came from that channel or was a background summary. */
  async coordinatorAnswered(groupId: string, message: GroupMessage, triggers: CoordinatorTrigger[]): Promise<void> {
    const fromIm = new Set(triggers.map(item => item.channel).filter((item): item is ImChannelKind => !!item));
    const background = triggers.every(item => item.type === 'event');
    for (const [kind, adapter] of this.adapters) {
      if (!fromIm.has(kind) && !background) continue;
      const binding = this.options.binding(kind);
      for (const [chatId, chat] of Object.entries(binding.chats)) {
        if (chat.topicId !== groupId) continue;
        await this.send(adapter, chatId, message.text, chat.lastReplyContext);
      }
    }
  }

  /** A participant of an IM-current topic needs the user: say so once per state. */
  async memberChanged(member: Session): Promise<void> {
    if (!member.groupId || !['waiting_approval', 'error'].includes(member.status)) { this.noticed.delete(member.id); return; }
    const state = `${member.status}:${member.statusDetail}`;
    if (this.noticed.get(member.id) === state) return;
    this.noticed.set(member.id, state);
    const text = member.status === 'waiting_approval' ? `${member.title} 在等你审批${member.statusDetail ? `：${member.statusDetail}` : ''}。请在 Dili 里处理。` : `${member.title} 出错了${member.statusDetail ? `：${member.statusDetail}` : ''}。`;
    for (const [kind, adapter] of this.adapters) {
      for (const [chatId, chat] of Object.entries(this.options.binding(kind).chats)) {
        if (chat.topicId === member.groupId) await this.send(adapter, chatId, text, chat.lastReplyContext);
      }
    }
  }

  private async reply(message: ImInbound, text: string) {
    const adapter = this.adapters.get(message.channel);
    if (adapter) await this.send(adapter, message.chatId, text, message.replyContext);
  }
  private async send(adapter: ImAdapter, chatId: string, text: string, context?: unknown) {
    for (const part of chunks(plainText(text) || '（空）')) {
      try { await adapter.send(chatId, part, context); } catch { return; }
    }
  }
}
