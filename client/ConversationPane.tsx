import { transcriptViews } from './chat-view-cache';
import { PaneToolOverflow, SessionToolbar, useSessionChrome } from './SessionToolbar';
import './chat-presentation.css';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDownToLine, List, MessageSquare, RefreshCw, TerminalSquare } from 'lucide-react';
import type { ConversationTranscript, Session } from '../shared/types';
import { api } from './api';
import Markdown from './Markdown';
import { interfaceScale } from './zoom';
import { dismissKeyboard } from './useCompactLayout';
import NativeInputComposer from './NativeInputComposer';
import ChatActivity from './ChatActivity';
import NoticeToasts from './NoticeToasts';
import ConversationOutline from './ConversationOutline';
import './conversation.css';

type Snapshot = { identity: string; transcript: ConversationTranscript; syncedAt: Date };
type ScrollAnchor = { id: string; offset: number };

const backendName = { claude: 'Claude Code', codex: 'Codex', dsh: 'DeepSeek Harness' };

function messageTime(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Native history remains authoritative; graphical input reuses the running Agent. */
export default function ConversationPane({ session, onTerminal, onSelection, allowInput = false }: {
  allowInput?: boolean; session: Session; onTerminal: () => void; onSelection?: (text: string) => void;
}) {
  const chrome = useSessionChrome();
  const identity = `${session.id}:${session.nativeSessionId ?? ''}:${session.forkPending}`;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(() => { const transcript = transcriptViews.get(session); return transcript ? { identity, transcript, syncedAt: new Date() } : null; });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [atBottom, setAtBottom] = useState(true);
  const pane = useRef<HTMLElement>(null);
  const outlineButton = useRef<HTMLButtonElement>(null);
  const outlineId = useId();
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [compactOutline, setCompactOutline] = useState(false);
  const [selectedInput, setSelectedInput] = useState<string | null>(null);
  const [highlightedInput, setHighlightedInput] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const anchor = useRef<ScrollAnchor | null>(null);
  const refresh = useRef<(manual?: boolean) => void>(() => {});
  const running = useRef(session.running);
  const selectionCallback = useRef(onSelection);
  running.current = session.running;
  selectionCallback.current = onSelection;
  const current = snapshot?.identity === identity ? snapshot : null;
  const activityKey = JSON.stringify([session.running, session.status, session.statusSource, session.lastActivity, session.lastAttentionKey]);
  const [submissionActivity, setSubmissionActivity] = useState<{ identity: string; key: string; phase: 'sending' | 'accepted' } | null>(null);
  const localActivity = submissionActivity?.identity === identity ? submissionActivity : null;
  // A native transition takes over the optimistic bridge. In particular, an
  // approval, completion or stop that arrives before the send response wins.
  useEffect(() => {
    if (submissionActivity && (submissionActivity.identity !== identity || submissionActivity.key !== activityKey) && submissionActivity.phase !== 'sending') setSubmissionActivity(null);
  }, [identity, activityKey, submissionActivity]);
  const activityPhase = session.archived || !session.running || session.status === 'error' || session.status === 'stopped' || session.status === 'waiting_approval' ? null
    : localActivity?.phase === 'sending' ? 'sending'
    : session.status === 'running' ? 'working'
    : localActivity?.key === activityKey ? 'waiting' : null;
  useLayoutEffect(() => {
    const element = pane.current; if (!element) return;
    const measure = () => setCompactOutline(element.clientWidth <= 720);
    measure(); const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!highlightedInput) return;
    const timer = setTimeout(() => setHighlightedInput(null), 1800);
    return () => clearTimeout(timer);
  }, [highlightedInput]);
  function closeOutline() { setOutlineOpen(false); outlineButton.current?.focus({ preventScroll: true }); }
  function jumpToInput(id: string) {
    const element = scroller.current;
    const target = [...(element?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])].find(item => item.dataset.messageId === id);
    if (!element || !target) return;
    followBottom.current = false; anchor.current = null;
    element.scrollTop += (target.getBoundingClientRect().top - element.getBoundingClientRect().top) / interfaceScale() - 12;
    target.focus({ preventScroll: true });
    setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 64);
    setSelectedInput(id); setHighlightedInput(id);
  }

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let pendingRefresh = false;
    let pendingManual = false;
    let previous: ConversationTranscript | undefined;
    const cached = transcriptViews.get(session);
    setSnapshot(cached ? { identity, transcript: cached, syncedAt: new Date() } : null);
    setLoading(true); setRefreshing(false); setError(''); setAtBottom(true);
    followBottom.current = true; anchor.current = null;
    selectionCallback.current?.('');

    function captureAnchor() {
      const element = scroller.current;
      if (!element || followBottom.current) return;
      const top = element.getBoundingClientRect().top;
      const first = Array.from(element.querySelectorAll<HTMLElement>('[data-message-id]'))
        .find((message) => message.getBoundingClientRect().bottom > top);
      anchor.current = first ? { id: first.dataset.messageId!, offset: first.getBoundingClientRect().top - top } : null;
    }

    async function load(manual = false) {
      if (disposed) return;
      if (inFlight) { pendingRefresh = true; pendingManual ||= manual; return; }
      inFlight = true;
      if (manual) setRefreshing(true);
      try {
        const transcript = await api<ConversationTranscript>(`/sessions/${encodeURIComponent(session.id)}/conversation`);
        if (disposed) return;
        // Polling an unchanged transcript must not replace selected message text.
        if (!previous || JSON.stringify(previous) !== JSON.stringify(transcript)) {
          captureAnchor();
          previous = transcript;
          transcriptViews.put(session, transcript);
          setSnapshot({ identity, transcript, syncedAt: new Date() });
        }
        setError('');
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : '暂时无法读取对话记录');
      } finally {
        inFlight = false;
        if (!disposed) {
          setLoading(false); setRefreshing(false);
          if (pendingRefresh) { const manual = pendingManual; pendingRefresh = false; pendingManual = false; void load(manual); }
        }
      }
    }
    refresh.current = (manual) => { void load(manual); };
    void load();
    const timer = setInterval(() => {
      if (running.current && document.visibilityState !== 'hidden') void load();
    }, 3000);
    const onVisible = () => { if (document.visibilityState !== 'hidden') void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      disposed = true; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible);
      refresh.current = () => {}; selectionCallback.current?.('');
    };
  }, [identity, session.id]);

  useEffect(() => { refresh.current(); }, [session.lastActivity, session.running, session.status, session.lastUserInputAt]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || !current) return;
    if (followBottom.current) element.scrollTop = element.scrollHeight;
    else if (anchor.current) {
      const { id, offset } = anchor.current;
      const target = Array.from(element.querySelectorAll<HTMLElement>('[data-message-id]')).find(message => message.dataset.messageId === id);
      if (target) element.scrollTop += (target.getBoundingClientRect().top - element.getBoundingClientRect().top - offset) / interfaceScale();
    }
    anchor.current = null;
  }, [current]);

  useEffect(() => {
    const onSelect = () => {
      const selection = window.getSelection();
      const element = scroller.current;
      if (!selection || !element) return;
      const anchorElement = selection.anchorNode?.parentElement?.closest('.conversation-text');
      const focusElement = selection.focusNode?.parentElement?.closest('.conversation-text');
      selectionCallback.current?.(anchorElement && focusElement && element.contains(anchorElement) && element.contains(focusElement)
        ? selection.toString().trim() : '');
    };
    document.addEventListener('selectionchange', onSelect);
    const element = scroller.current;
    const observer = new ResizeObserver(() => { if (followBottom.current && element) element.scrollTop = element.scrollHeight; });
    if (element) observer.observe(element);
    return () => { document.removeEventListener('selectionchange', onSelect); observer.disconnect(); };
  }, []);

  const transcript = current?.transcript;
  const empty = !transcript?.messages.length;
  const isLoading = loading && !current;
  const hasNativeQuestion = transcript?.messages.some(message => message.role === 'assistant' && message.text.includes('**需要你回答的问题**')) ?? false;
  const nativeQuestionPending = ['claude', 'dsh'].includes(session.backend)
    && session.status === 'waiting_input'
    && hasNativeQuestion;
  const scrollToBottom = () => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
    followBottom.current = true; setAtBottom(true);
  };

  return <section ref={pane} className="conversation-pane" aria-label="原生对话记录" onKeyDown={event => {
    if (outlineOpen && event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); closeOutline(); }
  }}>
    <SessionToolbar className="conversation-toolbar">
      <span className="conversation-source pane-connection" title={current ? `最近同步：${current.syncedAt.toLocaleTimeString('zh-CN')} · ${transcript?.messages.length ?? 0} 条消息` : '正在读取原生记录'}><i className={!isLoading && !error ? 'online' : ''} /><span className="pane-connection-label">{isLoading || refreshing ? '同步中' : error ? '同步失败' : '已同步'}</span></span>
      <span className="conversation-actions">
        <button ref={outlineButton} className="icon-button" type="button" aria-label="对话目录" title="对话目录" aria-expanded={outlineOpen} aria-controls={outlineOpen ? outlineId : undefined} onClick={() => outlineOpen ? closeOutline() : setOutlineOpen(true)}><List size={15} /></button>
        <PaneToolOverflow><button className="icon-button" aria-label="刷新记录" title="刷新记录" disabled={isLoading || refreshing} onClick={() => refresh.current(true)}><RefreshCw size={14} className={isLoading || refreshing ? 'spin' : undefined} /><span>刷新记录</span></button>{!chrome && <button className="icon-button" aria-label="进入原生终端" title="进入原生终端" onClick={onTerminal}><TerminalSquare size={14} /><span>进入原生终端</span></button>}</PaneToolOverflow>
      </span>
    </SessionToolbar>
    <NoticeToasts scope={'conversation.' + identity} notices={transcript?.notice ? [{ id: 'native:' + transcript.notice, text: transcript.notice }] : transcript?.truncated ? [{ id: 'history-window', text: '最近部分，完整上下文请在原生终端中查看' }] : []} />
    {error && <div className="conversation-error" role="alert"><span>{error}</span><button className="text-button" disabled={refreshing} onClick={() => refresh.current(true)}>重试读取</button></div>}
    {nativeQuestionPending && <div className="conversation-question-notice" role="status"><span>{session.backend === 'claude' ? 'Claude 正在等待原生终端中的输入。' : 'DeepSeek Harness 正在等待原生界面中的问题回答。'}</span><button className="text-button" onClick={onTerminal}>{session.backend === 'dsh' ? '前往原生界面处理' : '前往原生终端处理'}</button></div>}
    {allowInput && session.running && session.status === 'waiting_approval' && <div className="conversation-error" role="status"><span>原生会话正在等待审批</span><button className="text-button" onClick={onTerminal}>前往原生终端处理</button></div>}
    <div className="conversation-body"><div className="conversation-primary"><div className="chat-scroll conversation-scroller" ref={scroller} onTouchMove={dismissKeyboard} tabIndex={0} aria-label="会话消息" onScroll={(event) => {
      const element = event.currentTarget;
      const next = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
      followBottom.current = next; setAtBottom(next);
    }}>
      {isLoading ? <div className="conversation-empty" role="status"><RefreshCw size={24} className="spin" /><h3>正在读取原生记录</h3></div>
        : empty ? <div className="conversation-empty"><MessageSquare size={28} /><h3>{error ? '暂时无法显示对话' : '还没有可显示的对话'}</h3>
          <p>{session.forkPending ? '启动 Fork 后，这里将显示新会话的记录。' : !session.nativeSessionId ? '启动原生会话并发送第一条消息后，记录会显示在这里。' : '原生记录保存后会出现在这里；可刷新记录或进入终端继续。'}</p>
          <button className="button secondary" onClick={onTerminal}><TerminalSquare size={14} />进入原生终端</button></div>
          : <ol className="chat-messages conversation-messages">{transcript!.messages.map(message => <li key={message.id} data-message-id={message.id} tabIndex={message.role === 'user' ? -1 : undefined} className={`chat-message chat-${message.role} conversation-message from-${message.role}${message.id === highlightedInput ? ' conversation-message-highlighted' : ''}`}>
            <div className="chat-message-heading conversation-message-meta"><strong>{message.role === 'user' ? '你' : backendName[session.backend]}</strong>{messageTime(message.createdAt) && <time dateTime={message.createdAt}>{messageTime(message.createdAt)}</time>}</div>
            <div className="chat-message-body conversation-text">{message.role === 'assistant' ? <Markdown text={message.text} /> : message.text}</div>
          </li>)}</ol>}
    </div>
    {!atBottom && !empty && <button type="button" className="chat-latest" onClick={scrollToBottom}><ArrowDownToLine size={13} />回到最新消息</button>}
    </div>
    <ConversationOutline id={outlineId} open={outlineOpen} compact={compactOutline} entries={transcript?.messages.filter(message => message.role === 'user') ?? []} selectedId={selectedInput} truncated={transcript?.truncated ?? false} close={closeOutline} select={jumpToInput} />
    </div>
    <ChatActivity phase={activityPhase} />
    {allowInput && session.backend !== 'codex' && <NativeInputComposer key={session.id} session={session} onTerminal={onTerminal} onActivityChange={phase => setSubmissionActivity(previous => phase === 'sending' ? { identity, key: activityKey, phase } : phase === 'accepted' && previous?.identity === identity ? { ...previous, phase } : null)} onSent={() => { followBottom.current = true; refresh.current(); }} />}
  </section>;
}
