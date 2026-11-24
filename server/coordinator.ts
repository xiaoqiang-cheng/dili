import { randomBytes } from 'node:crypto';
import type { Backend, BackendInfo, ConversationTranscript, GroupMessage, ImChannelKind, Session, TopicProposal } from '../shared/types.ts';
import type { Store } from './store.ts';
import { chatCompletion, LlmError, type LlmApi, type LlmMessage, type LlmTool } from './llm.ts';
import { coordinatorRules, topicSnapshot } from './coordinator-context.ts';

/** Default model for the coordinator; the key and URL come from the user's
 * managed dsh/Pi API configuration. */
export const COORDINATOR_MODEL = 'deepseek-v4-flash';
const MAX_STEPS = 6, MAX_DISPATCH = 2, MAX_PROPOSALS = 3, TOOL_RESULT = 12_000;

export type CoordinatorTrigger =
  | { type: 'message'; messageId: string; channel?: ImChannelKind }
  | { type: 'event'; text: string; channel?: ImChannelKind };

export interface CoordinatorOptions {
  store: Store;
  /** The configured API, or null when none is set up. */
  api(): Promise<Omit<LlmApi, 'model'> & { model?: string } | null>;
  model?: string;
  backends(): BackendInfo[];
  defaultCwd(): string;
  readTranscript(session: Session): Promise<ConversationTranscript>;
  /** Sends one pending delivery to its member now (starting it if needed). */
  deliver(deliveryId: string): Promise<unknown>;
  onChange(): void;
  /** Called with every settled coordinator answer, e.g. to forward it to IM. */
  onAnswer?(groupId: string, message: GroupMessage, trigger: CoordinatorTrigger[]): void;
  fetcher?: typeof fetch;
}

const clip = (text: string, max = TOOL_RESULT) => text.length > max ? `${text.slice(0, max)}…（已截断）` : text;
const json = (value: unknown) => clip(JSON.stringify(value, null, 1));
const proposalId = () => `P-${randomBytes(2).toString('hex')}`;

const TOOLS: LlmTool[] = [
  { name: 'read_messages', description: '读取当前话题更早的消息（每条截断到 600 字）。before 为消息编号 n（[#n]），返回它之前的消息。', parameters: { type: 'object', properties: { before: { type: 'integer', description: '只返回编号小于它的消息' }, limit: { type: 'integer', description: '条数，默认 20，最多 40' } } } },
  { name: 'read_message', description: '读取当前话题某条消息的全文。', parameters: { type: 'object', properties: { n: { type: 'integer', description: '消息编号，即 [#n] 里的 n' } }, required: ['n'] } },
  { name: 'read_participant_history', description: '读取某个参与者自己会话里最近的对话（含用户直接在它会话里说的话），用于了解它的进度和上下文。', parameters: { type: 'object', properties: { participant_id: { type: 'string' }, limit: { type: 'integer', description: '条数，默认 12，最多 30' } }, required: ['participant_id'] } },
  { name: 'list_topics', description: '列出用户的其他话题（标题、参与者、最近消息），用于回答跨话题的问题。', parameters: { type: 'object', properties: { query: { type: 'string', description: '按标题或内容筛选，可省略' } } } },
  { name: 'dispatch_task', description: '把一项工作派给当前话题里的参与者（只在用户要求或同意时使用）。参与者完成后，你会收到通知并负责汇总。', parameters: { type: 'object', properties: { participant_ids: { type: 'array', items: { type: 'string' } }, text: { type: 'string', description: '任务说明：要做什么、验收标准' }, reference_ns: { type: 'array', items: { type: 'integer' }, description: '要一并发给参与者的回答编号 [#n]' } }, required: ['participant_ids', 'text'] } },
  { name: 'propose_participant', description: '提议让一个现有会话分叉加入话题（contact_id），或新建一个 AI 参与者（backend + title）。需要用户批准后才生效。', parameters: { type: 'object', properties: { contact_id: { type: 'string' }, backend: { type: 'string', enum: ['claude', 'codex', 'dsh', 'pi'] }, title: { type: 'string' }, reason: { type: 'string' } }, required: ['reason'] } },
  { name: 'list_contacts', description: '列出可以拉进话题的现有会话（id、名称、后端、工作目录）。', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
];

/** Dili's own topic coordinator: a thin tool-calling loop over Dili's topic
 * data. It never runs commands or touches files; work goes to participants. */
export class Coordinator {
  private queues = new Map<string, { running: Promise<void>; pending: CoordinatorTrigger[] }>();
  private closed = false;
  constructor(private readonly options: CoordinatorOptions) {}

  /** Answers in the topic. Triggers arriving while a run is in progress are
   * batched into the next run instead of queuing one run each. */
  trigger(groupId: string, trigger: CoordinatorTrigger): void {
    if (this.closed || this.options.store.group(groupId)?.kind !== 'topic') return;
    const queue = this.queues.get(groupId);
    if (queue) { queue.pending.push(trigger); return; }
    const entry = { pending: [] as CoordinatorTrigger[], running: Promise.resolve() };
    this.queues.set(groupId, entry);
    entry.running = (async () => {
      let batch = [trigger];
      while (batch.length && !this.closed) {
        await this.run(groupId, batch).catch(() => undefined);
        batch = entry.pending.splice(0);
      }
      this.queues.delete(groupId);
    })();
  }
  /** Resolves when the topic has no run in progress (tests, shutdown). */
  async idle(groupId: string) { while (this.queues.get(groupId)) await this.queues.get(groupId)!.running; }

  /** Every recipient of a coordinator task has a settled answer: summarize once. */
  repliesChanged() {
    const { store } = this.options;
    for (const topic of store.groups()) {
      if (topic.kind !== 'topic' || topic.archived) continue;
      const rows = store.db.prepare("SELECT data FROM messages WHERE json_extract(data, '$.groupId') = ? AND json_extract(data, '$.awaitSummary') = 1").all(topic.id).map(row => JSON.parse(String(row.data)) as GroupMessage);
      for (const task of rows) {
        const deliveries = store.deliveries().filter(item => item.messageId === task.id && item.status !== 'cancelled');
        const settled = deliveries.length > 0 && deliveries.every(item => { const reply = item.replyMessageId ? store.message(item.replyMessageId) : undefined; return reply && !reply.pending; });
        if (!settled) continue;
        store.updateCoordinatorMessage(task.id, { awaitSummary: false });
        const names = deliveries.map(item => store.session(item.sessionId)?.title ?? '参与者').join('、');
        this.trigger(topic.id, { type: 'event', text: `你派给 ${names} 的任务（${clip(task.text, 80)}）都已回复。请读取他们的回答，向用户汇总结论、分歧和待决事项。` });
      }
    }
  }

  close() { this.closed = true; }

  private async run(groupId: string, triggers: CoordinatorTrigger[]) {
    const { store } = this.options;
    const source = triggers.find((item): item is Extract<CoordinatorTrigger, { type: 'message' }> => item.type === 'message');
    const channel = triggers.find(item => item.channel)?.channel;
    const answer = store.addCoordinatorMessage(groupId, { text: '', pending: true, sourceMessageId: source?.messageId ?? null });
    this.options.onChange();
    const configured = await this.options.api().catch(() => null);
    if (!configured) {
      this.finish(answer.id, '嘀哩还没有可用的模型：请先在「连接与能力」里给 DeepSeek Harness 或 Pi 配置 API（地址、模型和 Key），嘀哩会复用它。', triggers, true);
      return;
    }
    const api: LlmApi = { baseUrl: configured.baseUrl, apiKey: configured.apiKey, model: this.options.model ?? COORDINATOR_MODEL };
    const state = { dispatched: 0, proposed: 0, actions: [] as string[] };
    const messages: LlmMessage[] = [
      { role: 'system', content: coordinatorRules(channel) },
      { role: 'user', content: `${this.snapshot(groupId)}\n\n## 需要你回应的${triggers.length > 1 ? `（${triggers.length} 条，一并回应）` : ''}\n${triggers.map(item => this.describe(groupId, item)).join('\n')}` },
    ];
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const reply = await chatCompletion(api, { messages, tools: TOOLS }, this.options.fetcher);
        if (!reply.toolCalls.length) {
          const text = reply.content.trim() || (state.actions.length ? state.actions.join('；') : '（嘀哩没有生成回复）');
          this.finish(answer.id, text, triggers);
          return;
        }
        messages.push({ role: 'assistant', content: reply.content, ...(reply.reasoning ? { reasoning_content: reply.reasoning } : {}), tool_calls: reply.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) });
        for (const call of reply.toolCalls) {
          let result: string;
          try { result = await this.tool(groupId, call.name, JSON.parse(call.arguments || '{}'), state); }
          catch (cause) { result = `错误：${cause instanceof Error ? cause.message : '工具调用失败'}`; }
          messages.push({ role: 'tool', tool_call_id: call.id, content: result });
        }
      }
      this.finish(answer.id, state.actions.length ? `${state.actions.join('；')}。（已达到单次处理的步数上限）` : '这个问题需要的步骤太多，嘀哩先停下了。可以把问题拆小一点再问。', triggers, !state.actions.length);
    } catch (cause) {
      const reason = cause instanceof LlmError ? cause.message : '未知错误';
      this.finish(answer.id, `嘀哩暂时无法回复：${reason}${state.actions.length ? `。已完成：${state.actions.join('；')}` : ''}`, triggers, true);
    }
  }

  private finish(id: string, text: string, triggers: CoordinatorTrigger[], failed = false) {
    const message = this.options.store.updateCoordinatorMessage(id, { text, pending: false, failed });
    this.options.onChange();
    if (message) this.options.onAnswer?.(message.groupId, message, triggers);
  }

  private snapshot(groupId: string) {
    const { store } = this.options;
    const detail = store.groupDetail(groupId);
    const members = store.sessions().filter(item => item.groupId === groupId && !item.archived);
    const name = (id: string) => store.session(id)?.title ?? id;
    return topicSnapshot({ topic: detail.group, members, messages: detail.messages.filter(item => !(item.agent === 'coordinator' && item.pending)), total: detail.page?.total ?? detail.messages.length }, name);
  }

  private describe(groupId: string, trigger: CoordinatorTrigger) {
    if (trigger.type === 'event') return `- 系统通知：${trigger.text}`;
    const message = this.options.store.message(trigger.messageId);
    if (!message || message.groupId !== groupId) return '- （消息已不存在）';
    return `- 用户${message.channel ? `（来自${message.channel === 'weixin' ? '微信' : '飞书'}）` : ''}说：${clip(message.text, 4000)}`;
  }

  private members(groupId: string) { return this.options.store.sessions().filter(item => item.groupId === groupId && !item.archived); }

  private async tool(groupId: string, name: string, args: Record<string, unknown>, state: { dispatched: number; proposed: number; actions: string[] }): Promise<string> {
    const { store } = this.options;
    const int = (value: unknown, fallback: number, max: number) => Math.max(1, Math.min(max, Number.isInteger(value) ? value as number : fallback));
    const line = (message: GroupMessage & { sequence?: number }) => ({ n: message.sequence, from: message.senderName, kind: message.kind, ...(message.recipientIds.length ? { to: message.recipientIds.map(id => store.session(id)?.title ?? id) } : {}), text: clip(message.text, 600), at: message.createdAt });
    switch (name) {
      case 'read_messages': {
        const before = Number.isInteger(args.before) ? args.before as number : undefined;
        const page = store.groupDetail(groupId, before ? { before } : {});
        return json(page.messages.slice(-int(args.limit, 20, 40)).map(line));
      }
      case 'read_message': {
        const message = Number.isInteger(args.n) ? store.messageAt(groupId, args.n as number) : undefined;
        if (!message) return '没有这条消息';
        return json({ ...line(message), text: clip(message.text) });
      }
      case 'read_participant_history': {
        const member = this.members(groupId).find(item => item.id === args.participant_id);
        if (!member) return '这个参与者不在当前话题里';
        const transcript = await this.options.readTranscript(member);
        const turns = transcript.messages.filter(item => !item.tool && item.text.trim()).slice(-int(args.limit, 12, 30));
        return json({ participant: member.title, status: member.status, turns: turns.map(item => ({ role: item.role === 'user' ? '用户' : member.title, text: clip(item.text, 800) })) });
      }
      case 'list_topics': {
        const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
        const topics = store.groups().filter(item => item.kind === 'topic' && !item.archived && item.id !== groupId && (!query || `${item.title} ${item.goal} ${item.lastMessage?.text ?? ''}`.toLowerCase().includes(query)));
        return json(topics.slice(0, 30).map(item => ({ id: item.id, title: item.title, participants: store.sessions().filter(member => member.groupId === item.id && !member.archived).map(member => member.title), last: item.lastMessage ? `${item.lastMessage.senderName}：${clip(item.lastMessage.text, 120)}` : null })));
      }
      case 'list_contacts': {
        const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
        const contacts = store.sessions().filter(item => !item.archived && item.groupId !== groupId && (!query || `${item.title} ${item.cwd}`.toLowerCase().includes(query)));
        return json(contacts.slice(0, 40).map(item => ({ id: item.id, title: item.title, backend: item.backend, cwd: item.cwd })));
      }
      case 'dispatch_task': {
        if (state.dispatched >= MAX_DISPATCH) return '本次已经派过活了，先等参与者回复';
        const members = this.members(groupId);
        const ids = Array.isArray(args.participant_ids) ? [...new Set(args.participant_ids.filter((id): id is string => typeof id === 'string'))] : [];
        const recipients = ids.map(id => members.find(item => item.id === id)).filter((item): item is Session => !!item);
        if (!recipients.length || recipients.length !== ids.length) return '参与者 id 无效：只能派给当前话题的参与者（用参与者列表里的 id）';
        const text = typeof args.text === 'string' ? args.text.trim() : '';
        if (!text) return '任务说明不能为空';
        const references = (Array.isArray(args.reference_ns) ? args.reference_ns : []).filter(Number.isInteger).map(n => store.messageAt(groupId, n as number))
          .filter((item): item is GroupMessage & { sequence: number } => !!item && (item.kind === 'reply' || item.kind === 'result') && !item.failed && item.agent !== 'coordinator').map(item => item.id);
        const task = store.addMessage({ groupId, kind: 'task', agent: 'coordinator', senderId: null, senderName: '嘀哩', recipientIds: recipients.map(item => item.id), text, awaitSummary: true, ...(references.length ? { references } : {}) });
        state.dispatched++;
        this.options.onChange();
        const results = await Promise.all(store.deliveries().filter(item => item.messageId === task.id).map(async delivery => {
          const member = store.session(delivery.sessionId)!;
          try { await this.options.deliver(delivery.id); return `${member.title}：已发送`; }
          catch (cause) { return `${member.title}：未发送（${cause instanceof Error ? cause.message : '投递失败'}），用户可在话题里重试`; }
        }));
        state.actions.push(`已派给 ${recipients.map(item => item.title).join('、')}`);
        return results.join('\n');
      }
      case 'propose_participant': {
        if (state.proposed >= MAX_PROPOSALS) return '本次提议已经够多了';
        const reason = typeof args.reason === 'string' ? args.reason.trim().slice(0, 500) : '';
        if (!reason) return '请写明理由';
        let proposal: TopicProposal;
        if (typeof args.contact_id === 'string' && args.contact_id) {
          const contact = store.session(args.contact_id);
          if (!contact || contact.archived) return '没有这个会话（用 list_contacts 查 id）';
          if (contact.groupId === groupId) return '这个会话已经在话题里';
          const backend = this.options.backends().find(item => item.id === contact.backend);
          if (!backend?.capabilities.fork || !contact.nativeSessionId || contact.forkPending) return `${contact.title} 目前无法分叉（后端不支持或会话尚未启动过），可以改为新建 AI`;
          proposal = { id: proposalId(), status: 'pending', reason, fork: { contactId: contact.id, title: contact.title } };
        } else {
          const backend = args.backend as Backend;
          if (!this.options.backends().some(item => item.id === backend && item.installed)) return '后端无效或未安装；可选：' + this.options.backends().filter(item => item.installed).map(item => item.id).join('、');
          const title = typeof args.title === 'string' ? args.title.trim().slice(0, 120) : '';
          if (!title) return '新建 AI 需要名称（title）';
          const cwd = this.members(groupId)[0]?.cwd ?? this.options.store.group(groupId)?.workspace ?? this.options.defaultCwd();
          proposal = { id: proposalId(), status: 'pending', reason, create: { backend, title, cwd } };
        }
        store.addCoordinatorMessage(groupId, { text: proposal.fork ? `提议把「${proposal.fork.title}」分叉加入话题：${reason}` : `提议新建 ${proposal.create!.backend} 参与者「${proposal.create!.title}」：${reason}`, proposal });
        state.proposed++;
        this.options.onChange();
        state.actions.push(`已提议 ${proposal.id}`);
        return `已创建提议 ${proposal.id}，等待用户批准（用户可点「同意」，或在 IM 里回复「同意 ${proposal.id}」）。`;
      }
      default: return `没有这个工具：${name}`;
    }
  }
}
