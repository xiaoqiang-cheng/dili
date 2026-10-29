import GroupMemberRequests from './GroupMemberRequests';
import type { ChatAttachment } from '../shared/attachments';
import ImageAttachments from './ImageAttachments';
import VoiceInput, { appendVoiceText } from './VoiceInput';
import GroupImages from './GroupImages';
import { lazy, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Maximize2, Minimize2, FolderGit2, FolderOpen, FolderPlus, GitMerge, RotateCcw, Trash2, ArrowLeft, ArrowRight, AtSign, Check, ChevronDown, ChevronUp, Columns3, LoaderCircle, MessageSquare, Plus, Quote, Send, Settings2, Share2, UserMinus, UsersRound, X } from 'lucide-react';
import type { AgentChatSnapshot } from '../shared/chat';
import type { Delivery, Group, GroupDetail, GroupMessage, Session, WorktreeStatus } from '../shared/types';
import { api } from './api';
import { BackendAvatar, StatusBadge, relativeTime } from './App';
import ConversationPane from './ConversationPane';
import Markdown from './Markdown';
import ModalShell from './Modal';
import TerminalPane from './TerminalPane';
import { useCompactLayout } from './useCompactLayout';
import './group-chat.css';

const AgentChatPane = lazy(() => import('./AgentChatPane'));

type GroupDraft = { attachments: ChatAttachment[]; text: string; kind: GroupMessage['kind']; recipients: string[]; sourceMessageId: string | null; references: string[] };
function readGroupDraft(groupId: string): GroupDraft {
  try {
    const draft = JSON.parse(sessionStorage.getItem(`sessiondeck.group-draft.${groupId}`) ?? 'null');
    if (draft && typeof draft.text === 'string' && Array.isArray(draft.recipients)) return {
      attachments: Array.isArray(draft.attachments) ? draft.attachments.filter((item: ChatAttachment) => item && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.type === 'string' && typeof item.size === 'number').slice(0, 8) : [],
      text: draft.text.slice(0, 30000), kind: draft.kind === 'task' ? 'task' : 'note',
      recipients: draft.recipients.filter((id: unknown) => typeof id === 'string'),
      sourceMessageId: typeof draft.sourceMessageId === 'string' ? draft.sourceMessageId : null,
      references: Array.isArray(draft.references) ? draft.references.filter((id: unknown) => typeof id === 'string') : [],
    };
  } catch { /* Unavailable or stale browser storage must not block the workspace. */ }
  return { attachments: [], text: '', kind: 'note', recipients: [], sourceMessageId: null, references: [] };
}

// Only confirmed choices route tasks. Typing or pasting a name alone never assigns it.
function mentionRange(text: string, title: string): { start: number; end: number } | undefined {
  const token = `@${title}`;
  let start = text.indexOf(token);
  while (start >= 0) {
    const end = start + token.length;
    if (end === text.length || /\s/.test(text[end])) return { start, end };
    start = text.indexOf(token, start + 1);
  }
}
function withMention(text: string, title: string): string {
  return mentionRange(text, title) ? text : `@${title} ${text}`;
}

export interface GroupPost { attachments?: string[]; text: string; kind: GroupMessage['kind']; recipientIds: string[]; sourceMessageId?: string | null; references?: string[]; deliverNow?: boolean }

/** A task still being worked on: no reply yet, or a reply that is still open. */
function openTask(detail: GroupDetail) {
  const pendingReplies = new Set(detail.messages.filter(message => message.kind === 'reply' && message.pending).map(message => message.id));
  return (delivery: Omit<Delivery, 'text'>) => !delivery.replyMessageId || pendingReplies.has(delivery.replyMessageId);
}

/** A member's in-progress reply to a group task, polled while it streams. */
function useLiveReplies(members: Session[], detail: GroupDetail) {
  const [live, setLive] = useState<Record<string, string>>({});
  const open = openTask(detail);
  const streaming = useMemo(() => members.filter(member => member.running && member.status === 'running' && member.interactionMode === 'chat'
    && detail.deliveries.some(delivery => delivery.sessionId === member.id && delivery.status === 'sent' && open(delivery))).slice(0, 6), [members, detail.deliveries, open]);
  const key = streaming.map(member => member.id).join(',');
  useEffect(() => {
    if (!streaming.length) { setLive({}); return; }
    let alive = true;
    const poll = async () => {
      const next: Record<string, string> = {};
      await Promise.all(streaming.map(async member => {
        try {
          const snapshot = await api<AgentChatSnapshot>(`/sessions/${member.id}/chat`);
          const turn = snapshot.activeTurnId;
          const item = snapshot.items.filter(entry => entry.type === 'assistant' && (!turn || entry.turnId === turn)).at(-1);
          if (turn) next[member.id] = item?.text ?? '';
        } catch { /* The member may be reconnecting; keep the typing row. */ next[member.id] = ''; }
      }));
      if (alive) setLive(next);
    };
    void poll();
    const timer = setInterval(() => void poll(), 1200);
    return () => { alive = false; clearInterval(timer); };
    // The member list key captures every input that changes the polling set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { live, streaming };
}

const tail = (path: string) => path.replace(/\/$/, '').split('/').filter(Boolean).slice(-2).join('/') || path;

/** Where a member works, and for an isolated worktree its branch, status, merge and cleanup. */
function MemberPlacement({ member, workspace, busy, onChanged, onError }: { member: Session; workspace?: string; busy: boolean; onChanged: (text: string) => void; onError: (text: string) => void }) {
  const [status, setStatus] = useState<WorktreeStatus | null>(null);
  const [working, setWorking] = useState(false);
  const worktree = member.worktree;
  const load = useCallback(async () => { if (worktree) setStatus(await api<WorktreeStatus>(`/sessions/${member.id}/worktree`).catch(() => null)); }, [member.id, worktree]);
  useEffect(() => { void load(); }, [load, member.status]);
  if (!worktree) return <small className={`member-placement${workspace && member.cwd !== workspace ? ' mismatch' : ''}`} title={member.cwd}>{!workspace || member.cwd === workspace ? '共享群工作区' : `目录不同：${tail(member.cwd)}`}</small>;
  const act = async (path: string, done: string, confirm?: string) => {
    if (confirm && !window.confirm(confirm)) return;
    setWorking(true);
    try { await api(`/sessions/${member.id}/worktree/${path}`, {}); onChanged(done); await load(); }
    catch (cause) { onError(cause instanceof Error ? cause.message : '操作失败'); }
    finally { setWorking(false); }
  };
  return <div className="member-worktree">
    <small title={worktree.path}><FolderGit2 size={12} />{worktree.branch}</small>
    {status && <small>{status.merged && !status.ahead ? '已合并' : `领先 ${status.ahead} 个提交`}{status.uncommitted ? ` · ${status.uncommitted} 处未提交` : ''}{status.behind ? ` · 落后 ${status.behind}` : ''}</small>}
    <span>
      <button className="text-button" disabled={busy || working || !status?.ahead || !!status?.uncommitted} title={status?.uncommitted ? '成员还有未提交改动' : !status?.ahead ? '没有新的提交' : '合并到群工作区'} onClick={() => void act('merge', `已将 ${member.title} 的分支合并到群工作区`, `将 ${worktree.branch} 合并到群工作区当前分支？发生冲突时会自动撤销，不改动群工作区。`)}><GitMerge size={13} />合并</button>
      <button className="text-button" disabled={busy || working || member.running} title={member.running ? '先停止这个成员' : '归档成员并删除工作树目录，保留分支'} onClick={() => void act('remove', `已清理 ${member.title} 的工作树`, `清理后成员会被归档，工作树目录删除，分支 ${worktree.branch} 保留。${status && !status.merged ? '分支还没有合并，提交仍保存在分支里。' : ''}继续？`)}><Trash2 size={13} />清理</button>
    </span>
  </div>;
}

/** One member's private session inside the split view, using its current executor. */
function MemberPane({ member, chatCapable, open }: { member: Session; chatCapable: boolean; open: () => void }) {
  const noop = useCallback(() => {}, []);
  const body = chatCapable && (member.interactionMode === 'chat' || !member.running)
    ? <Suspense fallback={<div className="loading-state"><LoaderCircle size={18} className="spin" /></div>}><AgentChatPane session={member} onTerminal={open} onSelection={noop} /></Suspense>
    : member.running ? <TerminalPane sessionId={member.id} running={member.running} status={member.status} onSelection={noop} />
      : <ConversationPane session={member} allowInput={false} onTerminal={open} onSelection={noop} />;
  return <section className="group-split-pane" aria-label={`${member.title} 的会话`}>
    <header><BackendAvatar backend={member.backend} small /><strong title={member.title}>{member.title}</strong><StatusBadge session={member} /><button className="icon-button" aria-label={`打开 ${member.title} 的私聊`} title="在私聊中打开" onClick={open}><ArrowRight size={14} /></button></header>
    <div className="group-split-body">{body}</div>
  </section>;
}

export default function GroupChat({ active = true, onShare, group, detail, members, demo, busy, chatCapable, post, deliver, cancel, open, confirmReplace, loadOlder, loadingOlder, readSource, resolveDelivery, addMember, editGroup, editWorkspacePermissions, removeMember, markRead, back, openWorkspace, notify }: {
  active?: boolean;
  onShare?: () => void;
  group: Group; detail: GroupDetail; members: Session[]; demo: boolean; busy: string | null;
  chatCapable: (member: Session) => boolean;
  post: (body: GroupPost) => Promise<boolean>;
  deliver: (id: string, sessionId: string) => void; cancel: (id: string) => void; open: (id: string, interactive?: boolean) => void;
  confirmReplace: (message: GroupMessage, draft: string, proceed: () => void) => void;
  loadOlder: () => Promise<void>; loadingOlder: boolean; readSource: (id: string) => Promise<GroupMessage>;
  resolveDelivery: (delivery: Omit<Delivery, 'text'>, resolution: 'confirmed' | 'not_received' | 'cancelled') => void;
  addMember: () => void; editGroup: () => void; editWorkspacePermissions?: () => void; removeMember: (member: Session) => void; markRead: () => void; back: () => void; openWorkspace: (member: Session) => void; notify: (text: string) => void;
}) {
  const [draft] = useState(() => readGroupDraft(detail.group.id));
  const [text, setText] = useState(() => draft.recipients.reduce((value, id) => {
    const member = members.find(member => member.id === id && !member.archived);
    return member ? withMention(value, member.title) : value;
  }, draft.text));
  const [images, setImages] = useState<ChatAttachment[]>(draft.attachments);
  const [uploading, setUploading] = useState(false), [voiceActive, setVoiceActive] = useState(false);
  const [recipients, setRecipients] = useState<string[]>(draft.recipients);
  const [sourceMessageId, setSourceMessageId] = useState<string | null>(draft.sourceMessageId);
  const [references, setReferences] = useState<string[]>(draft.references);
  const [only, setOnly] = useState<string | null>(null);
  const [split, setSplit] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [phoneMember, setPhoneMember] = useState<string | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  /** The "@query" being typed at the caret: its text and range in the draft. */
  const [mention, setMention] = useState<{ query: string; start: number; end: number } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionMenuId = useId();
  const mentionMenuRef = useRef<HTMLDivElement>(null);
  const compact = useCompactLayout();
  const [visibleStart, setVisibleStart] = useState(() => Math.max(0, detail.messages.length - 200));
  const firstVisible = detail.page ? 0 : Math.min(visibleStart, Math.max(0, detail.messages.length - 1));
  const totalMessages = detail.page?.total ?? detail.messages.length;
  const earlierCount = detail.page ? Math.max(0, totalMessages - detail.messages.length) : firstVisible;
  const [sourcePreview, setSourcePreview] = useState<GroupMessage | null>(null);
  const sourceVersion = useRef(0);
  useEffect(() => () => { sourceVersion.current++; }, []);
  const activeMembers = useMemo(() => members.filter(member => !member.archived), [members]);
  const visibleMessages = useMemo(() => detail.messages.slice(firstVisible).filter(message => !only || message.senderId === only || message.recipientIds.includes(only)), [detail.messages, firstVisible, only]);
  const historyRef = useRef<HTMLDivElement>(null);
  const previousHistoryScroll = useRef<{ top: number; height: number } | null>(null);
  const pendingMessageJump = useRef<string | null>(null);
  const followBottom = useRef(true);
  const currentDraftRef = useRef('');
  currentDraftRef.current = JSON.stringify({ attachments: images, text, kind: recipients.length ? 'task' : 'note', recipients, sourceMessageId, references });
  const messagesById = useMemo(() => new Map(detail.messages.map(message => [message.id, message])), [detail.messages]);
  const messagePositions = useMemo(() => new Map(detail.messages.map((message, index) => [message.id, index])), [detail.messages]);
  const membersById = useMemo(() => new Map(members.map(member => [member.id, member])), [members]);
  const deliveriesByMessage = useMemo(() => {
    const index = new Map<string, Omit<Delivery, 'text'>[]>();
    for (const delivery of detail.deliveries) {
      const items = index.get(delivery.messageId);
      if (items) items.push(delivery); else index.set(delivery.messageId, [delivery]);
    }
    return index;
  }, [detail.deliveries]);
  const { live, streaming } = useLiveReplies(activeMembers, detail);
  const sourceMessage = sourceMessageId ? messagesById.get(sourceMessageId) : undefined;
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // Viewing the group reads its member replies, but only while this window is
  // actually in front; replies that arrive in the background wait for focus.
  const staleReminders = activeMembers.filter(member => member.unread > 0 && member.status !== 'waiting_approval' && member.status !== 'error').map(member => `${member.id}:${member.unread}:${member.updatedAt}`).join(',');
  useEffect(() => {
    if (!active || !((group.unread ?? 0) > 0 || staleReminders)) return;
    const read = () => { if (document.visibilityState === 'visible' && document.hasFocus()) markRead(); };
    read();
    window.addEventListener('focus', read);
    document.addEventListener('visibilitychange', read);
    return () => { window.removeEventListener('focus', read); document.removeEventListener('visibilitychange', read); };
  }, [active, group.unread, group.updatedAt, staleReminders, markRead]);

  const jumpToMessage = useCallback((id: string) => {
    const element = document.getElementById(`group-message-${id}`);
    if (element) {
      element.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
      element.focus({ preventScroll: true });
    } else {
      const index = messagePositions.get(id);
      if (index === undefined) {
        const version = ++sourceVersion.current;
        void readSource(id).then(message => { if (sourceVersion.current === version) setSourcePreview(message); }).catch(cause => { if (sourceVersion.current === version) setLocalError(cause.message); });
        return;
      }
      setOnly(null);
      pendingMessageJump.current = id;
      setVisibleStart(current => Math.min(current, index));
    }
  }, [messagePositions, readSource]);
  const showEarlier = useCallback(() => {
    const history = historyRef.current;
    if (history) previousHistoryScroll.current = { top: history.scrollTop, height: history.scrollHeight };
    if (detail.page) void loadOlder();
    else setVisibleStart(current => Math.max(0, current - 200));
  }, [detail.page, loadOlder]);
  useLayoutEffect(() => {
    const history = historyRef.current;
    if (pendingMessageJump.current) {
      const element = document.getElementById(`group-message-${pendingMessageJump.current}`);
      element?.scrollIntoView({ block: 'center', behavior: 'instant' });
      element?.focus({ preventScroll: true });
      pendingMessageJump.current = null;
      previousHistoryScroll.current = null;
    } else if (previousHistoryScroll.current && history) {
      const previous = previousHistoryScroll.current;
      history.scrollTop = previous.top + history.scrollHeight - previous.height;
      previousHistoryScroll.current = null;
    } else if (history && followBottom.current) history.scrollTop = history.scrollHeight;
  }, [firstVisible, detail.messages[0]?.id, detail.messages.length, live, only]);

  const forwardMessage = useCallback((message: GroupMessage) => {
    const proceed = () => {
      setText(message.text); setImages(message.attachments ?? []); setRecipients([]); setSourceMessageId(message.id); setLocalError('');
      requestAnimationFrame(() => { composerRef.current?.focus(); composerRef.current?.scrollIntoView({ block: 'center' }); });
    };
    const current = JSON.parse(currentDraftRef.current) as GroupDraft;
    if (current.attachments.length || current.text.trim() || current.recipients.length || current.sourceMessageId) confirmReplace(message, current.text, proceed);
    else proceed();
  }, [confirmReplace]);
  /** A failed task goes back to the same member: original text and references, edited before sending. */
  const reassign = useCallback((failure: GroupMessage) => {
    const task = failure.sourceMessageId ? messagesById.get(failure.sourceMessageId) : undefined;
    const proceed = () => {
      const member = membersById.get(failure.senderId ?? '');
      setImages(task?.attachments ?? []); setText(member ? withMention(task?.text ?? '', member.title) : task?.text ?? ''); setRecipients(member ? [member.id] : []); setSourceMessageId(null); setReferences(task?.references ?? []); setLocalError('');
      requestAnimationFrame(() => { composerRef.current?.focus(); composerRef.current?.scrollIntoView({ block: 'center' }); });
    };
    const current = JSON.parse(currentDraftRef.current) as GroupDraft;
    if (current.attachments.length || current.text.trim() || current.recipients.length || current.sourceMessageId) confirmReplace(failure, current.text, proceed);
    else proceed();
  }, [messagesById, membersById, confirmReplace]);
  const quote = useCallback((message: GroupMessage) => {
    setReferences(current => current.includes(message.id) ? current : [...current, message.id].slice(-20));
    requestAnimationFrame(() => composerRef.current?.focus());
  }, []);
  const [localError, setLocalError] = useState('');
  const [posting, setPosting] = useState(false);
  const postingRef = useRef(false);
  const activeRecipients = recipients.filter(id => activeMembers.some(member => member.id === id && mentionRange(text, member.title)));
  const lastReply = [...detail.messages].reverse().find(message =>
    (message.kind === 'reply' || message.kind === 'result') && !message.failed && !message.briefing &&
    activeMembers.some(member => member.id === message.senderId));
  const defaultMember = activeMembers.find(member => member.id === lastReply?.senderId);
  const deliveryRecipients = activeRecipients.length ? activeRecipients : defaultMember ? [defaultMember.id] : [];
  const toggleRecipient = (id: string) => {
    const member = membersById.get(id);
    if (!member) return;
    if (recipients.includes(id)) {
      setRecipients(current => current.filter(item => item !== id));
      setText(current => {
        const range = mentionRange(current, member.title);
        return range ? current.slice(0, range.start) + current.slice(range.end + (current[range.end] === ' ' ? 1 : 0)) : current;
      });
    } else {
      setRecipients(current => [...current, id]);
      setText(current => withMention(current, member.title));
    }
    setMention(null);
  };
  useEffect(() => {
    const submitted = (event: Event) => {
      const finished = (event as CustomEvent<{ groupId: string; draft: string }>).detail;
      if (finished.groupId === detail.group.id && finished.draft === currentDraftRef.current) {
        setText(''); setImages([]); setRecipients([]); setSourceMessageId(null); setReferences([]);
      }
    };
    window.addEventListener('sessiondeck:group-draft-submitted', submitted);
    return () => window.removeEventListener('sessiondeck:group-draft-submitted', submitted);
  }, [detail.group.id]);
  useEffect(() => {
    try {
      const key = `sessiondeck.group-draft.${detail.group.id}`;
      if (images.length || text || recipients.length || sourceMessageId || references.length) sessionStorage.setItem(key, currentDraftRef.current);
      else sessionStorage.removeItem(key);
    } catch { /* Draft persistence is optional when browser storage is disabled. */ }
  }, [detail.group.id, text, recipients, sourceMessageId, references, images]);

  // Typing "@name" anywhere (no space needed before it) offers members at the caret;
  // choosing one expands it to a visible @name; deleting it cancels assignment.
  const onText = (value: string, caret: number) => {
    setText(value);
    setMentionIndex(0);
    setRecipients(current => current.filter(id => {
      const member = membersById.get(id);
      return member && mentionRange(value, member.title);
    }));
    const token = value.slice(0, caret).match(/@([^\s@]{0,20})$/);
    setMention(token ? { query: token[1], start: caret - token[0].length, end: caret } : null);
  };
  const mentionChoices = mention === null ? [] : activeMembers.filter(member => member.title.toLowerCase().includes(mention.query.toLowerCase()));
  const selectedMentionIndex = Math.min(mentionIndex, Math.max(0, mentionChoices.length - 1));
  const selectedMentionId = mentionChoices[selectedMentionIndex]?.id;
  useEffect(() => {
    mentionMenuRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selectedMentionId]);
  const chooseMention = (member: Session) => {
    const range = mention;
    if (!range) return;
    const token = `@${member.title} `;
    setText(current => current.slice(0, range.start) + token + current.slice(range.end));
    setRecipients(current => current.includes(member.id) ? current : [...current, member.id]);
    setMention(null);
    requestAnimationFrame(() => {
      const field = composerRef.current;
      if (!field) return;
      field.focus(); field.setSelectionRange(range.start + token.length, range.start + token.length);
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setLocalError('');
    let messageText = text;
    for (const id of activeRecipients) {
      const member = membersById.get(id);
      if (!member) continue;
      let range = mentionRange(messageText, member.title);
      while (range) {
        messageText = messageText.slice(0, range.start) + messageText.slice(range.end + (messageText[range.end] === ' ' ? 1 : 0));
        range = mentionRange(messageText, member.title);
      }
    }
    messageText = messageText.trim();
    if (!messageText && !images.length) { setLocalError('请输入任务正文，不能只发送 @ 成员'); return; }
    if (postingRef.current || busy || uploading || voiceActive) return;
    const submittedDraft = currentDraftRef.current;
    const submittedGroupId = detail.group.id;
    const task = deliveryRecipients.length > 0;
    postingRef.current = true; setPosting(true);
    try {
      if (await post({ attachments: images.map(item => item.id), text: messageText, kind: task ? 'task' : 'note', recipientIds: deliveryRecipients, sourceMessageId, references: task ? references.filter(id => messagesById.has(id)) : [], deliverNow: task })) {
        followBottom.current = true;
        try {
          const key = `sessiondeck.group-draft.${submittedGroupId}`;
          if (sessionStorage.getItem(key) === submittedDraft) sessionStorage.removeItem(key);
        } catch { /* The live composer still clears when storage is unavailable. */ }
        window.dispatchEvent(new CustomEvent('sessiondeck:group-draft-submitted', { detail: { groupId: submittedGroupId, draft: submittedDraft } }));
      }
    } finally { postingRef.current = false; setPosting(false); }
  };

  const deliveryRow = (delivery: Omit<Delivery, 'text'>) => {
    const member = membersById.get(delivery.sessionId);
    const reply = delivery.replyMessageId ? messagesById.get(delivery.replyMessageId) : undefined;
    return <div className="delivery-item" key={delivery.id}><span>{member ? <BackendAvatar backend={member.backend} small /> : <Send size={13} />}{member?.title || '群组成员'}</span>{delivery.status === 'pending' ? <div><span className="delivery-pending-note" title={delivery.lastError}>{delivery.lastError || '未发送'}</span><button className="text-button" disabled={!!busy || !member || member.archived} onClick={() => deliver(delivery.id, delivery.sessionId)}>{busy === `deliver:${delivery.id}` ? <LoaderCircle size={13} className="spin" /> : <ArrowRight size={13} />}{!demo && (member?.backend === 'dsh' || !!member && ['codex', 'claude'].includes(member.backend) && member.interactionMode === 'chat') ? '发送到会话' : '填入会话'}</button><button className="icon-button" disabled={!!busy} aria-label="取消投递" title="取消投递" onClick={() => cancel(delivery.id)}><X size={13} /></button></div>
      : delivery.status === 'unknown' ? <div className="delivery-uncertain"><span title={delivery.lastError}>结果待确认，请核对原生会话</span><button className="text-button" onClick={() => open(delivery.sessionId, true)}>进入核对</button><button className="text-button" disabled={!!busy} onClick={() => resolveDelivery(delivery, 'confirmed')}>已核对，已收到</button><button className="text-button" disabled={!!busy} onClick={() => resolveDelivery(delivery, 'not_received')}>已核对，未收到</button><button className="text-button" disabled={!!busy} onClick={() => resolveDelivery(delivery, 'cancelled')}>关闭投递</button></div>
      : <span className="delivery-state">{reply ? <button className={`text-button${reply.failed ? ' delivery-failed' : ''}`} onClick={() => jumpToMessage(reply.id)}>{reply.failed ? '回复失败' : reply.pending ? '回复中' : '已回复'} <ArrowRight size={12} /></button> : delivery.status === 'sending' ? '投递中…' : delivery.status === 'sent' ? member?.status === 'running' ? '执行中…' : '已发送' : delivery.status === 'staged' ? '已填入 · 在私聊按回车发送' : '已取消'}{delivery.status === 'staged' && !reply && <button className="text-button" onClick={() => open(delivery.sessionId, true)}>进入 <ArrowRight size={12} /></button>}</span>}</div>;
  };

  const messageList = useMemo(() => <div ref={historyRef} className="message-list group-timeline" onScroll={event => { const element = event.currentTarget; followBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }}>
    {totalMessages > 200 && <div className="history-range"><span>显示第 {earlierCount + 1}–{totalMessages} 条，共 {totalMessages} 条</span>{earlierCount > 0 && <button className="text-button" disabled={loadingOlder} onClick={showEarlier}>{loadingOlder ? '正在读取…' : `显示更早 ${Math.min(200, earlierCount)} 条`}</button>}</div>}
    {visibleMessages.length ? visibleMessages.map(message => {
      const sender = message.senderId ? membersById.get(message.senderId) : undefined;
      const open_ = expanded.has(message.id);
      // Long agent answers fold to their first lines; the rest expands in place.
      const long = message.kind === 'reply' && (message.text.length > 900 || message.text.split('\n').length > 14);
      const isMember = message.kind === 'reply' || message.kind === 'result';
      return <article id={`group-message-${message.id}`} tabIndex={-1} key={message.id} className={`group-message kind-${message.kind} ${message.senderId ? '' : 'mine'}${message.failed ? ' failed' : ''}${message.pending ? ' pending' : ''}`}>
        {sender ? <button className="message-avatar member-avatar-link" aria-label={`打开 ${sender.title} 的私聊`} onClick={() => open(sender.id, true)}><BackendAvatar backend={sender.backend} small /></button> : <span className="message-avatar">{message.senderId ? <MessageSquare size={16} /> : '我'}</span>}
        <div className="message-body">
          <div className="message-heading"><strong>{message.senderName || '我'}</strong><span className="message-kind">{message.kind === 'task' ? '任务' : message.failed ? '回复失败' : message.briefing ? '入群招呼' : message.pending ? '仍在工作…' : message.kind === 'reply' ? '回复' : message.kind === 'result' ? '结果' : '记录'}</span><time>{relativeTime(message.createdAt)}</time></div>
          <div className="bubble">
            {message.sourceMessageId && <button className="message-source-link" onClick={() => jumpToMessage(message.sourceMessageId!)}><ArrowRight size={12} />{message.kind === 'reply' ? '回复' : '来源'}：{messagesById.get(message.sourceMessageId)?.senderName || '原消息'}<span>查看原消息</span></button>}
            {message.recipientIds.length > 0 && <div className="message-recipients">{message.recipientIds.map(id => <button key={id} onClick={() => open(id)}>@{membersById.get(id)?.title || '已归档成员'}</button>)}</div>}
            {!!message.references?.length && <div className="message-references">{message.references.map(id => <button key={id} className="text-button" onClick={() => jumpToMessage(id)}><Quote size={12} />引用 {messagesById.get(id)?.senderName || '回答'}</button>)}</div>}
            <GroupImages groupId={group.id} items={message.attachments} />
            {message.kind === 'reply'
              ? <div className="group-reply"><div className={`group-reply-answer${long && !open_ ? ' folded' : ''}`}><Markdown text={message.text} /></div>
                {long && <button className="text-button" aria-expanded={open_} onClick={() => setExpanded(current => { const next = new Set(current); if (next.has(message.id)) next.delete(message.id); else next.add(message.id); return next; })}>{open_ ? <ChevronUp size={13} /> : <ChevronDown size={13} />}{open_ ? '收起' : '展开全文'}</button>}</div>
              : <p>{message.text}</p>}
          </div>
          <div className="delivery-list">{(deliveriesByMessage.get(message.id) ?? []).map(deliveryRow)}</div>
          <div className="message-actions">
            {message.failed && message.senderId && message.sourceMessageId && <button className="text-button" disabled={posting || !!busy} onClick={() => reassign(message)}><RotateCcw size={13} />重新指派</button>}
            {isMember && !message.failed && <button className="text-button" disabled={posting} aria-pressed={references.includes(message.id)} onClick={() => quote(message)}><Quote size={13} />引用</button>}
            {message.kind === 'reply' && message.senderId && <button className="text-button" onClick={() => open(message.senderId!, true)}><MessageSquare size={13} />在私聊中查看</button>}
            <button className="text-button" disabled={posting || !!busy} onClick={() => forwardMessage(message)}><ArrowRight size={13} />转交为任务</button>
          </div>
        </div>
      </article>;
    }) : <div className="board-empty"><p>{only ? '这位成员在当前加载的消息里还没有发言。' : '还没有群聊消息。@ 成员指派任务，他们的回复会自动出现在这里。'}</p></div>}
    {activeMembers.filter(member => member.interactionMode === 'chat' && (!only || member.id === only)).map(member => {
      const delivery = detail.deliveries.filter(item => item.sessionId === member.id && (item.status === 'sent' || item.status === 'staged') && item.tag).at(-1);
      return delivery?.tag ? <GroupMemberRequests key={`${member.id}:${delivery.tag}`} member={member} tag={delivery.tag} /> : null;
    })}
    {!only && streaming.map(member => <div className="group-live" key={member.id} aria-live="polite"><button className="message-avatar member-avatar-link" aria-label={`打开 ${member.title} 的私聊`} onClick={() => open(member.id, true)}><BackendAvatar backend={member.backend} small /></button><div className="message-body"><div className="message-heading"><strong>{member.title}</strong><span className="message-kind">正在回复…</span></div>{live[member.id] ? <div className="bubble group-live-text"><Markdown text={live[member.id]} /></div> : <div className="bubble group-typing"><i /><i /><i /></div>}</div></div>)}
    {!only && activeMembers.filter(member => member.status === 'running' && member.interactionMode !== 'chat' && detail.deliveries.some(delivery => delivery.sessionId === member.id && (delivery.status === 'sent' || delivery.status === 'staged') && openTask(detail)(delivery))).map(member => <div className="group-live" key={member.id}><button className="message-avatar member-avatar-link" aria-label={`打开 ${member.title} 的私聊`} onClick={() => open(member.id, true)}><BackendAvatar backend={member.backend} small /></button><div className="message-body"><div className="message-heading"><strong>{member.title}</strong><span className="message-kind">正在执行…</span></div><div className="bubble group-typing"><i /><i /><i /></div></div></div>)}
  </div>, [totalMessages, earlierCount, loadingOlder, visibleMessages, messagesById, membersById, deliveriesByMessage, busy, posting, demo, open, deliver, cancel, resolveDelivery, jumpToMessage, forwardMessage, quote, reassign, showEarlier, expanded, references, only, streaming, live, activeMembers, detail.deliveries]);

  const splitMembers = activeMembers;
  const sharedMember = activeMembers.find(member => !member.worktree && (!group.workspace || member.cwd === group.workspace));
  const shownPhone = splitMembers.find(member => member.id === phoneMember) ?? splitMembers[0];
  // Same as private chats: Esc or Ctrl/⌘+Shift+Enter leaves fullscreen.
  return <section className={`group-board group-chat${fullscreen ? ' group-fullscreen' : ''}`} onKeyDown={event => {
    if (event.nativeEvent.isComposing || event.defaultPrevented) return;
    if (event.key === 'Escape' && fullscreen && !mention) { event.preventDefault(); setFullscreen(false); }
    else if (event.key === 'Enter' && event.shiftKey && (event.ctrlKey || event.metaKey)) { event.preventDefault(); setFullscreen(value => !value); }
  }}>
    <header className="group-chat-header">
      <button className="icon-button group-chat-back" aria-label="返回联系人列表" onClick={back}><ArrowLeft size={18} /></button>
      <div className="group-chat-title"><strong title={group.title}>{group.title}</strong>{group.goal && <p className="group-goal-line" title={group.goal}>目标：{group.goal}</p>}</div>
      <div className="group-member-strip" role="toolbar" aria-label="群成员与只看">
        {activeMembers.map(member => <button key={member.id} className={`group-member-chip${only === member.id ? ' selected' : ''}`} aria-pressed={only === member.id} title={`只看 ${member.title}`} aria-label={`只看 ${member.title}`} onClick={() => { setOnly(current => current === member.id ? null : member.id); setSplit(false); }}><BackendAvatar backend={member.backend} small />{member.status === 'running' && <i className="group-member-running" />}</button>)}
        <button className="icon-button" aria-label="添加成员" title="新建成员或 Fork 联系人入群" onClick={addMember}><Plus size={15} /></button>
      </div>
      <div className="group-chat-actions">
        {onShare && <button className="icon-button" aria-label="分享群聊" title="分享群聊" onClick={onShare}><Share2 size={16} /></button>}
        <button className={`icon-button${fullscreen ? ' active' : ''}`} aria-pressed={fullscreen} aria-label={fullscreen ? '退出群聊全屏' : '全屏群聊'} title={fullscreen ? '退出全屏（Esc）' : '全屏群聊（Ctrl/⌘ + Shift + Enter）'} onClick={() => setFullscreen(value => !value)}>{fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
        <button className="icon-button" aria-label="打开群工作区" title={group.workspace ? `群工作区：${group.workspace}` : '还没有群工作区'} disabled={!sharedMember} onClick={() => sharedMember && openWorkspace(sharedMember)}><FolderOpen size={16} /></button>
        <button className={`icon-button${split ? ' active' : ''}`} aria-pressed={split} aria-label={split ? '退出分栏' : '一键分栏'} title={split ? '退出分栏' : '每个成员一栏，同时查看'} disabled={!activeMembers.length} onClick={() => setSplit(value => !value)}><Columns3 size={16} /></button>
        <button className={`icon-button${membersOpen ? ' active' : ''}`} aria-expanded={membersOpen} aria-label="群成员" title="群成员" onClick={() => setMembersOpen(value => !value)}><UsersRound size={16} /></button>
        <button className="icon-button" aria-label="群设置" title="名称、目标与群 prompt" onClick={editGroup}><Settings2 size={16} /></button>
      </div>
      {membersOpen && <div className="group-members-panel" role="dialog" aria-label="群成员">
        {editWorkspacePermissions && <button className="text-button" onClick={() => { setMembersOpen(false); editWorkspacePermissions(); }}><FolderPlus size={14} />群工作区权限</button>}
        {group.workspace && <div className="group-workspace-line" title={group.workspace}><FolderOpen size={13} />群工作区：{tail(group.workspace)}</div>}
        {activeMembers.map(member => <div className="group-members-row" key={member.id}><button className="member-avatar-link" aria-label={`打开 ${member.title} 的私聊`} onClick={() => { setMembersOpen(false); open(member.id, true); }}><BackendAvatar backend={member.backend} small /></button><div className="group-members-info"><div><strong>{member.title}</strong><StatusBadge session={member} /></div><MemberPlacement member={member} workspace={group.workspace} busy={!!busy} onChanged={notify} onError={setLocalError} /></div><button className="icon-button" aria-label={`打开 ${member.title} 的工作区`} title="在资源管理器中查看文件与改动" onClick={() => openWorkspace(member)}><FolderOpen size={14} /></button><button className="text-button" onClick={() => { setMembersOpen(false); open(member.id, true); }}>私聊</button><button className="icon-button" aria-label={`将 ${member.title} 移出群聊`} title="移出群聊（保留联系人）" onClick={() => removeMember(member)}><UserMinus size={14} /></button></div>)}
        <button className="text-button" onClick={() => { setMembersOpen(false); addMember(); }}><Plus size={14} />添加成员</button>
      </div>}
    </header>
    {only && <div className="group-only-bar"><span>只看 {membersById.get(only)?.title}</span><button className="text-button" onClick={() => setOnly(null)}><X size={13} />查看全部</button></div>}
    <div className="board-content">
      {split ? compact
        ? <div className="group-split phone"><div className="group-split-tabs" role="tablist">{splitMembers.map(member => <button key={member.id} role="tab" aria-selected={member.id === shownPhone?.id} onClick={() => setPhoneMember(member.id)}><BackendAvatar backend={member.backend} small />{member.title}</button>)}</div>{shownPhone && <MemberPane key={shownPhone.id} member={shownPhone} chatCapable={chatCapable(shownPhone)} open={() => open(shownPhone.id, true)} />}</div>
        : <div className="group-split" style={{ ['--group-columns' as string]: String(Math.min(4, splitMembers.length)) }}>{splitMembers.map(member => <MemberPane key={member.id} member={member} chatCapable={chatCapable(member)} open={() => open(member.id, true)} />)}</div>
        : messageList}
      {sourcePreview && <ModalShell title="来源消息" subtitle={sourcePreview.senderName} close={() => setSourcePreview(null)}><div className="modal-fields"><p className="draft-replace-preview">{sourcePreview.text}</p></div><div className="modal-footer"><button className="button secondary" onClick={() => { forwardMessage(sourcePreview); setSourcePreview(null); }}>转交为任务</button><button className="button primary" onClick={() => setSourcePreview(null)}>返回群组</button></div></ModalShell>}
      <form className="message-composer group-composer" onSubmit={submit}>
        <div className="recipient-picker"><span><AtSign size={13} />指派给</span>{activeMembers.map(member => <button type="button" disabled={posting} aria-pressed={recipients.includes(member.id)} key={member.id} className={recipients.includes(member.id) ? 'selected' : ''} onClick={() => toggleRecipient(member.id)}>{recipients.includes(member.id) && <Check size={12} />}<BackendAvatar backend={member.backend} small />{member.title}</button>)}{!activeMembers.length && <small>添加成员后，即可 @ 指派任务</small>}</div>
        {references.length > 0 && <div className="composer-references">{references.map(id => { const quoted = messagesById.get(id); return <span key={id} className="reference-chip"><Quote size={12} />{quoted?.senderName || '回答'}：{(quoted?.text || '').slice(0, 40)}<button type="button" className="icon-button" aria-label="取消引用" onClick={() => setReferences(current => current.filter(item => item !== id))}><X size={12} /></button></span>; })}</div>}
        {sourceMessageId && <div className="composer-source"><button type="button" className="text-button" onClick={() => jumpToMessage(sourceMessageId)}><Share2 size={13} />来源：{sourceMessage?.senderName || '原消息'}<span>查看原消息</span></button><button type="button" className="icon-button" disabled={posting} aria-label="解除转交来源" title="解除来源，保留内容" onClick={() => setSourceMessageId(null)}><X size={13} /></button></div>}
        {mentionChoices.length > 0 && <div ref={mentionMenuRef} id={mentionMenuId} className="mention-menu" role="listbox" aria-label="选择要 @ 的成员">{mentionChoices.map((member, index) => <button type="button" role="option" id={`${mentionMenuId}-${index}`} aria-selected={index === selectedMentionIndex} key={member.id} onMouseEnter={() => setMentionIndex(index)} onMouseDown={event => event.preventDefault()} onClick={() => chooseMention(member)}><BackendAvatar backend={member.backend} small />{member.title}</button>)}</div>}
        <ImageAttachments sessionId={group.id} scope="groups" actions={<><VoiceInput sessionId={group.id} scope="groups" disabled={posting || uploading} onActive={setVoiceActive} insert={speech => setText(current => appendVoiceText(current, speech))} /><span title="草稿保留在当前浏览器标签页；Enter 发送，Shift + Enter 换行">{activeRecipients.length ? `发送后立即投递给 ${activeRecipients.length} 位成员，回复会自动回到群里。` : defaultMember ? `未 @，默认发送给 ${defaultMember.title}。` : '尚无成员回复；可 @ 成员指派任务。'}{text && <small className="draft-note">草稿保留 · Enter 发送 · Shift + Enter 换行</small>}</span><button className="button primary small-button" disabled={!!busy || posting || uploading || voiceActive || (!text.trim() && !images.length)}>{busy === 'message' ? <LoaderCircle size={14} className="spin" /> : <Send size={14} />}{deliveryRecipients.length ? '发送任务' : '发送'}</button></>} items={images} onChange={update => {
          const saved = JSON.parse(currentDraftRef.current) as GroupDraft;
          saved.attachments = update(saved.attachments);
          currentDraftRef.current = JSON.stringify(saved);
          try { sessionStorage.setItem(`sessiondeck.group-draft.${group.id}`, currentDraftRef.current); } catch { /* Optional storage. */ }
          setImages(saved.attachments);
        }} onBusy={setUploading} disabled={posting}>
        <textarea ref={composerRef} disabled={posting} aria-label="群组消息" aria-controls={mentionChoices.length ? mentionMenuId : undefined} aria-activedescendant={mentionChoices.length ? `${mentionMenuId}-${selectedMentionIndex}` : undefined} onKeyDown={event => {
          // Chinese IME candidate selection must never send or pick a member.
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          // Delete a confirmed @ as one unit, including its separator.
          const field = event.currentTarget;
          if ((event.key === 'Backspace' || event.key === 'Delete') && field.selectionStart === field.selectionEnd) {
            const caret = field.selectionStart;
            for (const id of recipients) {
              const member = membersById.get(id);
              const range = member && mentionRange(text, member.title);
              if (!range) continue;
              const end = range.end + (text[range.end] === ' ' ? 1 : 0);
              if ((event.key === 'Backspace' && caret > range.start && caret <= end) || (event.key === 'Delete' && caret >= range.start && caret < range.end)) {
                event.preventDefault();
                onText(text.slice(0, range.start) + text.slice(end), range.start);
                setMention(null);
                requestAnimationFrame(() => field.setSelectionRange(range.start, range.start));
                return;
              }
            }
          }
          if (mentionChoices.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            setMentionIndex((selectedMentionIndex + (event.key === 'ArrowDown' ? 1 : -1) + mentionChoices.length) % mentionChoices.length);
            return;
          }
          if (mentionChoices.length && !event.shiftKey && (event.key === 'Enter' || event.key === 'Tab')) { event.preventDefault(); chooseMention(mentionChoices[selectedMentionIndex]); return; }
          if (event.key === 'Escape' && mention !== null) { event.preventDefault(); setMention(null); return; }
          // Enter sends, Shift+Enter inserts a newline, like private chats.
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
        }} onSelect={event => { const field = event.currentTarget; if (mention && (field.selectionStart < mention.start || field.selectionStart > mention.end + 1)) setMention(null); }} placeholder={activeRecipients.length ? '描述任务；成员会收到群 prompt、任务和你引用的结论…' : defaultMember ? `发送给 ${defaultMember.title}，输入 @ 可切换成员…` : '输入 @ 指派成员，或直接记录想法…'} value={text} onChange={event => onText(event.target.value, event.target.selectionStart)} rows={3} maxLength={30000} />
        </ImageAttachments>
        {localError && <p role="alert" className="form-error">{localError}</p>}
      </form>
    </div>
  </section>;
}
