import { PaneToolOverflow, SessionToolbar, useSessionChrome } from './SessionToolbar';
import './chat-presentation.css';
import { appUrl } from './urls';
import { memo, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowDownToLine, Check, ChevronRight, CircleAlert, List, LoaderCircle, MessageSquare, RefreshCw, Send, Settings2, Square, TerminalSquare } from 'lucide-react';
import type { Session } from '../shared/types';
import type { AgentChatAnswer, AgentChatHistoryPage, AgentChatItem, AgentChatPatch, AgentChatRequest, AgentChatSnapshot, AgentChatSubmission } from '../shared/chat';
import { api, ApiError } from './api';
import Markdown from './Markdown';
import { interfaceScale } from './zoom';
import ImageAttachments from './ImageAttachments';
import type { ChatAttachment } from '../shared/attachments';
import ConversationOutline from './ConversationOutline';
import NoticeToasts from './NoticeToasts';
import ResizableComposer from './ResizableComposer';
import VoiceInput, { appendVoiceText } from './VoiceInput';
import MessageQueue, { readQueue, type QueuedMessage } from './MessageQueue';
import ChatActivity from './ChatActivity';
import AgentChatSettingsPanel from './AgentChatSettingsPanel';
import AgentChatQuickSettings from './AgentChatQuickSettings';
import AgentChatCommands, { type ChatCommand } from './AgentChatCommands';
import { useAgentChatSettings, type SettingField } from './useAgentChatSettings';
import './codex-chat.css';

type Pending = { requestId: string; text: string; attachments?: ChatAttachment[]; queueId?: string };
type Draft = { text: string; pending: Pending | null; attachments: ChatAttachment[]; queue?: QueuedMessage[] };
type OlderHistory = { identity: string; instanceId?: string; items: AgentChatItem[]; cursor: string | null; loading: boolean; error: string; notice?: string; limited?: boolean };
const draftKey = (id: string) => `sessiondeck.codex-chat-draft.${id}`;
function readDraft(id: string, backend?: string): Draft {
  try {
    let value = JSON.parse(sessionStorage.getItem(draftKey(id)) ?? 'null');
    if (!value && backend === 'claude') {
      const old = JSON.parse(sessionStorage.getItem('dili.native-input-draft.' + id) ?? 'null');
      if (old && typeof old.text === 'string') value = { ...old,
        queue: readQueue(old.queue).map(item => ({ ...item, paused: true })),
        pending: typeof old.pending === 'string' ? { requestId: old.pending, text: old.pendingMessage?.text ?? old.text, attachments: (old.attachments ?? []).filter((item: ChatAttachment) => (old.pendingMessage?.attachments ?? []).includes(item.id)), queueId: old.pendingMessage?.queueId } : null,
      };
    }
    if (value && typeof value.text === 'string') return {
      text: value.text.slice(0, 30000),
      attachments: Array.isArray(value.attachments) ? value.attachments.filter((item: ChatAttachment) => typeof item?.id === 'string' && typeof item.name === 'string').slice(0,8) : [],
      pending: typeof value.pending?.requestId === 'string' && typeof value.pending.text === 'string' ? value.pending : null,
      queue:readQueue(value.queue),
    };
  } catch { /* A missing or invalid draft must not prevent reading the session. */ }
  return { text: '', pending: null, attachments: [] };
}
function saveDraft(id: string, value: Draft) {
  try { sessionStorage.setItem(draftKey(id), JSON.stringify(value)); return true; } catch { return false; }
}
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败，请稍后重试';
function requestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
}

const MessageItem = memo(function MessageItem({ item, highlighted = false, agentName = 'Codex' }: { item: AgentChatItem; highlighted?: boolean; agentName?: string }) {
  if (item.type === 'assistant' || item.type === 'user') return <article className={`chat-message chat-${item.type} codex-message codex-${item.type}${highlighted ? ' codex-message-highlighted' : ''}`} data-chat-item={item.id} tabIndex={item.type === 'user' ? -1 : undefined}>
    <div className="chat-message-heading codex-message-heading"><strong>{item.type === 'user' ? '你' : agentName}</strong>{item.status === 'inProgress' && <span><LoaderCircle size={11} className="spin" />正在回复</span>}{item.status === 'failed' && <span>未完成</span>}</div>
    <div className="chat-message-body codex-message-body">{item.type === 'assistant' ? <Markdown text={item.text || '…'} /> : <><p>{item.text}</p>{!!item.imageCount && <p className="codex-image-count">附带 {item.imageCount} 张图片</p>}</>}</div>
  </article>;
  if (item.type === 'notice') return <p className="codex-inline-notice" data-chat-item={item.id}>{item.text}</p>;
  if (item.type === 'plan') return <article className="codex-plan" data-chat-item={item.id}><strong>{item.title || '执行计划'}</strong><Markdown text={item.text} /></article>;
  return <details className={`codex-tool ${item.status === 'failed' ? 'failed' : ''}`} data-chat-item={item.id}>
    <summary><ChevronRight size={13} />{item.status === 'inProgress' ? <LoaderCircle size={13} className="spin" /> : item.status === 'failed' ? <CircleAlert size={13} /> : <Check size={13} />}<span>{item.title || (item.type === 'command' ? '运行命令' : item.type === 'fileChange' ? '修改文件' : '使用工具')}</span><small>{item.status === 'inProgress' ? '执行中' : item.status === 'failed' ? '失败' : '已完成'}</small></summary>
    {item.text && <pre>{item.text}</pre>}{item.output && <pre className="codex-tool-output">{item.output}</pre>}
  </details>;
});

function NativeRequest({ request, disabled, answer, agentName = 'Codex' }: { agentName?: string; request: AgentChatRequest; disabled: boolean; answer: (id: string, answer: AgentChatAnswer) => Promise<void> }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(payload: AgentChatAnswer) {
    if (busy || disabled) return;
    setBusy(true); setError('');
    try { await answer(request.id, payload); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  const questions = request.questions ?? [];
  const complete = questions.every(question => !!(values[question.id] === '__other__' ? other[question.id]?.trim() : values[question.id]?.trim()));
  return <section className="codex-request" aria-label={request.kind === 'question' ? `${agentName} 提问` : `${agentName} 审批`}>
    <div className="codex-request-heading"><CircleAlert size={16} /><h3>{request.title}</h3></div>
    {request.description && <p>{request.description}</p>}
    {request.details && <details open><summary>操作详情</summary><pre>{request.details}</pre></details>}
    {request.kind === 'question' ? <form onSubmit={(event) => {
      event.preventDefault(); if (!complete) return;
      void submit({ answers: Object.fromEntries(questions.map(question => [question.id, [values[question.id] === '__other__' ? other[question.id].trim() : values[question.id].trim()]])) });
    }}>
      {questions.map(question => <fieldset key={question.id} disabled={disabled || busy}><legend>{question.header && <span>{question.header} · </span>}{question.question}</legend>
        {question.options?.length ? <><div className="codex-question-options">{question.options.map(option => <label key={option.label}><input type="radio" name={`${request.id}-${question.id}`} value={option.label} checked={values[question.id] === option.label} onChange={() => setValues(current => ({ ...current, [question.id]: option.label }))} /><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span></label>)}{question.isOther && <label><input type="radio" name={`${request.id}-${question.id}`} checked={values[question.id] === '__other__'} onChange={() => setValues(current => ({ ...current, [question.id]: '__other__' }))} /><span>其他答案</span></label>}</div>
          {values[question.id] === '__other__' && <input aria-label={`${question.question}：其他答案`} type={question.isSecret ? 'password' : 'text'} value={other[question.id] ?? ''} onChange={event => setOther(current => ({ ...current, [question.id]: event.target.value }))} maxLength={8000} autoComplete="off" />}</>
          : <input aria-label={question.question} type={question.isSecret ? 'password' : 'text'} value={values[question.id] ?? ''} onChange={event => setValues(current => ({ ...current, [question.id]: event.target.value }))} maxLength={8000} autoComplete="off" />}
      </fieldset>)}<button type="submit" className="button primary small-button" disabled={disabled || busy || !complete}>{busy ? '提交中…' : '提交回答'}</button>
    </form> : <div className="codex-approval-actions">{request.options?.map(option => <button type="button" key={option.id} className="button secondary small-button" disabled={disabled || busy} onClick={() => void submit({ decision: option.id })}>{option.label}</button>)}{request.kind === 'unsupported' && <p>当前界面还不能处理这个请求，请在原生终端中核对。</p>}</div>}
    {error && <p className="codex-request-error" role="alert">{error}</p>}
  </section>;
}

export default function AgentChatPane(props: { session: Session; onTerminal: () => void; onSelection?: (text: string) => void }) {
  return <ChatSession key={props.session.id} {...props} />;
}

function ChatSession({ session, onTerminal, onSelection }: { session: Session; onTerminal: () => void; onSelection?: (text: string) => void }) {
  const chrome = useSessionChrome();
  const agentName = session.backend === 'claude' ? 'Claude' : 'Codex';
  const [draft, setDraft] = useState(() => readDraft(session.id, session.backend));
  const [snapshot, setSnapshot] = useState<AgentChatSnapshot | null>(null);
  const [older, setOlder] = useState<OlderHistory | null>(null);
  const olderRef = useRef(older);
  olderRef.current = older;
  const [transport, setTransport] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [awaitingTurnId, setAwaitingTurnId] = useState<string | null>(null);
  const [voiceActive, setVoiceActive] = useState(false);
  const [preview, setPreview] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkedUnknown, setCheckedUnknown] = useState(false);
  const [checkNotice, setCheckNotice] = useState('');
  const [interrupting, setInterrupting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsField, setSettingsField] = useState<SettingField | undefined>();
  const [compactOutline, setCompactOutline] = useState(false);
  const [selectedInput, setSelectedInput] = useState<string | null>(null);
  const [highlightedInput, setHighlightedInput] = useState<string | null>(null);
  const outlineId = useId();
  const pane = useRef<HTMLElement>(null);
  const outlineButton = useRef<HTMLButtonElement>(null);
  const snapshotRef = useRef(snapshot);
  const draftRef = useRef(draft);
  const sessionRef = useRef(session);
  const active = useRef(true);
  const busyRef = useRef(false);
  const onSelectionRef = useRef(onSelection);
  const readSnapshot = useRef<() => Promise<void>>(async () => {});
  const scroller = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const followsBottom = useRef(true);
  const scrollAnchor = useRef<{ id: string; offset: number } | null>(null);
  const olderLoading = useRef<symbol | null>(null);
  useLayoutEffect(() => {
    const element = pane.current;
    if (!element) return;
    const measure = () => setCompactOutline(element.clientWidth <= 720);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!highlightedInput) return;
    const timer = setTimeout(() => setHighlightedInput(null), 1800);
    return () => clearTimeout(timer);
  }, [highlightedInput]);
  function closeOutline() {
    setOutlineOpen(false);
    outlineButton.current?.focus({ preventScroll: true });
  }
  function jumpToInput(id: string) {
    const element = scroller.current;
    const target = [...(element?.querySelectorAll<HTMLElement>('[data-chat-item]') ?? [])].find(item => item.dataset.chatItem === id);
    if (!element || !target) return;
    followsBottom.current = false;
    scrollAnchor.current = null;
    element.scrollTop += (target.getBoundingClientRect().top - element.getBoundingClientRect().top) / interfaceScale() - 12;
    target.focus({ preventScroll: true });
    setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 64);
    setSelectedInput(id); setHighlightedInput(id);
  }
  function jumpToRequest(id: string) {
    const element = scroller.current;
    const target = [...(element?.querySelectorAll<HTMLElement>('[data-chat-request]') ?? [])].find(item => item.dataset.chatRequest === id);
    if (!element || !target) return;
    followsBottom.current = false;
    scrollAnchor.current = null;
    element.scrollTop += (target.getBoundingClientRect().top - element.getBoundingClientRect().top) / interfaceScale() - 12;
    setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 64);
    target.querySelector<HTMLElement>('button, input')?.focus({ preventScroll: true });
  }
  async function loadOlder() {
    const nativeId = snapshot?.nativeSessionId;
    const instanceId = snapshot?.instanceId;
    const cursor = older && older.identity === nativeId ? older.cursor : snapshot?.historyCursor;
    if (!nativeId || !cursor || olderLoading.current || older?.limited) return;
    const job = Symbol('history-page');
    olderLoading.current = job;
    setOlder(previous => ({ identity: nativeId, instanceId, items: previous?.identity === nativeId && previous.instanceId === instanceId ? previous.items : snapshot.items, cursor, loading: true, error: '' }));
    try {
      const page = await api<AgentChatHistoryPage>(`/sessions/${encodeURIComponent(session.id)}/chat/history?cursor=${encodeURIComponent(cursor)}`);
      if (!active.current || snapshotRef.current?.nativeSessionId !== nativeId || snapshotRef.current?.instanceId !== instanceId) return;
      if (page.nativeSessionId !== nativeId) throw new Error('历史记录的会话身份不匹配，请重新读取。');
      const element = scroller.current;
      if (element) {
        const top = element.getBoundingClientRect().top;
        const visible = [...element.querySelectorAll<HTMLElement>('[data-chat-item]')].find(item => item.getBoundingClientRect().bottom > top);
        scrollAnchor.current = visible ? { id: visible.dataset.chatItem!, offset: visible.getBoundingClientRect().top - top } : null;
      }
      followsBottom.current = false;
      setOlder(previous => {
        if (previous?.identity !== nativeId || previous.instanceId !== instanceId || previous.cursor !== cursor) return previous;
        const known = new Set(previous.items.map(item => item.id));
        const items = [...page.items.filter(item => !known.has(item.id)), ...previous.items];
        if (items.length > 1000 || items.reduce((sum, item) => sum + item.text.length + (item.output?.length ?? 0), 0) > 2_000_000) return { ...previous, loading: false, limited: true, notice: '已达到本页历史显示上限。可重新进入会话释放已加载记录，或在原生终端查看完整历史。' };
        return { identity: nativeId, instanceId, items, cursor: page.nextCursor, loading: false, error: '', notice: page.truncated ? '这一页的部分工具输出或超长轮次已省略，完整记录可在原生终端查看。' : '' };
      });
    } catch (cause) {
      if (!active.current) return;
      setOlder(previous => previous?.identity === nativeId && previous.instanceId === instanceId && previous.cursor === cursor ? { ...previous, loading: false, error: errorText(cause) } : previous);
    } finally { if (olderLoading.current === job) olderLoading.current = null; }
  }
  async function reconnectNative() {
    if (reconnecting || !transport) return;
    setReconnecting(true); setError('');
    try {
      if (session.backend === 'claude' && session.executionTransport !== 'structured') {
        if (!window.confirm('切换将退出当前 Claude 进程，并从同一份已保存会话恢复。当前任务和审批必须先处理完成。继续切换？')) return;
        await api(`/sessions/${encodeURIComponent(session.id)}/start`, { mode: 'chat', handoff: true });
      }
      else await api(`/sessions/${encodeURIComponent(session.id)}/chat/connect`, {});
      if (active.current) await readSnapshot.current();
    } catch (cause) { if (active.current) setError(errorText(cause)); }
    finally { if (active.current) setReconnecting(false); }
  }
  draftRef.current = draft; sessionRef.current = session; onSelectionRef.current = onSelection;
  function updateDraft(next: Draft) {
    draftRef.current = next; saveDraft(session.id, next);
    if (active.current) setDraft(next);
    else window.dispatchEvent(new CustomEvent('sessiondeck:codex-draft', { detail: { id: session.id } }));
  }

  useEffect(() => {
    active.current = true;
    let disposed = false;
    let sequence = 0;
    let sourceReset = true;
    let refreshJob: Promise<void> | undefined;
    let refreshAgain = false;
    function install(next: AgentChatSnapshot) {
      if (disposed) return;
      const previous = snapshotRef.current;
      if (previous?.instanceId === next.instanceId && previous?.nativeSessionId === next.nativeSessionId && next.revision < previous.revision) return;
      const element = scroller.current;
      if (!followsBottom.current && element) {
        const historyItems = olderRef.current?.identity === next.nativeSessionId && olderRef.current.instanceId === next.instanceId ? olderRef.current.items : [];
        const aliases = new Map(next.items.flatMap(item => (item.replaces ?? []).map(key => [key, item.id] as const)));
        const retained = new Set([...historyItems, ...next.items].flatMap(item => [item.id, ...(item.replaces ?? [])]));
        const top = element.getBoundingClientRect().top;
        const visible = [...element.querySelectorAll<HTMLElement>('[data-chat-item]')].find(item => retained.has(item.dataset.chatItem!) && item.getBoundingClientRect().bottom > top);
        scrollAnchor.current = visible ? { id: aliases.get(visible.dataset.chatItem!) ?? visible.dataset.chatItem!, offset: visible.getBoundingClientRect().top - top } : null;
      }
      if (previous?.nativeSessionId !== next.nativeSessionId || previous?.instanceId !== next.instanceId) { olderLoading.current = null; setOlder(null); }
      else setOlder(history => {
        if (!history || history.identity !== next.nativeSessionId) return history;
        const known = new Set([...history.items, ...next.items].flatMap(item => [item.id, ...(item.replaces ?? [])]));
        const evicted = previous.items.filter(item => !known.has(item.id));
        if (!evicted.length) return history;
        const items = [...history.items, ...evicted];
        let total = items.reduce((sum, item) => sum + item.text.length + (item.output?.length ?? 0), 0);
        let removed = false;
        while (items.length > 1000 || total > 2_000_000) { const item = items.shift()!; total -= item.text.length + (item.output?.length ?? 0); removed = true; }
        return { ...history, items, ...(removed ? { notice: '已加载记录达到显示上限，最早的一部分已收起。完整历史可在原生终端查看。' } : {}) };
      });
      snapshotRef.current = next; setSnapshot(next); setLoading(false); setError('');
    }
    async function refresh(required = false): Promise<void> {
      if (disposed) return;
      if (refreshJob) { refreshAgain ||= required; return refreshJob; }
      const before = sequence;
      refreshJob = (async () => {
        try { const result = await api<AgentChatSnapshot>(`/sessions/${session.id}/chat`); if (sequence === before) install(result); }
        catch (cause) { if (!disposed && sequence === before) { setError(errorText(cause)); setLoading(false); } }
        finally { refreshJob = undefined; if (refreshAgain && !disposed) { refreshAgain = false; void refresh(); } }
      })();
      return refreshJob;
    }
    readSnapshot.current = refresh;
    const source = new EventSource(appUrl(`/api/sessions/${encodeURIComponent(session.id)}/chat/events`));
    source.onopen = () => { if (!disposed) { sourceReset = true; setTransport(true); } };
    source.onerror = () => { if (!disposed) setTransport(false); };
    source.addEventListener('unavailable', event => {
      if (disposed) return;
      setTransport(false);
      try { const details = JSON.parse((event as MessageEvent).data) as { error?: string }; setError(details.error || '原生会话连接暂不可用，请刷新后重试。'); }
      catch { setError('原生会话连接暂不可用，请刷新后重试。'); }
    });
    source.addEventListener('state', event => {
      try {
        const next = JSON.parse((event as MessageEvent).data) as AgentChatSnapshot;
        const previous = snapshotRef.current;
        if (!sourceReset && previous?.instanceId === next.instanceId && previous?.nativeSessionId === next.nativeSessionId && next.revision < previous.revision) return;
        sourceReset = false; sequence++; install(next);
      } catch { void refresh(); }
    });
    source.addEventListener('patch', event => {
      try {
        const patch = JSON.parse((event as MessageEvent).data) as AgentChatPatch;
        const previous = snapshotRef.current;
        if (previous && patch.instanceId === previous.instanceId && patch.nativeSessionId === previous.nativeSessionId && patch.revision <= previous.revision) return;
        if (!previous || patch.instanceId !== previous.instanceId || patch.nativeSessionId !== previous.nativeSessionId || patch.baseRevision !== previous.revision) { sequence++; void refresh(true); return; }
        const items = new Map(previous.items.map(item => [item.id, item]));
        for (const item of patch.items) items.set(item.id, item);
        if (patch.order.some(id => !items.has(id))) { sequence++; void refresh(true); return; }
        sequence++; install({ instanceId: patch.instanceId, nativeSessionId: patch.nativeSessionId, revision: patch.revision, connected: patch.connected, activeTurnId: patch.activeTurnId, requests: patch.requests, truncated: patch.truncated, historyCursor: patch.historyCursor, notice: patch.notice, items: patch.order.map(id => items.get(id)!) });
      } catch { void refresh(); }
    });
    void refresh();
    const visible = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    const changedDraft = (event: Event) => {
      if ((event as CustomEvent<{ id: string }>).detail.id === session.id) { const next = readDraft(session.id); draftRef.current = next; setDraft(next); }
    };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('sessiondeck:codex-draft', changedDraft);
    return () => { disposed = true; active.current = false; source.close(); document.removeEventListener('visibilitychange', visible); window.removeEventListener('sessiondeck:codex-draft', changedDraft); onSelectionRef.current?.(''); };
  }, [session.id]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (followsBottom.current) element.scrollTop = element.scrollHeight;
    else if (scrollAnchor.current) {
      const { id, offset } = scrollAnchor.current;
      const target = [...element.querySelectorAll<HTMLElement>('[data-chat-item]')].find(item => item.dataset.chatItem === id);
      if (target) element.scrollTop += (target.getBoundingClientRect().top - element.getBoundingClientRect().top - offset) / interfaceScale();
    }
    scrollAnchor.current = null;
  }, [snapshot, older]);
  useEffect(() => {
    const element = scroller.current;
    const observer = new ResizeObserver(() => { if (element && followsBottom.current) element.scrollTop = element.scrollHeight; });
    if (element) observer.observe(element);
    const select = () => {
      const selected = window.getSelection();
      if (!selected || !element) return;
      const from = selected.anchorNode?.parentElement?.closest('.codex-message-body');
      const to = selected.focusNode?.parentElement?.closest('.codex-message-body');
      onSelectionRef.current?.(from && to && element.contains(from) && element.contains(to) ? selected.toString().trim() : '');
    };
    document.addEventListener('selectionchange', select);
    return () => { observer.disconnect(); document.removeEventListener('selectionchange', select); };
  }, []);

  function accepted(pending: Pending, turnId?: string) {
    // A late response may finish after this panel was closed and reopened.
    // Clear only its own submitted snapshot, preserving the newer editor.
    const current = active.current ? draftRef.current : readDraft(session.id);
    if (current.pending?.requestId !== pending.requestId) return;
    updateDraft({ text: !pending.queueId && current.text === pending.text ? '' : current.text, attachments: pending.queueId ? current.attachments : current.attachments.filter(item => !pending.attachments?.some(sent => sent.id === item.id)), pending: null, queue:current.queue?.filter(item=>item.id!==pending.queueId) });
    if (active.current) { if (turnId) setAwaitingTurnId(turnId); setCheckNotice(''); setCheckedUnknown(false); void readSnapshot.current(); }
  }
  async function checkSubmission() {
    const pending = draftRef.current.pending;
    if (!pending || checking) return;
    setChecking(true); setCheckNotice('');
    try {
      const result = await api<AgentChatSubmission>(`/sessions/${session.id}/chat/submissions/${encodeURIComponent(pending.requestId)}`);
      if (!active.current || draftRef.current.pending?.requestId !== pending.requestId) return;
      if (result.status === 'accepted') accepted(pending);
      else if (result.status === 'rejected') { updateDraft({ ...draftRef.current, pending: null }); setError(result.error || '这条消息未被接收，草稿已保留，可以修改后重试。'); }
      else { setCheckedUnknown(result.status === 'unknown'); setCheckNotice(result.status === 'sending' ? '服务仍在提交这条消息，请稍后再次查询。' : '暂时无法确认。请先检查对话记录或原生终端，避免重复发送。'); }
    } catch (cause) {
      if (active.current) { setCheckedUnknown(cause instanceof ApiError && cause.status === 404); setCheckNotice(cause instanceof ApiError && cause.status === 404 ? '服务可能已重启，找不到本次发送记录。请先核对原生会话是否已收到。' : errorText(cause)); }
    } finally { if (active.current) setChecking(false); }
  }

  async function send(event?: FormEvent, queued?: QueuedMessage) {
    event?.preventDefault();
    const source=queued || draftRef.current, text = source.text;
    if (!queued && !source.attachments.length && /^\/(settings|model|permissions)$/.test(text.trim())) {
      openCommand(text.trim().slice(1) as ChatCommand); return;
    }
    if ((!text.trim() && !source.attachments.length) || voiceActive || uploading || settingsController.saving || busyRef.current || draftRef.current.pending || !transport || session.archived || snapshotRef.current?.requests.length || (session.running && !snapshotRef.current?.connected)) return;
    if (!queued && session.backend === 'claude' && snapshotRef.current?.activeTurnId) { enqueue(); return; }
    const expectedTurnId = snapshotRef.current?.activeTurnId;
    busyRef.current = true; setBusy(true); setError(''); setCheckNotice('');
    let pending: Pending | undefined;
    try {
      if(queued && queued.identity!==`${snapshotRef.current?.instanceId}:${snapshotRef.current?.nativeSessionId}`) throw new Error('原生连接已变化；排队消息已暂停，请编辑后重新加入队列');
      if (!sessionRef.current.running || sessionRef.current.interactionMode !== 'chat') await api(`/sessions/${session.id}/start`, { mode: 'chat' });
      if (!active.current) return;
      pending = { requestId: requestId(), text, attachments: [...source.attachments],...(queued ? {queueId:queued.id} : {}) };
      const next = { ...draftRef.current, pending };
      if (!saveDraft(session.id, next)) throw new Error('无法保存本次发送状态。请允许此站点使用浏览器存储后重试。');
      updateDraft(next);
      const result = await api<AgentChatSubmission>(`/sessions/${session.id}/chat/messages`, { text, attachments: pending.attachments?.map(item => item.id), requestId: pending.requestId, ...(expectedTurnId ? { expectedTurnId } : {}) });
      if (result.status === 'accepted') accepted(pending, result.turnId);
      else if (result.status === 'rejected') { const current = active.current ? draftRef.current : readDraft(session.id); if (current.pending?.requestId === pending.requestId) updateDraft({ ...current, pending: null }); if (active.current) setError(result.error || '消息未被接收，草稿已保留。'); }
      else if (active.current) setCheckNotice(result.status === 'sending' ? '消息正在提交，请查询发送结果。' : '发送结果尚未确认，请查询结果后继续。');
    } catch (cause) {
      if (pending && cause instanceof ApiError && cause.status >= 400 && cause.status < 500) { const current = active.current ? draftRef.current : readDraft(session.id); if (current.pending?.requestId === pending.requestId) updateDraft({ ...current, pending: null }); }
      if (active.current) setError(errorText(cause));
    } finally {
      // A refused or uncertain queued send is never automatically retried.
      if(queued) {const current=active.current ? draftRef.current : readDraft(session.id); if(current.queue?.some(item=>item.id===queued.id)) updateDraft({...current,queue:current.queue.map(item=>item.id===queued.id ? {...item,paused:true} : item)});}
      busyRef.current = false;
      if (active.current) { setBusy(false); textarea.current?.focus(); }
    }
  }
  function enqueue() {
    const current=draftRef.current;
    if(!canSend || !snapshotRef.current?.connected || busyRef.current) return;
    if((current.queue?.length||0)>=10) {setError('最多排队 10 条消息');return;}
    const next={...current,text:'',attachments:[],queue:[...(current.queue||[]),{id:requestId(),text:current.text,attachments:current.attachments,identity:`${snapshotRef.current.instanceId}:${snapshotRef.current.nativeSessionId}`}]};
    if(!saveDraft(session.id,next)) {setError('无法保存排队消息，草稿已保留');return;}
    updateDraft(next);setError('');textarea.current?.focus();
  }
  function editQueue(item:QueuedMessage) {
    const current=draftRef.current;
    if(current.text.trim() || current.attachments.length) {setError('请先处理输入框中的草稿，再编辑排队消息');return;}
    updateDraft({...current,text:item.text,attachments:item.attachments,queue:current.queue?.filter(value=>value.id!==item.id)});textarea.current?.focus();
  }
  useEffect(()=>{
    const current=draftRef.current,head=current.queue?.[0];
    if(head && !head.paused && !current.pending && !busyRef.current && !voiceActive && transport && snapshot?.connected && !snapshot.activeTurnId && !snapshot.requests.length && session.running && !session.archived) void send(undefined,head);
  },[transport,snapshot?.activeTurnId,snapshot?.connected,snapshot?.instanceId,snapshot?.nativeSessionId,snapshot?.requests.length,session.running,session.archived,voiceActive]);

  const hasTurn = !!snapshot?.activeTurnId;
  const settingsController = useAgentChatSettings(session.id, `${snapshot?.instanceId}:${snapshot?.nativeSessionId}:${snapshot?.connected}`, hasTurn || busy || !!snapshot?.requests.length || !!draft.pending || session.archived || !transport || (session.running && !snapshot?.connected));
  function openCommand(command: ChatCommand) {
    updateDraft({ ...draftRef.current, text: '' });
    setSettingsField(command === 'model' ? 'model' : command === 'permissions' ? 'permission' : undefined);
    setSettingsOpen(true);
  }
  useEffect(() => {
    if (awaitingTurnId && (!session.running || snapshot?.activeTurnId === awaitingTurnId || snapshot?.items.some(item => item.turnId === awaitingTurnId))) setAwaitingTurnId(null);
  }, [awaitingTurnId, session.running, snapshot]);
  const activeItems = snapshot?.items.filter(item => item.turnId === snapshot.activeTurnId && item.status === 'inProgress') ?? [];
  const activityPhase = session.archived || session.status === 'error' || session.status === 'waiting_approval' || !!snapshot?.requests.length ? null
    : busy ? 'sending'
    : !transport || !snapshot?.connected || !session.running ? null
    : hasTurn ? activeItems.some(item => item.type === 'assistant' && item.text) ? 'replying' : activeItems.some(item => ['command', 'tool', 'fileChange'].includes(item.type)) ? 'working' : 'thinking'
    : awaitingTurnId && !snapshot.items.some(item => item.turnId === awaitingTurnId) ? 'waiting' : null;
  const nativeAvailable = !session.running || !!snapshot?.connected;
  const canSend = (!!draft.text.trim() || !!draft.attachments.length) && !voiceActive && !uploading && !busy && !settingsController.saving && !draft.pending && transport && nativeAvailable && !snapshot?.requests.length && !session.archived;
  const olderCurrent = older?.identity === snapshot?.nativeSessionId && older?.instanceId === snapshot?.instanceId ? older : null;
  const existingIds = new Set(snapshot?.items.flatMap(item => [item.id, ...(item.replaces ?? [])]));
  const supersededIds = new Set([...(olderCurrent?.items ?? []), ...(snapshot?.items ?? [])].flatMap(item => item.replaces ?? []));
  const visibleItems = [...(olderCurrent?.items.filter(item => !existingIds.has(item.id)) ?? []), ...(snapshot?.items ?? [])].filter(item => !supersededIds.has(item.id));
  const olderCursor = olderCurrent ? olderCurrent.cursor : snapshot?.historyCursor;
  const outlineEntries = visibleItems.filter(item => item.type === 'user');
  return <section ref={pane} className="codex-chat-pane" aria-label={`${agentName} 图形会话`} onKeyDown={event => {
    if (outlineOpen && event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); closeOutline(); }
  }}>
    <SessionToolbar className="codex-chat-toolbar"><span className="pane-connection" title="图形会话连接状态"><i className={transport && nativeAvailable ? 'online' : ''} /><span className="pane-connection-label">{!transport ? '连接中' : snapshot?.requests.length ? '需要你回复' : hasTurn ? '正在处理' : session.running ? nativeAvailable ? '已连接' : '原生未连接' : '尚未启动'}</span></span><div><button ref={outlineButton} className="icon-button" type="button" aria-label="对话目录" title="对话目录" aria-expanded={outlineOpen} aria-controls={outlineOpen ? outlineId : undefined} onClick={() => outlineOpen ? closeOutline() : setOutlineOpen(true)}><List size={15} /></button><PaneToolOverflow><button type="button" className="icon-button" aria-label="会话设置" title="会话设置" onClick={() => { setSettingsField(undefined); setSettingsOpen(true); }}><Settings2 size={14} /><span>会话设置</span></button><button className="icon-button" type="button" aria-label="刷新对话" title="刷新对话" onClick={() => void readSnapshot.current()}><RefreshCw size={14} /><span>刷新对话</span></button>{!chrome && <button type="button" className="icon-button" aria-label="原生终端" title="原生终端" onClick={onTerminal}><TerminalSquare size={14} /><span>原生终端</span></button>}</PaneToolOverflow></div></SessionToolbar>
    {!!snapshot?.requests.length && <div className="codex-request-alert" role="alert"><CircleAlert size={15} /><span>{snapshot.requests.length === 1 ? snapshot.requests[0].title : `${snapshot.requests.length} 项请求需要处理`}</span><button type="button" className="text-button" onClick={() => jumpToRequest(snapshot.requests[0].id)}>定位到请求</button></div>}
    {!transport && !loading && <div className="codex-chat-banner" role="status">与本地服务的连接已中断，正在重连。草稿已保留。</div>}
    {error && <div className="codex-chat-error" role="alert"><span>{error}</span><button type="button" className="text-button" onClick={() => { setError(''); void readSnapshot.current(); }}>重新读取</button></div>}
    {session.running && snapshot && !snapshot.connected && <div className="codex-chat-banner codex-native-retry" role="status"><span>{session.backend === 'claude' && session.executionTransport !== 'structured' ? '当前由原生终端运行；本轮结束后可切换到流式图形对话。' : '历史记录可查看，原生输入连接尚未就绪。'}</span><button type="button" className="text-button" disabled={reconnecting || !transport} onClick={() => void reconnectNative()}>{reconnecting ? '正在重新连接…' : session.backend === 'claude' && session.executionTransport !== 'structured' ? '切换到流式对话' : '重新连接原生会话'}</button></div>}
    <NoticeToasts scope={'codex.' + session.id + '.' + (snapshot?.nativeSessionId ?? session.nativeSessionId ?? '')} notices={[
      ...(snapshot?.notice ? [{ id: 'native:' + snapshot.notice, text: snapshot.notice }] : []),
      ...(snapshot?.truncated && !snapshot.notice ? [{ id: 'history-window', text: olderCursor ? '先展示最近的消息，可加载更早消息继续查看。' : '超长历史或工具输出可能已省略，完整记录保留在原生会话中。' }] : []),
      ...(olderCurrent?.notice ? [{ id: 'history:' + olderCurrent.notice, text: olderCurrent.notice }] : []),
    ]} />
    <div className="codex-chat-body"><div className="codex-chat-primary">
    <div className="chat-scroll codex-chat-scroll" ref={scroller} tabIndex={0} aria-label={`${agentName} 消息记录`} onScroll={event => {
      const element = event.currentTarget, bottom = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
      followsBottom.current = bottom; setAtBottom(bottom);
    }}>
      {!!olderCursor && <button type="button" className="codex-older" disabled={olderCurrent?.loading || olderCurrent?.limited} onClick={() => void loadOlder()}>{olderCurrent?.loading ? <LoaderCircle size={13} className="spin" /> : <ArrowDownToLine size={13} className="codex-older-arrow" />}{olderCurrent?.loading ? '正在读取旧消息…' : '加载更早消息'}</button>}
      {olderCurrent?.error && <p className="codex-chat-notice" role="alert">{olderCurrent.error}</p>}
      {loading && !snapshot ? <div className="codex-chat-empty" role="status"><LoaderCircle className="spin" size={25} /><p>正在读取对话…</p></div> : !visibleItems.length ? <div className="codex-chat-empty"><MessageSquare size={30} /><h3>在这里继续你的工作</h3><p>发送消息后，{agentName} 会在当前工作目录中处理任务。操作审批和需要补充的问题会显示在对话里。</p></div> : <div className="chat-messages codex-chat-items">{visibleItems.map(item => <MessageItem agentName={agentName} key={item.id} item={item} highlighted={item.id === highlightedInput} />)}</div>}
      {!!snapshot?.requests.length && <div className="codex-chat-requests">{snapshot.requests.map(request => <div key={request.id} data-chat-request={request.id}><NativeRequest agentName={agentName} request={request} disabled={!transport || !snapshot.connected} answer={async (id, answer) => { await api(`/sessions/${session.id}/chat/requests/${encodeURIComponent(id)}`, answer); await readSnapshot.current(); }} /></div>)}</div>}
    </div>
    {!atBottom && <button type="button" className="codex-latest" onClick={() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; followsBottom.current = true; setAtBottom(true); }}><ArrowDownToLine size={13} />回到最新消息</button>}
    </div>
    <ConversationOutline id={outlineId} open={outlineOpen} compact={compactOutline} entries={outlineEntries} selectedId={selectedInput} truncated={snapshot?.truncated ?? false} close={closeOutline} select={jumpToInput} loadOlder={olderCursor && !olderCurrent?.limited ? () => void loadOlder() : undefined} loadingOlder={olderCurrent?.loading} />
    </div>
    {draft.pending && !busy && <div className="codex-pending" role="status"><strong>发送结果待确认</strong><p>{checkNotice || '这条消息可能已被原生会话接收。查询结果前不会重复发送。'}</p><div><button type="button" className="button secondary small-button" disabled={checking} onClick={() => void checkSubmission()}>{checking ? '正在查询…' : '查询发送结果'}</button>{checkedUnknown && <><button type="button" className="text-button" onClick={() => { if (draftRef.current.pending) accepted(draftRef.current.pending); setError(''); }}>已核对收到，完成发送</button><button type="button" className="text-button" onClick={() => { updateDraft({ ...draftRef.current, pending: null }); setCheckedUnknown(false); setCheckNotice(''); setError(''); }}>已核对未发送，恢复草稿</button></>}</div></div>}
    <ChatActivity phase={activityPhase} />
    <MessageQueue items={draft.queue||[]} locked={busy || uploading || !!draft.pending} disabled={busy || uploading || !!draft.pending || !transport || !nativeAvailable || !!snapshot?.requests.length || session.archived} sendingId={draft.pending?.queueId} send={item=>void send(undefined,item)} edit={editQueue} remove={id=>updateDraft({...draftRef.current,queue:draftRef.current.queue?.filter(item=>item.id!==id)})}/>
    {settingsOpen && <AgentChatSettingsPanel controller={settingsController} field={settingsField} close={() => { setSettingsOpen(false); textarea.current?.focus({ preventScroll: true }); }} />}
    <ResizableComposer><form className="chat-composer codex-composer agent-chat-composer" onSubmit={event => void send(event)}>
      <ImageAttachments sessionId={session.id} items={draft.attachments} onChange={update => { const current = active.current ? draftRef.current : readDraft(session.id); updateDraft({ ...current, attachments: update(current.attachments) }); }} onBusy={setUploading} disabled={session.archived || !!draft.pending}>
      {preview && <div className="composer-preview" aria-label="消息 Markdown 预览"><Markdown text={draft.text || '还没有文字内容'} /></div>}
      <AgentChatCommands text={draft.text} anchor={textarea} enabled={!settingsOpen && !draft.attachments.length && !session.archived && !draft.pending} select={openCommand} />
      <textarea ref={textarea} aria-label={`给 ${agentName} 发送消息`} placeholder={session.archived ? '恢复联系人后继续对话' : hasTurn ? session.backend === 'claude' ? '补充下一条任务，本轮结束后自动发送…' : '补充或纠正当前任务，发送后交给原生会话处理…' : '描述任务，或继续补充你的想法…'} value={draft.text} maxLength={30000} disabled={session.archived} rows={3} onChange={event => updateDraft({ ...draftRef.current, text: event.target.value })} onKeyDown={event => {
        if (event.key === 'Enter' && event.shiftKey && (event.ctrlKey || event.metaKey)) return;
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); if (canSend) void send(); }
      }} />
      </ImageAttachments>
      <AgentChatQuickSettings key={settingsOpen ? 'modal' : 'inline'} controller={settingsController} blockedReason={session.archived ? '恢复联系人后可修改设置。' : !transport || !nativeAvailable ? '连接原生会话后可修改设置。' : undefined} />
      <div className="chat-composer-footer codex-composer-footer"><span>{busy ? '正在发送…' : draft.pending ? '请先核对上一条消息的发送结果' : !transport ? '正在连接本地服务，草稿已保留' : !nativeAvailable ? '请使用上方的重新连接按钮恢复输入' : hasTurn ? session.backend === 'claude' ? '生成中发送会加入队列 · 本轮结束后继续' : '生成中发送会补充当前任务 · 不停止生成' : 'Enter 发送 · Shift + Enter 换行'}</span><div><VoiceInput sessionId={session.id} disabled={session.archived || busy || !!draft.pending} onActive={setVoiceActive} insert={text => { const next = { ...draftRef.current, text: appendVoiceText(draftRef.current.text, text) }; if (!saveDraft(session.id, next)) throw new Error("草稿保存失败，识别文字保留在下方"); updateDraft(next); }} /><button type="button" className="text-button" aria-pressed={preview} onClick={() => setPreview(value => !value)}>Markdown 预览</button>{hasTurn && <button type="button" className="button secondary small-button" disabled={!transport || interrupting} onClick={async () => {
        updateDraft({...draftRef.current,queue:draftRef.current.queue?.map(item=>({...item,paused:true}))});
        setInterrupting(true); setError('');
        try { await api(`/sessions/${session.id}/chat/interrupt`, {}); await readSnapshot.current(); }
        catch (cause) { if (active.current) setError(errorText(cause)); }
        finally { if (active.current) setInterrupting(false); }
      }}><Square size={12} />{interrupting ? '正在停止…' : '停止生成'}</button>}{hasTurn && <button type="button" className="text-button" disabled={!canSend} onClick={enqueue}>加入队列</button>}<button type="submit" className="button primary small-button" disabled={!canSend}>{busy ? <LoaderCircle size={14} className="spin" /> : <Send size={14} />}发送</button></div></div>
    </form></ResizableComposer>
  </section>;
}
