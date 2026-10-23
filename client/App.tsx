import { AUTO_MODE_NOTE, type ExecutionMode } from '../shared/execution';
import { appUrl } from './urls';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import {
  ArrowDownToLine, ArrowLeft, ArrowRight, ArrowRightLeft, Archive, Bell, BellOff, Check, CheckCheck,
  CircleHelp, Clock3, Command, Copy, Ellipsis, ExternalLink, Folder,
  GitFork, Globe2, LoaderCircle, MessageSquare, Pencil, Pin, PinOff, Play, Plus,
  Radio, Search, Send, Settings2, Share2, SlidersHorizontal, Square, UsersRound, X,
  PanelBottomOpen, Volume2, VolumeX, TerminalSquare, Link2, PanelLeftOpen, PanelLeftClose,
  FilePenLine, Palette, Maximize2, Minimize2, PanelRightOpen,
} from 'lucide-react';
import type { AppState, StatePatch, Backend, DiscoveredSession, Delivery, Group, GroupDetail, GroupMessage, Session, SessionStatus } from '../shared/types';
import { applyStatePatch } from './state';
import { api, ApiError, getToken } from './api';
import { useGroupHistory } from './group-history';
import TerminalPane from './TerminalPane';
import ConversationPane from './ConversationPane';
import DirectoryField from './DirectoryField';
import { copyToClipboard } from './clipboard';
import { useWorkspaceRoute, workspaceHash, type View } from './navigation';
import ActivityView from './ActivityView';
import { Splitter } from './WorkspaceExplorer';
import PreviewWorkspace from './PreviewWorkspace';
import { usePreviewWorkspace } from './usePreviewWorkspace';
import ShellTerminalDock from './ShellTerminalDock';
import VoiceSettings from './VoiceSettings';
import { AgentSetupControls, StartupSettings } from './SetupSettings';
import type { AgentSetupInfo } from '../shared/setup';
import AppearanceDialog from './AppearanceDialog';
import InterfaceZoom from './InterfaceZoom';
import BackendLogo from './BackendLogo';
import { SessionChrome, SessionToolbarHost } from './SessionToolbar';
import { useContactFilters, useContactSort, type ContactSort } from './preferences';
import { readLocalPreference, writeLocalPreference, useDialog } from './ui';
import ModalShell from './Modal';
import { SecuritySettings, ShareDialog } from './Sharing';
import type { AuthStatus } from '../shared/auth';

const AgentChatPane = lazy(() => import('./AgentChatPane'));

export const BACKEND: Record<Backend, { name: string; short: string; color: string }> = {
  claude: { name: 'Claude Code', short: 'Claude', color: 'coral' },
  codex: { name: 'Codex', short: 'Codex', color: 'green' },
  dsh: { name: 'DeepSeek Harness', short: 'DeepSeek', color: 'blue' },
};
export const STATUS: Record<SessionStatus, { label: string; className: string }> = {
  idle: { label: '空闲', className: 'idle' }, running: { label: '运行中', className: 'running' },
  waiting_input: { label: '等待输入', className: 'waiting' }, waiting_approval: { label: '等待审批', className: 'waiting' },
  error: { label: '异常', className: 'error' }, stopped: { label: '已停止', className: 'idle' }, unknown: { label: '状态未知', className: 'unknown' },
};
type Modal = { type: 'create'; groupId?: string; backend?: Backend } | { type: 'import' } | { type: 'rename'; session: Session }
  | { type: 'fork'; session: Session; groupId?: string } | { type: 'handoff'; session: Session } | { type: 'group'; group?: Group }
  | { type: 'replaceDraft'; draft: string; sourceName: string; proceed: () => void } | { type: 'help' } | { type: 'appearance' } | { type: 'shareLink'; session: Session } | { type: 'addMember'; groupId: string } | { type: 'share'; session: Session; text: string } | null;
type GroupDraft = { text: string; kind: GroupMessage['kind']; recipients: string[]; sourceMessageId: string | null };
function readGroupDraft(groupId: string): GroupDraft {
  try {
    const draft = JSON.parse(sessionStorage.getItem(`sessiondeck.group-draft.${groupId}`) ?? 'null');
    if (draft && typeof draft.text === 'string' && ['note', 'task', 'result'].includes(draft.kind) && Array.isArray(draft.recipients)) return { text: draft.text.slice(0, 30000), kind: draft.kind, recipients: draft.recipients.filter((id: unknown) => typeof id === 'string'), sourceMessageId: typeof draft.sourceMessageId === 'string' ? draft.sourceMessageId : null };
  } catch { /* Unavailable or stale browser storage must not block the workspace. */ }
  return { text: '', kind: 'note', recipients: [], sourceMessageId: null };
}
/** The agent is blocked on a person: waiting for input or approval, or failed. */
const attention = (s: Session) => s.status === 'waiting_input' || s.status === 'waiting_approval' || s.status === 'error';
/** Red badge: blocked on a person AND not looked at since. Opening the session clears it. */
const pending = (s: Session) => attention(s) && s.unread > 0;
const relativeTime = (value: string) => {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (!Number.isFinite(minutes)) return '—';
  if (minutes < 1) return '刚刚'; if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  return `${Math.floor(minutes / 1440)} 天前`;
};
const shortPath = (path: string) => path.replace(/\/$/, '').split('/').filter(Boolean).slice(-2).join('/') || path;

/** Four independent sessions gather around a shared task; colors follow the theme. */
export function BrandMark({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true"><g transform="rotate(-8 50 50)"><path d="M14 14H44V29L29 44H14Z" fill="var(--accent)" /><path d="M56 14H86V44H71L56 29Z" fill="var(--text)" /><path d="M86 56V86H56V71L71 56Z" fill="var(--accent)" /><path d="M44 86H14V56H29L44 71Z" fill="var(--muted)" /></g></svg>;
}
export function BackendAvatar({ backend, small = false }: { backend: Backend; small?: boolean }) {
  return <span className={`backend-avatar ${BACKEND[backend].color} ${small ? 'small' : ''}`} aria-label={BACKEND[backend].name}><BackendLogo backend={backend} /></span>;
}
export function StatusBadge({ session }: { session: Session }) {
  return <span className={`status-badge ${STATUS[session.status].className}`} title={`${session.statusDetail || STATUS[session.status].label} · ${session.statusSource === 'native' ? '来自后端' : session.statusSource === 'terminal' ? '根据终端输出推测' : session.statusSource === 'manual' ? '手动设置' : '进程状态'}`}><i />{STATUS[session.status].label}{session.statusSource === 'terminal' && <span className="estimated">估测</span>}</span>;
}
function HelpDialog({ close }: { close: () => void }) {
  return <ModalShell title="使用说明与快捷键" subtitle="在卡片上看状态，进入原生会话继续工作。" close={close}>
    <div className="help-content">
      <h3>常用操作</h3>
      <dl className="shortcut-list"><div><dt>定位当前页面搜索</dt><dd><kbd>Ctrl / ⌘</kbd> + <kbd>K</kbd></dd></div><div><dt>打开这份说明</dt><dd><kbd>?</kbd></dd></div><div><dt>关闭当前面板</dt><dd><kbd>Esc</kbd></dd></div><div><dt>发布群组消息</dt><dd><kbd>Ctrl / ⌘</kbd> + <kbd>Enter</kbd></dd></div></dl>
      <p>搜索和帮助快捷键只在非输入区域生效。终端内的快捷键和 Esc 交给原生 Agent；群组输入框内可用发布快捷键。</p>
      <h3>如何理解状态</h3>
      <ul className="status-guide"><li><span className="status-badge running">运行中</span><span>后端正在执行任务。</span></li><li><span className="status-badge waiting">等待输入 / 审批</span><span>需要你进入会话回复或决定。</span></li><li><span className="status-badge idle">空闲 / 已停止</span><span>当前没有执行任务；不代表工作已验收。</span></li><li><span className="status-badge unknown">状态未知</span><span>目前没有足够信息确认状态，进入原生会话查看。</span></li></ul>
      <p>标有“估测”的状态来自终端输出。卡片上的提醒、来源说明和原生会话可帮助你判断；断线时保留最后收到的状态。</p>
      <h3>保留你的工作方式</h3><p>置顶联系人始终在最前；然后依次是有红点提醒、正在执行任务、无红点等待输入的会话，其余在后。同层默认按上次输入时间，也可改为创建时间或名称；没有输入时间时排在该层有输入记录的联系人之后。有新提醒的联系人显示红点，打开会话后消失。桌面左侧列表切换联系人，右侧继续会话；手机进入单会话后可返回列表。每个页面独立保存搜索和筛选，刷新后继续使用；Fork 继承上下文，原联系人保留。</p>
      <h3>统一预览面板</h3><p>文件浏览、文件／Git diff 预览、随手记和网页服务都在右侧预览面板显示。顶部标签可切换或关闭，＋菜单可打开新网页；隐藏面板保留所有标签。文件固定属于打开时的工作目录，切换联系人不会改变来源；随手记继续自动保存同一份笔记。</p><h3>网页服务预览</h3><p>顶栏地球图标可打开本机或局域网服务（如 <code>http://10.11.1.111:5173/</code>）。也可输入 <code>:5173</code>。地址须能从当前浏览器访问；公网主机端口转发尚未接入，localhost 指向当前浏览器所在设备。站点禁止嵌入时可用「新标签打开」。</p>
    </div><div className="modal-footer"><button className="button primary" onClick={close}>知道了</button></div>
  </ModalShell>;
}

export default function App({ auth = { kind: 'owner', remote: false, passwordSet: false } }: { auth?: Extract<AuthStatus, { kind: 'owner' }> }) {
  const [state, setState] = useState<AppState | null>(null);
  const { view, selectedId, updateRoute } = useWorkspaceRoute();
  const setSelectedId = useCallback((id: string | null) => updateRoute({ selectedId: id }), [updateRoute]);
  const { query, backendFilter, statusFilter, setQuery, setBackendFilter, setStatusFilter, clearFilters } = useContactFilters(view);
  const [contactSort, setContactSort] = useContactSort();
  const [contactsScrolling, setContactsScrolling] = useState(false);
  const contactsScrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const revealContactScrollbar = () => {
    setContactsScrolling(true);
    clearTimeout(contactsScrollTimer.current);
    contactsScrollTimer.current = setTimeout(() => setContactsScrolling(false), 1000);
  };
  useEffect(() => () => clearTimeout(contactsScrollTimer.current), []);
  const [modal, setModal] = useState<Modal>(null);
  const [selection, setSelection] = useState('');
  const [workspaceSessionId, setWorkspaceSessionId] = useState<string | null>(null);
  const preview = usePreviewWorkspace();
  const activePreview = preview.tabs.find(tab => tab.id === preview.activeId);
  const workspaceOpen = preview.open && activePreview?.kind === 'explorer';
  const scratchpadOpen = preview.open && activePreview?.kind === 'note';
  const servicePreviewOpen = preview.open && activePreview?.kind === 'web';
  const toggleScratchpad = preview.openNote;
  const toggleServicePreview = () => {
    const existing = preview.tabs.find(tab => tab.kind === 'web');
    if (existing) preview.select(existing.id); else preview.openWeb();
  };
  // The rail is collapsed by default and only expands on request, never on hover.
  const [railOpen, setRailOpen] = useState(() => readLocalPreference('sessiondeck.rail') === 'open');
  const toggleRail = () => { setRailOpen(value => { writeLocalPreference('sessiondeck.rail', value ? 'closed' : 'open'); return !value; }); };
  const workspaceAreaRef = useRef<HTMLDivElement>(null);
  const [workspaceWidth, setWorkspaceWidth] = useState(window.innerWidth);
  const [contactWidth, setContactWidth] = useState(() => {
    const saved = Number(readLocalPreference('sessiondeck.layout.contacts-px'));
    return Number.isFinite(saved) && saved >= 220 ? Math.min(saved, 420) : 300;
  });
  useLayoutEffect(() => {
    const area = workspaceAreaRef.current;
    if (!area) return;
    const observer = new ResizeObserver(([entry]) => setWorkspaceWidth(entry.contentRect.width));
    observer.observe(area);
    return () => observer.disconnect();
  }, []);
  // Only an explicit open (card, activity, group link) starts the agent. Route
  // restores, reloads, history and route changes keep today's no-launch rule.
  const autoStartRef = useRef<{ id: string; mode?: 'terminal' | 'chat' } | null>(null);
  const [privateViews, setPrivateViews] = useState<Record<string, string>>(() => Object.fromEntries(
    ['claude', 'codex', 'dsh'].map(backend => {
      const saved = readLocalPreference(`sessiondeck.private-view.${backend}`);
      return [backend, saved === 'terminal' || saved === 'conversation' || saved === 'chat' ? saved : backend === 'codex' || backend === 'claude' ? 'chat' : 'terminal'];
    }),
  ));
  const [terminalPanelOpen, setTerminalPanelOpen] = useState(false);
  const [setupShellId, setSetupShellId] = useState<string>();
  const [terminalSessionId, setTerminalSessionId] = useState<string | undefined>();
  const selectPrivateView = (backend: Backend, mode: 'conversation' | 'terminal' | 'chat') => {
    setPrivateViews(current => ({ ...current, [backend]: mode }));
    writeLocalPreference(`sessiondeck.private-view.${backend}`, mode);
    setSelection('');
  };
  const [connected, setConnected] = useState(false);
  const [hasConnected, setHasConnected] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [groupReload, setGroupReload] = useState(0);
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [notifications, setNotifications] = useState(() => typeof Notification !== 'undefined' && Notification.permission === 'granted' && readLocalPreference('sessiondeck.notifications') === 'on');
  const notificationRef = useRef(notifications);
  const [soundEnabled, setSoundEnabled] = useState(() => readLocalPreference('sessiondeck.sound') !== 'off');
  const soundRef = useRef(soundEnabled);
  const lastSoundRef = useRef(-Infinity);
  const notificationAudioRef = useRef<AudioContext | null>(null);
  const sessionsRef = useRef<Session[] | null>(null);
  const stateRevisionRef = useRef(0);
  const stateRef = useRef<AppState | null>(null);
  const serverSnapshotRef = useRef<{ instanceId: string; revision: number } | null>(null);
  const seenServerInstancesRef = useRef(new Set<string>());
  const operationRef = useRef(false);
  const drawerRef = useRef<HTMLElement>(null);
  const [fullscreenSessionId, setFullscreenSessionId] = useState<string | null>(null);
  useEffect(() => { setFullscreenSessionId(null); }, [selectedId]);
  const sessionInvokersRef = useRef(new Map<string, HTMLElement>());
  const focusedSessionIdRef = useRef<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const groupId = view.startsWith('group:') ? view.slice(6) : null;
  const selected = state?.sessions.find((session) => session.id === selectedId) ?? null;
  const currentGroup = state?.groups.find((group) => group.id === groupId);
  const { detail, error: groupError, loadOlder, loadingOlder, readSource } = useGroupHistory(groupId, currentGroup?.updatedAt, groupReload, state?.instanceId);
  const selectedGroup = state?.groups.find((group) => group.id === selected?.groupId);
  const selectedParent = state?.sessions.find((session) => session.id === selected?.parentId);
  // The desktop session is an in-flow workbench rather than a modal dialog.
  // Keep Escape as a lightweight close affordance without trapping focus or
  // locking the document scroll used by the terminal and preview panes.
  useDialog(drawerRef, false, () => setSelectedId(null), true);
  useLayoutEffect(() => {
    const previousId = focusedSessionIdRef.current;
    const currentId = selected?.id ?? null;
    if (previousId === currentId) return;
    focusedSessionIdRef.current = currentId;
    if (selected) {
      if (!drawerRef.current?.contains(document.activeElement)) {
        drawerRef.current?.querySelector<HTMLButtonElement>('[aria-label="关闭会话"]')?.focus({ preventScroll: true });
      }
      return;
    }
    if (!previousId) return;
    const invoker = sessionInvokersRef.current.get(previousId);
    sessionInvokersRef.current.clear();
    // Navigation or a click elsewhere in the nonmodal workbench keeps its own
    // focus. Only replace the focus lost when the session pane was removed.
    if (document.activeElement === document.body && invoker?.isConnected && !invoker.closest('[inert]') && invoker.getClientRects().length) {
      invoker.focus({ preventScroll: true });
    }
  }, [selected?.id]);
  useEffect(() => {
    if (!selected) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== 'Escape' || (event.target instanceof HTMLElement && event.target.closest('.terminal-pane'))) return;
      if (modal) return;
      event.preventDefault();
      setSelectedId(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [selected, modal, setSelectedId]);
  notificationRef.current = notifications;
  soundRef.current = soundEnabled;

  const openTerminalPanel = useCallback((sessionId?: string) => {
    setSetupShellId(undefined);
    if (sessionId) setTerminalSessionId(sessionId);
    setTerminalPanelOpen(true);
  }, []);

  const notificationSound = useCallback((unlock = false) => {
    if (typeof window === 'undefined') return;
    const AudioContextCtor = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;
    try {
      const context = notificationAudioRef.current ?? new AudioContextCtor();
      notificationAudioRef.current = context;
      if (context.state === 'suspended') void context.resume().catch(() => {});
      if (unlock || context.state !== 'running') return;
      if (performance.now() - lastSoundRef.current < 800) return;
      lastSoundRef.current = performance.now();
      const now = context.currentTime;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(880, now);
      oscillator.frequency.exponentialRampToValueAtTime(660, now + 0.12);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.075, now + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
      oscillator.connect(gain); gain.connect(context.destination);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
      oscillator.start(now); oscillator.stop(now + 0.18);
    } catch {
      // Audio is an optional enhancement. Browser policy or missing audio
      // devices must never prevent state updates and system notifications.
    }
  }, []);

  useEffect(() => {
    if (!soundEnabled) return;
    const unlock = () => notificationSound(true);
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => { window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
  }, [soundEnabled, notificationSound]);
  useEffect(() => () => { void notificationAudioRef.current?.close().catch(() => {}); notificationAudioRef.current = null; }, []);

  const notify = useCallback((message: string) => { setToast(message); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 4200); }, []);
  const acceptState = useCallback((next: AppState) => {
    if (typeof next.instanceId === 'string' && typeof next.revision === 'number' && Number.isFinite(next.revision)) {
      const previous = serverSnapshotRef.current;
      const seen = seenServerInstancesRef.current;
      if (previous?.instanceId === next.instanceId && next.revision < previous.revision) return;
      // A restarted service begins a fresh sequence. Once we adopt that
      // instance, delayed HTTP responses from an earlier service stay ignored.
      if (previous?.instanceId !== next.instanceId && seen.has(next.instanceId)) return;
      seen.add(next.instanceId);
      if (seen.size > 8) seen.delete(seen.values().next().value!);
      serverSnapshotRef.current = { instanceId: next.instanceId, revision: next.revision };
    }
    stateRevisionRef.current += 1;
    setConnectionError('');
    if (sessionsRef.current) {
      for (const session of next.sessions) {
        const previous = sessionsRef.current.find((old) => old.id === session.id);
        if (previous && !session.archived && attention(session) && session.unread > previous.unread) {
          if (soundRef.current) notificationSound();
          if (!notificationRef.current || typeof Notification === 'undefined' || Notification.permission !== 'granted') continue;
          try {
            const notification = new Notification(`${session.title} · ${STATUS[session.status].label}`, { body: session.statusDetail || '点击进入会话继续处理', tag: session.id, icon: '/favicon.svg?v=shared-centre' });
            notification.onclick = () => { window.focus(); setSelectedId(session.id); setSelection(''); notification.close(); };
          } catch {
            // Some mobile browsers expose Notification but reject its constructor.
            setNotifications(false); writeLocalPreference('sessiondeck.notifications', 'off');
          }
        }
      }
    }
    stateRef.current = next; sessionsRef.current = next.sessions; setState(next);
  }, [notificationSound, setSelectedId]);
  const refresh = useCallback(async () => {
    const revision = stateRevisionRef.current;
    try { const next = await api<AppState>('/state'); acceptState(next); }
    catch (cause) {
      // A newer SSE snapshot can recover the workspace before an older HTTP
      // request fails. Its late failure must not overwrite that recovery.
      if (revision === stateRevisionRef.current) setConnectionError(cause instanceof Error ? cause.message : '无法同步工作空间，请重试');
      throw cause;
    }
  }, [acceptState]);
  useEffect(() => {
    if (!state) return;
    const missingGroup = groupId && !state.groups.some((group) => group.id === groupId);
    const missingSession = selectedId && !state.sessions.some((session) => session.id === selectedId);
    if (!missingGroup && !missingSession) return;
    let live = true;
    // A link can arrive before the creation event in another tab. Verify against
    // fresh server state before treating its target as deleted.
    void api<AppState>('/state').then((next) => {
      if (!live) return;
      const absentGroup = groupId && !next.groups.some((group) => group.id === groupId);
      const absentSession = selectedId && !next.sessions.some((session) => session.id === selectedId);
      if (absentGroup || absentSession) {
        updateRoute({ view: absentGroup ? 'contacts' : view, selectedId: absentSession ? null : selectedId }, true);
        notify(absentSession ? '链接中的联系人已不存在，已返回会话列表' : '链接中的群组已不存在，已返回联系人');
      }
      acceptState(next);
    }).catch((cause) => { if (live) setConnectionError(`暂时无法打开此链接：${cause.message}`); });
    return () => { live = false; };
  }, [state, groupId, selectedId, view, updateRoute, notify, acceptState]);
  useEffect(() => {
    setModal(null); setSelection('');
  }, [view]);
  useEffect(() => { setSelection(''); setModal(null); }, [selectedId]);
  useEffect(() => { if (selectedId) setWorkspaceSessionId(selectedId); }, [selectedId]);
  // The server answers /read with the updated session. Apply it right away so
  // the badge clears even if the live stream is slow, reconnecting or stale.
  const markRead = useCallback(async (id: string) => {
    try {
      const item = await api<Session>(`/sessions/${id}/read`, {});
      const merge = (current: AppState | null) => current && current.sessions.some(session => session.id === id)
        ? { ...current, sessions: current.sessions.map(session => session.id === id ? { ...session, unread: item.unread } : session) } : current;
      stateRef.current = merge(stateRef.current); sessionsRef.current = stateRef.current?.sessions ?? null;
      setState(merge);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '无法标记已读'); }
  }, []);
  // Viewing a session reads its reminders, whether or not you type anything.
  // Re-run on every new reminder while it stays open and the tab is visible.
  useEffect(() => {
    if (!selected?.id || !selected.unread || document.visibilityState !== 'visible') return;
    const id = selected.id;
    const timer = setTimeout(() => { void markRead(id); }, 300);
    return () => clearTimeout(timer);
  }, [selected?.id, selected?.unread, markRead]);
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible' && stateRef.current && selectedId) { const item = stateRef.current.sessions.find(session => session.id === selectedId); if (item?.unread) void markRead(item.id); } };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [selectedId, markRead]);
  useEffect(() => {
    void refresh().catch(() => {});
    const stream = new EventSource(appUrl('/api/events'));
    // Pings arrive every 20 s. A stream that goes quiet for longer is stuck
    // somewhere (a buffering proxy, a half-open connection), so poll the full
    // state until it recovers rather than showing stale cards indefinitely.
    let lastEventAt = Date.now();
    const touch = () => { lastEventAt = Date.now(); };
    stream.onopen = () => { touch(); setConnected(true); setHasConnected(true); setGroupReload((value) => value + 1); void getToken(true).catch(() => {}); void refresh().catch(() => {}); };
    stream.onerror = () => setConnected(false);
    stream.addEventListener('ping', touch);
    const watchdog = setInterval(() => { if (Date.now() - lastEventAt > 45_000 && document.visibilityState === 'visible') void refresh().catch(() => {}); }, 15_000);
    stream.addEventListener('state', (event) => {
      touch();
      try { acceptState(JSON.parse((event as MessageEvent).data)); }
      catch { setConnectionError('无法读取状态更新，正在等待重新连接'); }
    });
    let resyncing = false, resyncAgain = false, live = true;
    const resync = async () => {
      if (resyncing) { resyncAgain = true; return; }
      resyncing = true;
      try {
        do { resyncAgain = false; await refresh(); } while (live && resyncAgain);
      } catch { /* refresh exposes the connection error and manual retry. */ }
      finally { resyncing = false; }
    };
    stream.addEventListener('patch', (event) => {
      touch();
      try {
        const patch = JSON.parse((event as MessageEvent).data) as StatePatch;
        const next = applyStatePatch(stateRef.current, patch);
        if (next) { if (next !== stateRef.current) acceptState(next); return; }
      } catch { /* Malformed or skipped versions require a full snapshot. */ }
      void resync();
    });
    return () => { live = false; clearInterval(watchdog); stream.close(); };
  }, [refresh, acceptState]);
  useEffect(() => {
    const resume = () => { if (document.visibilityState === 'visible') void refresh().catch(() => {}); };
    document.addEventListener('visibilitychange', resume);
    return () => document.removeEventListener('visibilitychange', resume);
  }, [refresh]);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30_000);
    return () => { clearInterval(timer); clearTimeout(toastTimer.current); };
  }, []);
  useEffect(() => {
    const count = state?.sessions.filter((session) => !session.archived && pending(session)).length ?? 0;
    document.title = `${count ? `(${count}) ` : ''}${selected?.title ?? currentGroup?.title ?? ({ contacts: '会话联系人', attention: '需要你处理', running: '正在运行', archive: '已归档', backends: '连接与能力', activity: '最近活动' } as Record<string, string>)[view] ?? '会话联系人'} · Dili`;
  }, [state, selected?.title, currentGroup?.title, view, clock]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const inNativeTerminal = event.target instanceof HTMLElement && event.target.closest('.terminal-pane');
      const editing = event.target instanceof HTMLElement && (!!event.target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])') || event.target.isContentEditable);
      if (editing || inNativeTerminal || event.isComposing || event.defaultPrevented) return;
      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key === '?' && !selectedId && !modal) { event.preventDefault(); setModal({ type: 'help' }); }
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k' && !selectedId && !modal) { event.preventDefault(); document.querySelector<HTMLInputElement>('#session-search, #activity-search')?.focus(); }
    };
    window.addEventListener('keydown', keydown); return () => window.removeEventListener('keydown', keydown);
  }, [modal, selectedId]);
  const closeModal = useCallback(() => setModal(null), []);
  const run = async (key: string, operation: () => Promise<unknown>, success?: string) => {
    if (operationRef.current) return false;
    operationRef.current = true; setBusy(key); setError('');
    try {
      await operation();
      await refresh().catch(() => {});
      if (success) notify(success); return true;
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败，请重试'); return false; }
    finally { operationRef.current = false; setBusy(null); }
  };
  const navigate = (next: View) => updateRoute({ view: next, selectedId: null });
  const openSession = (session: Session, invoker?: HTMLElement, mode?: 'terminal' | 'chat') => {
    const source = invoker ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    if (source && source !== document.body && !source.closest('.session-drawer, .modal-overlay')) {
      sessionInvokersRef.current.set(session.id, source);
    }
    autoStartRef.current = { id: session.id, mode };
    setSelectedId(session.id); setSelection('');
  };
  const openSessionForInput = (session: Session) => {
    const mode = ['codex', 'claude'].includes(session.backend) && session.interactionMode === 'chat' && !state?.demo ? 'chat' : 'terminal';
    if (session.backend !== 'dsh' || state?.demo || state?.backends.find(item => item.id === 'dsh')?.capabilities.terminal) selectPrivateView(session.backend, mode);
    openSession(session, undefined, mode);
  };
  const copyText = async (value: string, label: string) => {
    try { await copyToClipboard(value); notify(`已复制${label}`); }
    catch { setError('浏览器无法访问剪贴板，请选中对应文字后手动复制'); }
  };
  const patch = (session: Session, values: Partial<Session>) => run(`patch:${session.id}`, () => api(`/sessions/${session.id}`, values, 'PATCH'));
  const toggleNotifications = async () => {
    if (notifications) { setNotifications(false); writeLocalPreference('sessiondeck.notifications', 'off'); return; }
    if (typeof Notification === 'undefined') { notify('当前浏览器不支持系统通知，卡片提醒始终可用'); return; }
    if (soundRef.current) notificationSound(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission === 'granted') { setNotifications(true); writeLocalPreference('sessiondeck.notifications', 'on'); notify('已开启通知，需要你时会提醒'); }
      else notify('系统通知未开启，你仍可在卡片上查看提醒');
    } catch { notify('无法开启系统通知，请检查浏览器权限'); }
  };

  const sessions = state?.sessions ?? [];
  const personal = sessions.filter((session) => !session.archived && !session.groupId);
  // Matches the red badge on cards, so the count drops as you read each one.
  const needsAttention = sessions.filter((session) => !session.archived && pending(session));
  const running = sessions.filter((session) => !session.archived && session.status === 'running');
  const archived = sessions.filter((session) => session.archived);
  const visible = sessions.filter((session) => {
    if (groupId ? session.groupId !== groupId || session.archived : view === 'archive' ? !session.archived : view === 'attention' ? session.archived || !pending(session) : view === 'running' ? session.archived || session.status !== 'running' : session.archived || !!session.groupId) return false;
    return (backendFilter === 'all' || session.backend === backendFilter)
      && (statusFilter === 'all' || (statusFilter === 'attention' ? attention(session) : statusFilter === 'unread' ? session.unread > 0 : session.status === statusFilter))
      && `${session.title} ${session.cwd} ${session.lastUserInput || ''} ${BACKEND[session.backend].name}`.toLowerCase().includes(query.trim().toLowerCase());
  }).sort((a, b) => {
    // Each contact belongs to exactly one tier; an attached idle process
    // is not an active task, and read errors/approvals no longer jump ahead.
    const tier = (s: Session) => s.pinned ? 0 : pending(s) && !s.archived ? 1 : s.status === 'running' ? 2 : s.status === 'waiting_input' ? 3 : 4;
    const priority = tier(a) - tier(b);
    if (priority) return priority;
    if (contactSort === 'name') return a.title.localeCompare(b.title, 'zh-CN', { numeric: true, sensitivity: 'base' });
    const timestamp = (value?: string | null) => value ? Date.parse(value) || 0 : 0;
    if (contactSort === 'input') {
      const inputOrder = timestamp(b.lastUserInputAt) - timestamp(a.lastUserInputAt);
      if (inputOrder) return inputOrder;
    }
    return timestamp(b.createdAt) - timestamp(a.createdAt) || a.title.localeCompare(b.title, 'zh-CN', { numeric: true, sensitivity: 'base' });
  });
  const pageTitle = currentGroup?.title ?? ({ contacts: '会话联系人', attention: '需要你处理', running: '正在运行', activity: '最近活动', archive: '已归档', backends: '连接与能力' } as Record<string, string>)[view] ?? '会话联系人';
  // Invite links can point to several Dili devices. The remote auth status
  // carries the paired name; an unnamed/manual remote page leaves this blank.
  const title = auth.remote && view === 'contacts' && !currentGroup ? (auth.deviceName ?? '') : pageTitle;
  const filtered = !!query || backendFilter !== 'all' || statusFilter !== 'all';
  const selectedBackend = selected ? state?.backends.find((backend) => backend.id === selected.backend) : undefined;
  const nativeSessionBusy = selected?.backend === 'codex' && !selected.running && selected.status === 'error'
    && (selected.errorCode === 'NATIVE_SESSION_BUSY' || /already has an active writer/i.test(selected.statusDetail));
  const agentChatAvailable = !!selected && ['codex', 'claude'].includes(selected.backend) && !state?.demo && !!selectedBackend?.capabilities.graphicalChat;
  // DeepSeek Harness without dsh-tui has no PTY: it shows its native Web UI.
  const dshWebOnly = selected?.backend === 'dsh' && !state?.demo && !selectedBackend?.capabilities.terminal;
  const privateView = selected ? selected.backend === 'codex' && agentChatAvailable
    ? privateViews.codex === 'terminal' ? 'terminal' : 'chat'
    : selected.backend === 'claude' && agentChatAvailable
      ? privateViews.claude === 'chat' ? 'chat' : privateViews.claude === 'conversation' ? selected.running && selected.executionTransport !== 'structured' ? 'conversation' : 'chat' : 'terminal'
      : privateViews[selected.backend] === 'conversation' ? 'conversation' : 'terminal' : 'terminal';
  const switchPrivateView = (mode: 'chat' | 'conversation' | 'terminal') => {
    if (!selected) return;
    const executionView = selected.backend === 'claude' && agentChatAvailable && mode === 'conversation' ? 'chat' : mode;
    if ((executionView === 'terminal' || executionView === 'chat') && agentChatAvailable && selected.running && selected.interactionMode !== executionView) {
      if (selected.backend === 'claude' && !window.confirm('切换将退出当前 Claude 进程，并从同一份已保存会话恢复。当前任务和审批必须先处理完成。继续切换？')) return;
      void run(`attach:${selected.id}`, async () => { await api(`/sessions/${selected.id}/start`, { mode: executionView, handoff: selected.backend === 'claude' }); selectPrivateView(selected.backend, mode); });
    } else selectPrivateView(selected.backend, mode);
  };
  const startMode = (mode = privateView) => agentChatAvailable && (mode === 'chat' || selected?.backend === 'claude' && mode === 'conversation') ? 'chat' : 'terminal';
  const startSelected = (mode?: 'terminal' | 'chat') => {
    if (!selected) return Promise.resolve(false);
    return run(`start:${selected.id}`, () => api(`/sessions/${selected.id}/start`, { mode: mode ?? startMode() }));
  };
  useEffect(() => {
    const pending = autoStartRef.current;
    if (!pending || !selected || !state || pending.id !== selected.id) return;
    autoStartRef.current = null;
    if (selected.running || selected.archived || !selectedBackend?.installed) return;
    void startSelected(pending.mode);
    // Runs once per explicit open; the ref, not the dependency list, gates it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, !!state]);

  const tab = (target: View, icon: ReactNode, label: string, count?: number, alert = false) => <button aria-current={view === target ? 'page' : undefined} className={view === target ? 'active' : ''} onClick={() => navigate(target)}>{icon}<span>{label}</span>{!!count && <b className={alert ? 'alert' : ''}>{count}</b>}</button>;

  const listView = !!state && view !== 'activity' && view !== 'backends';
  const connectionLabel = connected ? '本地服务已连接' : hasConnected ? '连接中断 · 正在重连' : '正在连接本地服务';
  const workspaceSession = sessions.find(session => session.id === workspaceSessionId) ?? sessions.find(session => !session.archived);
  // New file tabs capture their workspace instead of following contact changes.
  const explorerSession = selected ?? workspaceSession;
  const contactMaxWidth = Math.max(220, Math.min(420, workspaceWidth - 320));
  const effectiveContactWidth = Math.min(contactWidth, contactMaxWidth);
  const stopLabel = dshWebOnly ? '停止当前任务' : selected?.interactionMode === 'chat' ? '停止会话' : '停止进程';
  const startLabel = selected?.forkPending ? '启动 Fork 会话' : selected?.nativeSessionId ? '恢复原生会话' : '启动原生会话';

  return <div className={`app-shell ${selected ? 'session-open' : ''}`}>
    {/* A left rail carries navigation and groups; the toolbar above the
        content carries what acts on the current view. On phones the rail
        becomes a bottom tab bar and the toolbar stays on top. */}
    <nav className={`rail ${railOpen ? 'expanded' : ''}`} aria-label="工作空间导航" inert={!!modal}>
      <a className="brand" href="#" aria-label="Dili 嘀哩工作台" title="Dili 嘀哩工作台" onClick={(event) => { event.preventDefault(); navigate('contacts'); }}><span className="brand-mark"><BrandMark /></span><span className="brand-wordmark">Dili</span></a>
      <div className="rail-primary primary-nav">
        {tab('contacts', <MessageSquare size={18} />, '联系人', personal.length)}
        {tab('attention', <Bell size={18} />, '待处理', needsAttention.length, true)}
        {tab('running', <Radio size={18} />, '运行中', running.length)}
        {tab('activity', <Clock3 size={18} />, '活动')}
        {tab('archive', <Archive size={18} />, '归档', archived.length)}
      </div>
      <div className="rail-groups group-nav" role="navigation" aria-label="协作群组">
        {state?.groups.map((group) => { const count = sessions.filter((session) => session.groupId === group.id && !session.archived).length; return <button key={group.id} title={group.goal ? `${group.title}\n${group.goal}` : group.title} aria-current={groupId === group.id ? 'page' : undefined} className={groupId === group.id ? 'active' : ''} onClick={() => navigate(`group:${group.id}`)}><span className="group-hash">#</span><span className="group-name">{group.title}</span>{sessions.some((session) => session.groupId === group.id && !session.archived && pending(session)) && <span className="group-unread-dot" aria-label="有未读提醒" title="群组成员有未读提醒" />}<span className="group-count">{count}</span></button>; })}
        <button className="rail-add-group" disabled={!state} aria-label="创建群组" title="创建群组" onClick={() => setModal({ type: 'group' })}><Plus size={15} /><span className="group-name">新建群组</span></button>
      </div>
      <div className="rail-footer">
        <button className="icon-button rail-toggle" aria-label={railOpen ? '收起侧栏' : '展开侧栏'} title={railOpen ? '收起侧栏' : '展开侧栏'} aria-expanded={railOpen} onClick={toggleRail}>{railOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}</button>
        <span className="connection-indicator" title={connectionLabel}><span className={`connection-dot ${connected ? 'online' : ''}`} /><span className="sr-only">{connectionLabel}</span></span>
        <MoreMenu items={[
          { label: '连接与能力', icon: <Settings2 size={14} />, active: view === 'backends', onSelect: () => navigate('backends') },
          { label: '网页服务', icon: <Globe2 size={14} />, active: servicePreviewOpen, onSelect: toggleServicePreview },
          { label: '随手记', icon: <FilePenLine size={14} />, active: scratchpadOpen, onSelect: toggleScratchpad },
          { label: '外观主题', icon: <Palette size={14} />, onSelect: () => setModal({ type: 'appearance' }) },
          { label: '使用说明与快捷键', icon: <CircleHelp size={14} />, onSelect: () => setModal({ type: 'help' }) },
        ]} />
      </div>
    </nav>
    <div className="app-column">
    <header className="topbar" inert={!!modal}>
      <div className="topbar-row">
        <div className="topbar-title"><h1 aria-label={title || pageTitle} title={title || pageTitle}>{title}</h1>{currentGroup && <button className="icon-button" aria-label="编辑群组" title="编辑群组名称与目标" onClick={() => setModal({ type: 'group', group: currentGroup })}><Pencil size={14} /></button>}{state?.demo && <span className="demo-badge" title="演示模式 · 示例数据">演示</span>}</div>
        <div className="topbar-actions">
          {listView && <><label className="search-field"><Search size={15} /><input id="session-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索" aria-label="搜索联系人" /><kbd>{/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'} K</kbd></label>
            <FilterMenu active={backendFilter !== 'all' || statusFilter !== 'all'} reset={() => { setBackendFilter('all'); setStatusFilter('all'); }}>
              <div className="filter-group"><span>后端</span><div className="backend-tabs" aria-label="按后端筛选"><button aria-pressed={backendFilter === 'all'} className={backendFilter === 'all' ? 'selected' : ''} onClick={() => setBackendFilter('all')}>全部</button>{(['claude', 'codex', 'dsh'] as Backend[]).map((backend) => <button key={backend} aria-pressed={backendFilter === backend} className={backendFilter === backend ? 'selected' : ''} onClick={() => setBackendFilter(backend)}>{BACKEND[backend].short}</button>)}</div></div>
              <label className="filter-group"><span>状态</span><select aria-label="按状态筛选" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as SessionStatus | 'all' | 'attention' | 'unread')}><option value="all">全部状态</option><option value="attention">需要处理</option><option value="unread">未读提醒</option><option value="running">运行中</option><option value="waiting_input">等待输入</option><option value="waiting_approval">等待审批</option><option value="idle">空闲</option><option value="error">异常</option><option value="stopped">已停止</option><option value="unknown">状态未知</option></select></label>
              <label className="filter-group"><span>排序</span><select aria-label="联系人排序" value={contactSort} onChange={(event) => setContactSort(event.target.value as ContactSort)}><option value="input">上次输入时间</option><option value="created">创建时间</option><option value="name">名称</option></select></label>
            </FilterMenu></>}
          <button className={`icon-button ${preview.open ? 'active' : ''}`} aria-label="打开预览面板" title={preview.open ? '隐藏预览面板' : '打开预览面板'} aria-expanded={preview.open} onClick={() => { if (preview.open) preview.hide(); else if (preview.tabs.length) preview.show(); else if (explorerSession) preview.openExplorer(explorerSession); else preview.openNote(); }}><PanelRightOpen size={17} /></button>
          <button className={`icon-button ${workspaceOpen ? 'active' : ''}`} aria-label="打开资源管理器" title="打开资源管理器" disabled={!explorerSession} onClick={() => { if (explorerSession) preview.openExplorer(explorerSession); }}><Folder size={17} /></button>
          <button className={`icon-button ${servicePreviewOpen ? 'active' : ''}`} aria-label="打开网页服务" title="网页服务预览" aria-expanded={servicePreviewOpen} onClick={toggleServicePreview}><Globe2 size={17} /></button>
          <button className={`icon-button ${terminalPanelOpen ? 'active' : ''}`} aria-label="打开终端" title={terminalPanelOpen ? '终端面板已打开' : '打开底部终端'} disabled={!state} onClick={() => openTerminalPanel(selected?.id)}><PanelBottomOpen size={17} /></button>
          <button className={`icon-button ${scratchpadOpen ? 'active' : ''}`} aria-label="打开随手记" title="随手记" aria-expanded={scratchpadOpen} onClick={toggleScratchpad}><FilePenLine size={17} /></button>
          <button className="icon-button appearance-toggle" aria-label="切换主题" title="外观主题" onClick={() => setModal({ type: 'appearance' })}><Palette size={17} /></button>
          <div className="contact-actions">
            <button className="button primary new-contact" aria-label="新建联系人" title="新建联系人" disabled={!state} onClick={() => setModal({ type: 'create' })}><Plus size={17} /></button>
            <button className="button secondary import-contact" aria-label="导入会话" title="导入已有会话" disabled={!state} onClick={() => setModal({ type: 'import' })}><ArrowDownToLine size={17} /><span>导入</span></button>
          </div>
        </div>
      </div>
    </header>

    <div className="app-body">
    <div className="app-main">
    <div ref={workspaceAreaRef} className={`workspace-area ${listView ? 'contacts-workspace' : ''} ${contactsScrolling ? 'contacts-scrolling' : ''} ${selected ? 'session-active' : ''}`} style={{ '--contacts-width': `${effectiveContactWidth}px` } as CSSProperties} onScroll={event => { if (listView && event.target === event.currentTarget) revealContactScrollbar(); }}>
    <main className={`main-content ${listView ? 'contacts-pane' : ''}`} aria-label={listView ? '联系人列表' : undefined} inert={!!modal} hidden={!!selected && !listView} onScroll={() => { if (listView) revealContactScrollbar(); }}>
      {state && !connected && <div className="connection-banner" role="status"><Radio size={15} /><span>{hasConnected ? '服务连接已中断，正在自动重连。卡片暂时显示上次收到的状态。' : '正在建立实时连接，卡片显示最近获取的状态。'}</span><button className="text-button" onClick={() => void refresh().catch(() => {})}>重新获取</button></div>}
      {connectionError && !selected && <div role="alert" className="error-banner connection-error"><span>{connectionError}</span><button className="text-button" onClick={() => void refresh().catch(() => {})}>重试连接</button></div>}
      {error && !selected && <div role="alert" className="error-banner"><span>{error}</span><button className="icon-button" aria-label="关闭错误提示" onClick={() => setError('')}><X size={15} /></button></div>}

      {!state && !connectionError && <div className="loading-state"><LoaderCircle className="spin" size={22} /><p>正在连接你的工作空间…</p></div>}
      {state && view === 'activity' ? <ActivityView activities={state.activities} sessions={state.sessions} open={openSession} /> : state && view === 'backends' ? <><section className="backend-setting-card zoom-settings-card" aria-label="外观设置"><InterfaceZoom /></section><BackendSettings state={state} local={!auth.remote} onTerminal={id => { setTerminalSessionId(undefined); setSetupShellId(id); setTerminalPanelOpen(true); }} refresh={() => void run('refresh', () => api('/backends/refresh', {}), '已重新检测本机后端')} onCreate={(backend) => { setBackendFilter(backend); setModal({ type: 'create', backend }); }} /><div className="backend-settings"><section className="backend-setting-card" aria-label="提醒方式"><div className="backend-setting-title"><Bell size={20} /><div><h2>提醒方式</h2><p>需要你输入、审批或出错时，卡片会亮红点；这里决定是否同时发声和弹系统通知。</p></div></div><div className="notify-toggles"><button className={`button secondary small-button ${soundEnabled ? 'active' : ''}`} aria-label={soundEnabled ? '关闭提示音' : '开启提示音'} aria-pressed={soundEnabled} onClick={() => { const enabled = !soundEnabled; setSoundEnabled(enabled); writeLocalPreference('sessiondeck.sound', enabled ? 'on' : 'off'); if (enabled) notificationSound(); }}>{soundEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}{soundEnabled ? '提示音已开' : '提示音已关'}</button><button className={`button secondary small-button ${notifications ? 'active' : ''}`} aria-label={notifications ? '关闭系统通知' : '开启系统通知'} aria-pressed={notifications} onClick={() => void toggleNotifications()}>{notifications ? <Bell size={14} /> : <BellOff size={14} />}{notifications ? '系统通知已开' : '系统通知已关'}</button></div></section><VoiceSettings local={!auth.remote} demo={state.demo} /><StartupSettings local={!auth.remote} /><SecuritySettings auth={auth} notify={notify} /></div></> : state && <>
          {visible.length > 0 ? <div className="contact-grid">{visible.map((session) => <SessionCard key={session.id} session={session} active={session.id === selectedId} onShare={() => setModal({ type: 'shareLink', session })} canFork={state.backends.find((backend) => backend.id === session.backend)?.capabilities.fork && !!session.nativeSessionId && !session.forkPending || false} onOpen={(invoker) => openSession(session, invoker)} onRename={() => setModal({ type: 'rename', session })} onFork={() => setModal({ type: 'fork', session, groupId: session.groupId ?? undefined })} onPin={() => void patch(session, { pinned: !session.pinned })} onArchive={() => void patch(session, { archived: !session.archived })} onCopyDirectory={() => void copyText(session.cwd, '工作目录')} />)}{currentGroup && <button className="add-member-card" onClick={() => setModal({ type: 'addMember', groupId: currentGroup.id })}><Plus size={20} /><span>添加成员</span></button>}</div> : <EmptyState filtered={filtered} view={view} group={!!currentGroup} backendCount={state.backends.filter((backend) => backend.installed).length} connections={() => navigate('backends')} create={() => setModal(currentGroup ? { type: 'addMember', groupId: currentGroup.id } : { type: 'create' })} importSessions={() => setModal({ type: 'import' })} clear={clearFilters} />}

        </>}
    </main>
    {listView && <Splitter label="调整联系人列表宽度" value={effectiveContactWidth} min={220} max={contactMaxWidth} onChange={setContactWidth} onCommit={value => writeLocalPreference('sessiondeck.layout.contacts-px', String(value))} />}
    {listView && <section hidden={!!selected} className={`conversation-placeholder ${currentGroup ? 'group-conversation' : ''}`} aria-label={currentGroup ? '群组动态' : '会话面板'} inert={!!modal}>
      {currentGroup ? <>
          {currentGroup && groupError && <div className="error-banner" role="alert"><span>群组动态加载失败：{groupError}</span><button className="text-button" onClick={() => setGroupReload((value) => value + 1)}>重试群组动态</button></div>}
          {currentGroup && !groupError && (!detail || detail.group.id !== currentGroup.id) && <div className="loading-state" role="status"><LoaderCircle size={20} className="spin" /><p>正在读取群组动态…</p></div>}
          {currentGroup && detail && detail.group.id === currentGroup.id && <GroupBoard key={currentGroup.id} detail={detail} loadOlder={loadOlder} loadingOlder={loadingOlder} readSource={readSource} resolveDelivery={(delivery, resolution) => void run(`resolve:${delivery.id}`, () => api(`/deliveries/${delivery.id}/resolve`, { attemptId: delivery.attempts?.at(-1)?.id, resolution }), '已记录核对结果')} members={sessions.filter((session) => session.groupId === groupId)} demo={state.demo} busy={busy} confirmReplace={(message, draft, proceed) => setModal({ type: 'replaceDraft', draft, sourceName: message.senderName || '我', proceed })} post={async (body) => {
            const ok = await run('message', () => api(`/groups/${currentGroup.id}/messages`, body), body.kind === 'task' ? '任务已记录，请在任务下方选择填入对应会话' : '已分享到群组'); return ok;
          }} deliver={(id, sessionId) => void run(`deliver:${id}`, async () => { await api(`/deliveries/${id}/send`, {}); const member = sessions.find((session) => session.id === sessionId); if (member) openSessionForInput(member); }, '已处理投递，请在成员私聊中查看')} cancel={(id) => void run(`cancel:${id}`, () => api(`/deliveries/${id}/cancel`, {}), '已取消投递')} open={(id, interactive) => { const session = sessions.find((item) => item.id === id); if (session) (interactive ? openSessionForInput : openSession)(session); }} />}
      </> : <div className="conversation-welcome"><BrandMark size={42} /><h2>选择一个联系人，继续会话</h2><p>你的 Agent、上下文和工作目录，都在左侧。</p></div>}
    </section>}

    {selected && state && <SessionChrome fullscreen={fullscreenSessionId === selected.id} toggleFullscreen={() => setFullscreenSessionId(value => value ? null : selected.id)}><section ref={drawerRef} inert={!!modal} className={`session-drawer${fullscreenSessionId === selected.id ? ' session-fullscreen' : ''}`} onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.defaultPrevented || event.target instanceof HTMLElement && event.target.closest('.terminal-pane')) return;
      if (event.key === 'Escape' && fullscreenSessionId === selected.id) { event.preventDefault(); event.stopPropagation(); setFullscreenSessionId(null); }
      else if (event.key === 'Enter' && event.shiftKey && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopPropagation(); setFullscreenSessionId(value => value ? null : selected.id); }
    }} role="dialog" aria-modal="false" aria-label={`${selected.title} 的私聊`}>
      <header className="drawer-header">
        <button className="icon-button session-back" aria-label="返回联系人列表" title="返回联系人列表" onClick={() => setSelectedId(null)}><ArrowLeft size={18} /></button>
        <div className="drawer-heading-text">
          <div className="drawer-title"><h2 title={selected.title}>{selected.title}</h2><button className="icon-button rename-button" title="改名" aria-label="改名" onClick={() => setModal({ type: 'rename', session: selected })}><Pencil size={12} /></button><StatusBadge session={selected} /></div>
          <nav className="session-meta" aria-label="会话关系">{selected.statusDetail && <span className={`session-status-detail ${attention(selected) ? 'needs-attention' : ''}`} title={`${selected.statusDetail} · ${selected.statusSource === 'native' ? '后端状态' : selected.statusSource === 'terminal' ? '终端估测' : selected.statusSource === 'manual' ? '手动标记' : '进程状态'}`}>{selected.statusDetail}</span>}{selected.archived && <button className="session-meta-link" onClick={() => void patch(selected, { archived: false })}><Archive size={12} />已归档 · 恢复联系人</button>}<span>{BACKEND[selected.backend].short}</span><button className="session-cwd" aria-label="复制工作目录" title={`${selected.cwd}\n点击复制`} onClick={() => void copyText(selected.cwd, '工作目录')}><Folder size={12} /><span><bdi>{selected.cwd}</bdi></span></button>{selectedGroup && <button className="session-meta-link" onClick={() => navigate(`group:${selectedGroup.id}`)}><UsersRound size={12} />{selectedGroup.title}</button>}{selectedParent && <button className="session-meta-link" onClick={() => openSession(selectedParent)}><GitFork size={12} />来源：{selectedParent.title}</button>}</nav>
        </div>
        <div className="private-view-switch" role="group" aria-label="会话显示方式" title={selected.backend === 'claude' && agentChatAvailable ? '图形模式与原生终端通过已保存会话交接，仅空闲时可切换' : '同一个会话，切换视图不重启'}><button aria-label={agentChatAvailable ? '图形对话' : '对话记录'} title={agentChatAvailable ? '图形对话' : '对话记录'} aria-pressed={dshWebOnly ? privateView === 'conversation' : privateView !== 'terminal'} onClick={() => switchPrivateView(agentChatAvailable ? 'chat' : 'conversation')}><MessageSquare size={14} /><span>{agentChatAvailable ? '图形对话' : '对话记录'}</span></button><button aria-label={dshWebOnly ? '原生界面' : '原生终端'} title={dshWebOnly ? '原生界面' : '原生终端'} aria-pressed={privateView === 'terminal'} disabled={!!busy} onClick={() => switchPrivateView('terminal')}><TerminalSquare size={14} /><span>{dshWebOnly ? '原生界面' : '原生终端'}</span></button></div>
        <SessionToolbarHost />
        <div className="drawer-actions">
          <button className="icon-button" aria-label={fullscreenSessionId === selected.id ? '退出会话全屏' : '全屏会话'} title={fullscreenSessionId === selected.id ? '退出全屏（Esc）' : '全屏会话（Ctrl / ⌘ + Shift + Enter）'} aria-pressed={fullscreenSessionId === selected.id} onClick={() => setFullscreenSessionId(value => value ? null : selected.id)}>{fullscreenSessionId === selected.id ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
          {selected.running ? <button className="button secondary small-button session-lifecycle" aria-label={stopLabel} title={stopLabel} disabled={!!busy} onClick={() => void run(`stop:${selected.id}`, () => api(`/sessions/${selected.id}/stop`, {}), dshWebOnly ? '已停止当前任务，原生会话历史仍保留' : '已停止进程，原生会话历史仍保留')}><Square size={12} /><span>{stopLabel}</span></button> : <button className="button primary small-button session-lifecycle" aria-label={startLabel} title={startLabel} disabled={!!busy || selected.archived || !selectedBackend?.installed} onClick={() => void startSelected()}>{busy === `start:${selected.id}` ? <LoaderCircle size={13} className="spin" /> : <Play size={13} />}<span>{startLabel}</span></button>}
          {selected.groupId && <button className="icon-button session-extra-action" aria-label="分享结果到群组" title="分享结果到群组" onClick={() => setModal({ type: 'share', session: selected, text: selection })}><Share2 size={15} /></button>}
          {selected.nativeUrl && <a className="icon-button session-extra-action" aria-label="原生窗口" title="在新窗口打开原生界面" target="_blank" rel="noreferrer" href={selected.nativeUrl}><ExternalLink size={15} /></a>}
          <details key={selected.id} className="session-info"><summary title="更多"><Ellipsis size={16} /><span className="sr-only">会话信息</span></summary><div className="session-info-content">
            <button className="text-button compact-session-action" onClick={preview.openNote}><FilePenLine size={13} />随手记</button>
            <button className="text-button compact-session-action" onClick={() => setModal({ type: 'appearance' })}><Palette size={13} />外观主题</button>
            <button className="text-button compact-session-action" onClick={() => setModal({ type: 'rename', session: selected })}><Pencil size={13} />改名</button>
            <button className="text-button compact-lifecycle" disabled={!!busy || !selected.running && (selected.archived || !selectedBackend?.installed)} onClick={() => selected.running ? void run(`stop:${selected.id}`, () => api(`/sessions/${selected.id}/stop`, {}), '已停止进程，原生会话历史仍保留') : void startSelected()}>{selected.running ? <Square size={13} /> : <Play size={13} />}{selected.running ? stopLabel : startLabel}</button>
            <div><span>后端</span><strong>{BACKEND[selected.backend].name}</strong></div>
            <div><span>状态</span><StatusBadge session={selected} /></div>
            {selected.statusDetail && <p>{selected.statusDetail}</p>}
            <div><span>工作目录</span><code title={selected.cwd}>{selected.cwd}</code><button className="icon-button" aria-label="复制会话目录" title="复制工作目录" onClick={() => void copyText(selected.cwd, '工作目录')}><Copy size={13} /></button></div>
            {selected.archived && <button className="text-button" onClick={() => void patch(selected, { archived: false })}><Archive size={13} />已归档 · 恢复联系人</button>}
            {selectedGroup && <button className="text-button" onClick={() => navigate(`group:${selectedGroup.id}`)}><UsersRound size={13} />{selectedGroup.title}</button>}
            {selectedParent && <button className="text-button" onClick={() => openSession(selectedParent)}><GitFork size={13} />来源：{selectedParent.title}</button>}
            {selected.groupId && <button className="text-button compact-extra-action" onClick={() => setModal({ type: 'share', session: selected, text: selection })}><Share2 size={13} />分享结果到群组</button>}
            {selected.nativeUrl && <a className="text-button compact-extra-action" aria-label="原生窗口" target="_blank" rel="noreferrer" href={selected.nativeUrl}><ExternalLink size={13} />打开原生窗口</a>}
            <button className="text-button" disabled={!selectedBackend?.capabilities.fork || !selected.nativeSessionId || selected.forkPending} title={!selected.nativeSessionId || selected.forkPending ? '请先启动来源会话并完成初始化，再进行 Fork' : '分叉当前上下文'} onClick={() => setModal({ type: 'fork', session: selected, groupId: selected.groupId ?? undefined })}><GitFork size={13} />Fork 会话</button>
            <button className="text-button" onClick={() => setModal({ type: 'handoff', session: selected })}><ArrowRightLeft size={13} />转到其他平台</button>
            <button className="text-button" onClick={() => setModal({ type: 'shareLink', session: selected })}><Link2 size={13} />分享给同事</button>
            <button className="text-button" onClick={() => void copyText(`${location.origin}${location.pathname}${location.search}${workspaceHash({ view, selectedId: selected.id })}`, '会话链接')}><Copy size={13} />复制会话链接</button>
            <div><span>{selected.forkPending ? '来源会话标识' : '原生会话标识'}</span>{selected.nativeSessionId ? <><code>{selected.nativeSessionId}</code><button className="icon-button" aria-label="复制原生会话标识" title="复制原生会话标识" onClick={() => void copyText(selected.nativeSessionId!, '原生会话标识')}><Copy size={13} /></button></> : <small>首次启动后生成</small>}</div>{selected.forkPending && <p>原生 Fork 尚未完成；启动后会获得独立的会话标识。</p>}
            <div><span>执行模式</span><small>{selected.executionMode === 'auto' ? 'Auto · 自动审核' : '原生默认'}</small></div>
            <div><span>创建时间</span><time dateTime={selected.createdAt}>{new Date(selected.createdAt).toLocaleString('zh-CN')}</time></div>
          </div></details>
          <button className="icon-button session-close" aria-label="关闭会话" title="关闭面板，返回列表（Esc）" onClick={() => setSelectedId(null)}><X size={17} /></button>
        </div>
      </header>
      {connectionError && <div role="alert" className="error-banner connection-error"><span>{connectionError}</span><button className="text-button" onClick={() => void refresh().catch(() => {})}>重试连接</button></div>}
      {nativeSessionBusy && <div role="alert" className="error-banner native-session-busy"><span>这个 Codex 会话正被其他原生客户端占用。关闭原客户端后可重试恢复；也可以 Fork 继承上下文，独立继续。</span><div><button className="button secondary small-button" disabled={!!busy} onClick={() => void startSelected()}>重试恢复</button><button className="button secondary small-button" disabled={!!busy || !selectedBackend?.capabilities.fork || !selected.nativeSessionId || selected.forkPending} onClick={() => { setError(''); setModal({ type: 'fork', session: selected, groupId: selected.groupId ?? undefined }); }}><GitFork size={13} />Fork 后继续</button></div></div>}
      {error && !nativeSessionBusy && <div role="alert" className="error-banner"><span>{error}</span><button className="icon-button" aria-label="关闭会话错误提示" onClick={() => setError('')}><X size={15} /></button></div>}
      <div className="session-conversation">
      {dshWebOnly && privateView !== 'conversation' ? selected.nativeUrl ? <div className="native-web"><iframe title="DeepSeek Harness 会话" src={selected.nativeUrl} allow="clipboard-read; clipboard-write" /></div> : <div className="terminal-empty"><BackendAvatar backend="dsh" /><h3>直接使用 Harness 原生界面</h3><p>{busy === `start:${selected.id}` ? '正在启动原生会话…' : '启动会话后，在这里继续这个联系人的上下文。'}</p></div> : privateView === 'chat' ? <Suspense fallback={<div className="loading-state"><LoaderCircle size={22} className="spin" /><p>正在加载对话…</p></div>}><AgentChatPane key={selected.id} session={selected} onTerminal={() => switchPrivateView('terminal')} onSelection={setSelection} /></Suspense> : privateView === 'conversation' ? <ConversationPane key={selected.id} session={selected} allowInput={!state.demo && !dshWebOnly} onTerminal={() => switchPrivateView('terminal')} onSelection={setSelection} /> : selected.backend === 'codex' && agentChatAvailable && selected.running && selected.interactionMode === 'chat' ? <div className="terminal-empty"><Command size={26} /><h3>连接同一个 {BACKEND[selected.backend].short} 会话</h3><button className="button primary" disabled={!!busy} onClick={() => switchPrivateView('terminal')}>连接原生终端</button></div> : <TerminalPane key={selected.id} sessionId={selected.id} running={selected.running} status={selected.status} allowImages={['codex', 'claude', 'dsh'].includes(selected.backend) && !state.demo} onSelection={setSelection} />}
      </div>
    </section></SessionChrome>}
    </div>
    {state && <ShellTerminalDock open={terminalPanelOpen} sessionId={terminalSessionId} requestedShellId={setupShellId} onClose={() => setTerminalPanelOpen(false)} inert={!!modal} />}
    </div>
    <PreviewWorkspace controller={preview} sessions={sessions} currentSession={explorerSession} inert={!!modal} />
    </div>

    </div>
    {modal?.type === 'help' && <HelpDialog close={closeModal} />}
    {modal?.type === 'appearance' && <AppearanceDialog close={closeModal} />}
    {modal?.type === 'replaceDraft' && <ModalShell title="替换当前群组草稿？" subtitle={`将 ${modal.sourceName} 的消息转交为任务，当前草稿需要先处理。`} close={closeModal}><div className="modal-fields"><p className="draft-replace-preview">{modal.draft || '当前草稿已选择接收成员。'}</p><p className="form-note">保留草稿会取消这次转交。替换后，可编辑任务内容并选择接收成员；创建任务仍需你提交。</p></div><div className="modal-footer"><button className="button secondary" onClick={closeModal}>保留当前草稿</button><button className="button primary" onClick={() => { modal.proceed(); closeModal(); }}>替换为转交任务</button></div></ModalShell>}
    {modal?.type === 'shareLink' && <ShareDialog session={modal.session} close={closeModal} notify={notify} />}
    {modal && modal.type !== 'help' && modal.type !== 'appearance' && modal.type !== 'replaceDraft' && modal.type !== 'shareLink' && state && <AppModal modal={modal} state={state} close={closeModal} done={async (session?: Session, group?: Group) => { await refresh().catch(() => {}); closeModal(); if (group) navigate(`group:${group.id}`); if (session) { if (session.groupId) navigate(`group:${session.groupId}`); openSession(session); } }} notify={notify} />}
    {toast && <div className="toast" role="status"><CheckCheck size={16} />{toast}<button aria-label="关闭提示" onClick={() => setToast('')}><X size={14} /></button></div>}
  </div>;
}

function SessionCard({ session, active, canFork, onOpen, onRename, onFork, onPin, onArchive, onCopyDirectory, onShare }: {
  session: Session; active: boolean; canFork: boolean; onShare: () => void; onOpen: (invoker?: HTMLElement) => void; onRename: () => void; onFork: () => void; onPin: () => void; onArchive: () => void; onCopyDirectory: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(false); };
    menuRef.current?.querySelector<HTMLButtonElement>('.dropdown-menu button:not(:disabled)')?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); setMenu(false); menuButtonRef.current?.focus(); }
      if (!menuRef.current?.contains(event.target as Node) || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const items = [...menuRef.current.querySelectorAll<HTMLButtonElement>('.dropdown-menu button:not(:disabled)')];
      const current = items.findIndex((item) => item === document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      items[next]?.focus();
    };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape); };
  }, [menu]);
  const preview = session.statusDetail || (session.forkPending ? '启动时将通过原生能力分叉上下文' : session.nativeSessionId ? '上下文已连接，点击继续' : '准备就绪，点击进入会话');
  return <article onClick={(event) => { if (!(event.target as Element).closest('button, a, .dropdown-menu')) onOpen(event.currentTarget.querySelector<HTMLButtonElement>('.card-main') ?? undefined); }} className={`session-card ${active ? 'active' : ''} tone-${STATUS[session.status].className} ${attention(session) ? 'has-attention' : ''} ${pending(session) && !session.archived ? 'has-unread' : ''} ${session.archived ? 'archived-card' : ''}`}>
    <button className={`icon-button card-pin ${session.pinned ? 'pinned' : ''}`} aria-label={session.pinned ? `取消置顶 ${session.title}` : `置顶 ${session.title}`} aria-pressed={session.pinned} title={session.pinned ? '取消置顶' : '置顶到最前'} onClick={onPin}>{session.pinned ? <Pin size={12} className="pinned-icon" /> : <PinOff size={12} />}</button>
    <div className="card-head">
      <span className="avatar-wrap"><BackendAvatar backend={session.backend} />{pending(session) && <span className="unread-badge" aria-label={`${session.unread} 条未读提醒`}>{session.unread > 99 ? '99+' : session.unread}</span>}</span>
      <div className="card-title">
        <div className="card-title-row"><button className="card-main" aria-current={active ? 'true' : undefined} aria-label={`进入 ${session.title} 的会话`} onClick={(event) => onOpen(event.currentTarget)}><h3 title={session.title}>{session.title}</h3></button></div>
        <div className="card-prompt"><p title={session.lastUserInput || preview}>{session.lastUserInput || preview}</p></div>
      </div>
      {session.status !== 'idle' && session.status !== 'stopped' && <span className="card-state"><StatusBadge session={session} /></span>}
    </div>
    <div className="card-activity"><time dateTime={session.lastActivity} title={new Date(session.lastActivity).toLocaleString('zh-CN')}>{relativeTime(session.lastActivity)}</time>
      <span className="card-menu-anchor" ref={menuRef}><button ref={menuButtonRef} className="icon-button" aria-label={`${session.title} 的更多操作`} aria-expanded={menu} onClick={() => setMenu(!menu)}><Ellipsis size={15} /></button>{menu && <div className="dropdown-menu"><button onClick={() => { menuButtonRef.current?.focus(); onRename(); setMenu(false); }}><Pencil size={14} />改名</button><button onClick={() => { menuButtonRef.current?.focus(); onPin(); setMenu(false); }}><Pin size={14} />{session.pinned ? '取消置顶' : '置顶联系人'}</button><button disabled={!canFork} title={canFork ? undefined : !session.nativeSessionId || session.forkPending ? '请先启动原生会话并完成初始化' : '该后端暂不可 Fork'} onClick={() => { menuButtonRef.current?.focus(); onFork(); setMenu(false); }}><GitFork size={14} />Fork 会话</button><button aria-label={`复制 ${session.title} 的工作目录`} title={session.cwd} onClick={() => { menuButtonRef.current?.focus(); onCopyDirectory(); setMenu(false); }}><Copy size={14} />复制工作目录</button><button onClick={() => { menuButtonRef.current?.focus(); onShare(); setMenu(false); }}><Link2 size={14} />分享会话</button><span /><button onClick={() => { onArchive(); setMenu(false); }}><Archive size={14} />{session.archived ? '恢复到列表' : '归档联系人'}</button></div>}</span></div>
  </article>;
}

/** Rarely used topbar actions share one dropdown so the bar stays short on phones. */
function MoreMenu({ items }: { items: { label: string; icon: ReactNode; onSelect: () => void; disabled?: boolean; active?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); ref.current?.querySelector<HTMLButtonElement>('button')?.focus(); } };
    document.addEventListener('mousedown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  return <div className="more-menu" ref={ref}><button className={`icon-button ${open || items.some(item => item.active) ? 'active' : ''}`} aria-label="更多" title="更多" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)}><Ellipsis size={17} /></button>
    {open && <div className="dropdown-menu" role="menu">{items.map(item => <button key={item.label} role="menuitem" aria-label={item.label} disabled={item.disabled} className={item.active ? 'active' : ''} onClick={() => { setOpen(false); item.onSelect(); }}>{item.icon}{item.label}</button>)}</div>}</div>;
}

function FilterMenu({ active, reset, children }: { active: boolean; reset: () => void; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); ref.current?.querySelector<HTMLButtonElement>('button')?.focus(); } };
    document.addEventListener('mousedown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  return <div className="filter-menu" ref={ref}><button className={`icon-button ${active || open ? 'active' : ''}`} aria-label="筛选与排序" title="筛选与排序" aria-expanded={open} onClick={() => setOpen(!open)}><SlidersHorizontal size={17} />{active && <i className="filter-dot" />}</button>
    {open && <div className="filter-popover" role="group" aria-label="筛选与排序">{children}{active && <button className="text-button" onClick={reset}>重置筛选</button>}</div>}</div>;
}

function EmptyState({ filtered, view, group, backendCount, connections, create, importSessions, clear }: { filtered: boolean; view: View; group: boolean; backendCount: number; connections: () => void; create: () => void; importSessions: () => void; clear: () => void }) {
  const waiting = view === 'attention'; const archive = view === 'archive'; const running = view === 'running';
  const first = !filtered && !waiting && !archive && !running && !group;
  return <div className="empty-state">{filtered ? <Search size={26} strokeWidth={1.5} /> : waiting ? <CheckCheck size={26} strokeWidth={1.5} /> : group ? <UsersRound size={26} strokeWidth={1.5} /> : archive ? <Archive size={26} strokeWidth={1.5} /> : <MessageSquare size={26} strokeWidth={1.5} />}<h3>{filtered ? '没有找到匹配的联系人' : running ? '目前没有正在执行的任务' : waiting ? '没有未读的提醒' : archive ? '这里还没有归档会话' : group ? '群组还没有成员' : '还没有联系人'}</h3><p>{filtered ? '试试其他关键词，或调整后端与状态筛选。' : running ? '会话开始执行任务后会出现在这里。' : waiting ? '会话等待输入、审批或出现异常时会在这里出现，打开后即视为已读。' : archive ? '归档的联系人会保留在这里。' : group ? '新建会话，或将已有联系人 Fork 入群。' : backendCount ? '新建一个联系人，或导入本机已有的原生会话。' : '尚未检测到本机 Agent，可先查看后端安装情况；已有历史仍可尝试导入。'}</p><div>{filtered ? <button className="button secondary" onClick={clear}>清除筛选</button> : !waiting && !archive && !running && <><button className="button primary" onClick={create}><Plus size={15} />{group ? '添加成员' : '新建联系人'}</button>{!group && <button className="button secondary" onClick={importSessions}><ArrowDownToLine size={15} /> 导入已有会话</button>}</>}</div>{first && <button className="text-button" onClick={connections}>{backendCount ? '查看后端连接与能力' : '查看后端安装情况'}<ArrowRight size={13} /></button>}</div>;
}

function BackendSettings({ state, refresh, onCreate, local, onTerminal }: { state: AppState; refresh: () => void; onCreate: (backend: Backend) => void; local: boolean; onTerminal: (id: string) => void }) {
  const [setup, setSetup] = useState<AgentSetupInfo[]>([]);
  const [setupError, setSetupError] = useState('');
  const refreshSetup = useCallback(async () => { try { setSetup(await api<AgentSetupInfo[]>('/setup/agents')); setSetupError(''); } catch (cause) { setSetupError(cause instanceof Error ? cause.message : '无法读取安装引导'); } }, []);
  useEffect(() => { void refreshSetup(); }, [refreshSetup]);
  return <div className="backend-settings">{state.backends.map((backend) => <section className="backend-setting-card" key={backend.id}><div className="backend-setting-title"><BackendAvatar backend={backend.id} /><div><h2>{backend.label}</h2><p>{backend.version || (backend.installed ? '已检测到本机安装' : '未检测到本机安装')}</p></div><span className={`status-badge ${backend.installed ? 'running' : 'unknown'}`}><i />{backend.installed ? '已安装' : '未安装'}</span></div><p className="backend-note">{backend.note || (backend.id === 'dsh' ? '通过 Harness 原生 Web 界面继续交互。' : '在浏览器内运行原生 CLI，保留熟悉的操作方式。')}</p><div className="capability-list">{[['terminal', '原生终端'], ['resume', '恢复会话'], ['fork', '原生 Fork'], ['discovery', '发现已有会话']].map(([capability, label]) => <span key={capability} className={backend.capabilities[capability as keyof typeof backend.capabilities] ? 'supported' : ''}>{backend.capabilities[capability as keyof typeof backend.capabilities] ? <Check size={13} /> : <span className="capability-dash">—</span>}{label}</span>)}</div><button className="button secondary" disabled={!backend.installed} onClick={() => onCreate(backend.id)}><Plus size={15} /> 创建 {BACKEND[backend.id].short} 联系人</button><AgentSetupControls info={setup.find(item => item.id === backend.id)} local={local} onTerminal={onTerminal} refresh={refreshSetup} /></section>)}<div className="backend-info-note"><span>{setupError || '能力以本机实际安装的后端为准；安装或升级后重新检测。'}</span><button className="button secondary small-button" onClick={() => { refresh(); void refreshSetup(); }}><Radio size={14} /> 刷新状态</button></div></div>;
}

function GroupBoard({ detail, members, demo, busy, post, deliver, cancel, open, confirmReplace, loadOlder, loadingOlder, readSource, resolveDelivery }: { loadOlder: () => Promise<void>; loadingOlder: boolean; readSource: (id: string) => Promise<GroupMessage>; resolveDelivery: (delivery: Omit<Delivery, 'text'>, resolution: 'confirmed' | 'not_received' | 'cancelled') => void; detail: GroupDetail; members: Session[]; demo: boolean; busy: string | null; post: (body: { text: string; kind: GroupMessage['kind']; recipientIds: string[]; sourceMessageId?: string | null }) => Promise<boolean>; confirmReplace: (message: GroupMessage, draft: string, proceed: () => void) => void; deliver: (id: string, sessionId: string) => void; cancel: (id: string) => void; open: (id: string, interactive?: boolean) => void }) {
  const [draft] = useState(() => readGroupDraft(detail.group.id));
  const [kind, setKind] = useState<GroupMessage['kind']>(draft.kind);
  const [text, setText] = useState(draft.text);
  const [recipients, setRecipients] = useState<string[]>(draft.recipients);
  const [sourceMessageId, setSourceMessageId] = useState<string | null>(draft.sourceMessageId);
  const [visibleStart, setVisibleStart] = useState(() => Math.max(0, detail.messages.length - 200));
  const firstVisible = detail.page ? 0 : Math.min(visibleStart, Math.max(0, detail.messages.length - 1));
  const totalMessages = detail.page?.total ?? detail.messages.length;
  const earlierCount = detail.page ? Math.max(0, totalMessages - detail.messages.length) : firstVisible;
  const [sourcePreview, setSourcePreview] = useState<GroupMessage | null>(null);
  const sourceVersion = useRef(0);
  useEffect(() => () => { sourceVersion.current++; }, []);
  const visibleMessages = useMemo(() => detail.messages.slice(firstVisible), [detail.messages, firstVisible]);
  const historyRef = useRef<HTMLDivElement>(null);
  const previousHistoryScroll = useRef<{ top: number; height: number } | null>(null);
  const pendingMessageJump = useRef<string | null>(null);
  const currentDraftRef = useRef('');
  currentDraftRef.current = JSON.stringify({ text, kind, recipients, sourceMessageId });
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
  const sourceMessage = sourceMessageId ? messagesById.get(sourceMessageId) : undefined;
  const composerRef = useRef<HTMLTextAreaElement>(null);
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
    if (pendingMessageJump.current) {
      const element = document.getElementById(`group-message-${pendingMessageJump.current}`);
      element?.scrollIntoView({ block: 'center', behavior: 'instant' });
      element?.focus({ preventScroll: true });
      pendingMessageJump.current = null;
      previousHistoryScroll.current = null;
    } else if (previousHistoryScroll.current && historyRef.current) {
      const previous = previousHistoryScroll.current;
      historyRef.current.scrollTop = previous.top + historyRef.current.scrollHeight - previous.height;
      previousHistoryScroll.current = null;
    }
  }, [firstVisible, detail.messages[0]?.id]);
  const forwardMessage = useCallback((message: GroupMessage) => {
    const proceed = () => {
      setKind('task'); setText(message.text); setRecipients([]); setSourceMessageId(message.id); setLocalError('');
      requestAnimationFrame(() => { composerRef.current?.focus(); composerRef.current?.scrollIntoView({ block: 'center' }); });
    };
    const current = JSON.parse(currentDraftRef.current) as GroupDraft;
    if (current.text.trim() || current.recipients.length || current.sourceMessageId) confirmReplace(message, current.text, proceed);
    else proceed();
  }, [confirmReplace]);
  const [localError, setLocalError] = useState('');
  const [posting, setPosting] = useState(false);
  const postingRef = useRef(false);
  const activeMembers = members.filter((member) => !member.archived);
  const activeRecipients = recipients.filter((id) => activeMembers.some((member) => member.id === id));
  useEffect(() => {
    const submitted = (event: Event) => {
      const finished = (event as CustomEvent<{ groupId: string; draft: string }>).detail;
      if (finished.groupId === detail.group.id && finished.draft === currentDraftRef.current) {
        setText(''); setRecipients([]); setSourceMessageId(null);
      }
    };
    window.addEventListener('sessiondeck:group-draft-submitted', submitted);
    return () => window.removeEventListener('sessiondeck:group-draft-submitted', submitted);
  }, [detail.group.id]);
  useEffect(() => {
    try {
      const key = `sessiondeck.group-draft.${detail.group.id}`;
      if (text || recipients.length || sourceMessageId) sessionStorage.setItem(key, JSON.stringify({ text, kind, recipients, sourceMessageId }));
      else sessionStorage.removeItem(key);
    } catch { /* Draft persistence is optional when browser storage is disabled. */ }
  }, [detail.group.id, text, kind, recipients, sourceMessageId]);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setLocalError('');
    if (!text.trim() || postingRef.current || busy) return;
    if (kind === 'task' && !activeRecipients.length) { setLocalError('请选择至少一位任务接收成员'); return; }
    const submittedDraft = currentDraftRef.current;
    const submittedGroupId = detail.group.id;
    postingRef.current = true; setPosting(true);
    try {
      if (await post({ text: text.trim(), kind, recipientIds: kind === 'task' ? activeRecipients : [], sourceMessageId })) {
        // The user may navigate away before the response arrives. Clear only
        // this submitted draft, including a remounted composer, never a new edit.
        try {
          const key = `sessiondeck.group-draft.${submittedGroupId}`;
          if (sessionStorage.getItem(key) === submittedDraft) sessionStorage.removeItem(key);
        } catch { /* The live composer still clears when storage is unavailable. */ }
        window.dispatchEvent(new CustomEvent('sessiondeck:group-draft-submitted', { detail: { groupId: submittedGroupId, draft: submittedDraft } }));
      }
    } finally { postingRef.current = false; setPosting(false); }
  };
  // Keystrokes only update the composer. Historical rows keep their DOM and
  // use indexed lookups instead of rescanning every delivery and member.
  const messageList = useMemo(() => <div ref={historyRef} className="message-list">{totalMessages > 200 && <div className="history-range"><span>显示第 {earlierCount + 1}–{totalMessages} 条，共 {totalMessages} 条</span>{earlierCount > 0 && <button className="text-button" disabled={loadingOlder} onClick={showEarlier}>{loadingOlder ? '正在读取…' : `显示更早 ${Math.min(200, earlierCount)} 条`}</button>}</div>}{visibleMessages.length ? visibleMessages.map((message) => <article id={`group-message-${message.id}`} tabIndex={-1} key={message.id} className={`group-message kind-${message.kind} ${message.senderId ? '' : 'mine'}`}><span className="message-avatar">{message.senderId ? <Command size={16} /> : '我'}</span><div className="message-body"><div className="message-heading"><strong>{message.senderName || '我'}</strong><span className="message-kind">{message.kind === 'task' ? '任务' : message.kind === 'result' ? '结果' : '记录'}</span><time>{relativeTime(message.createdAt)}</time></div><div className="bubble">{message.sourceMessageId && <button className="message-source-link" onClick={() => jumpToMessage(message.sourceMessageId!)}><ArrowRight size={12} />来源：{messagesById.get(message.sourceMessageId)?.senderName || '原消息'}<span>查看原消息</span></button>}<p>{message.text}</p>{message.recipientIds.length > 0 && <div className="message-recipients">{message.recipientIds.map((id) => <button key={id} onClick={() => open(id)}>@{membersById.get(id)?.title || '已归档成员'}</button>)}</div>}</div><div className="delivery-list">{(deliveriesByMessage.get(message.id) ?? []).map((delivery) => {
      const member = membersById.get(delivery.sessionId);
      return <div className="delivery-item" key={delivery.id}><span><Send size={13} />{member?.title || '群组成员'}</span>{delivery.status === 'pending' ? <div><button className="text-button" disabled={!!busy || !member || member.archived} onClick={() => deliver(delivery.id, delivery.sessionId)}>{busy === `deliver:${delivery.id}` ? <LoaderCircle size={13} className="spin" /> : <ArrowRight size={13} />}{!demo && (member?.backend === 'dsh' || !!member && ['codex', 'claude'].includes(member.backend) && member.interactionMode === 'chat') ? '发送到会话' : '填入会话'}</button><button className="icon-button" disabled={!!busy} aria-label="取消投递" title="取消投递" onClick={() => cancel(delivery.id)}><X size={13} /></button></div> : delivery.status === 'unknown' ? <div className="delivery-uncertain"><span title={delivery.lastError}>结果待确认，请核对原生会话</span><button className="text-button" onClick={() => open(delivery.sessionId, true)}>进入核对</button><button className="text-button" disabled={!!busy} onClick={() => resolveDelivery(delivery, 'confirmed')}>已核对，已收到</button><button className="text-button" disabled={!!busy} onClick={() => resolveDelivery(delivery, 'not_received')}>已核对，未收到</button><button className="text-button" disabled={!!busy} onClick={() => resolveDelivery(delivery, 'cancelled')}>关闭投递</button></div> : <span className="delivery-state">{delivery.status === 'sending' ? '投递中…' : delivery.status === 'sent' ? '已发送' : delivery.status === 'staged' ? '已填入 · 在私聊按回车发送' : '已取消'}{delivery.status === 'staged' && <button className="text-button" onClick={() => open(delivery.sessionId, true)}>进入 <ArrowRight size={12} /></button>}</span>}</div>;
    })}</div><div className="message-actions"><button className="text-button" disabled={posting || !!busy} onClick={() => forwardMessage(message)}><ArrowRight size={13} />转交为任务</button></div></div></article>) : <div className="board-empty"><p>还没有群组消息。记录想法、向成员分配任务，或分享结果。</p></div>}</div>, [totalMessages, earlierCount, loadingOlder, firstVisible, visibleMessages, messagesById, membersById, deliveriesByMessage, busy, posting, demo, open, deliver, cancel, resolveDelivery, jumpToMessage, forwardMessage, showEarlier]);
  return <section className="group-board"><div className="section-heading"><div><h2>群组动态</h2><span className="section-count">{totalMessages}</span></div>{detail.group.goal && <p className="group-goal-line" title={detail.group.goal}>目标：{detail.group.goal}</p>}</div><div className="board-content">
    {messageList}
    {sourcePreview && <ModalShell title="来源消息" subtitle={sourcePreview.senderName} close={() => setSourcePreview(null)}><div className="modal-fields"><p className="draft-replace-preview">{sourcePreview.text}</p></div><div className="modal-footer"><button className="button secondary" onClick={() => { forwardMessage(sourcePreview); setSourcePreview(null); }}>转交为任务</button><button className="button primary" onClick={() => setSourcePreview(null)}>返回群组</button></div></ModalShell>}
    <form className="message-composer" onSubmit={submit}><div className="composer-tabs">{(['note', 'task', 'result'] as const).map((value) => <button type="button" key={value} disabled={posting} aria-pressed={kind === value} className={kind === value ? 'active' : ''} onClick={() => setKind(value)}>{value === 'note' ? <MessageSquare size={14} /> : value === 'task' ? <Send size={14} /> : <CheckCheck size={14} />}{value === 'note' ? '记录' : value === 'task' ? '分配任务' : '分享结果'}</button>)}</div>{kind === 'task' && <div className="recipient-picker"><span>接收成员</span>{activeMembers.map((member) => <button type="button" disabled={posting} aria-pressed={recipients.includes(member.id)} key={member.id} className={recipients.includes(member.id) ? 'selected' : ''} onClick={() => setRecipients((current) => current.includes(member.id) ? current.filter((id) => id !== member.id) : [...current, member.id])}>{recipients.includes(member.id) && <Check size={12} />}<BackendAvatar backend={member.backend} small />{member.title}</button>)}{!activeMembers.length && <small>添加成员后，即可分配任务</small>}</div>}{sourceMessageId && <div className="composer-source"><button type="button" className="text-button" onClick={() => jumpToMessage(sourceMessageId)}><Share2 size={13} />来源：{sourceMessage?.senderName || '原消息'}<span>查看原消息</span></button><button type="button" className="icon-button" disabled={posting} aria-label="解除转交来源" title="解除来源，保留内容" onClick={() => setSourceMessageId(null)}><X size={13} /></button></div>}<textarea ref={composerRef} disabled={posting} aria-label="群组消息" onKeyDown={(event) => { if (!event.nativeEvent.isComposing && (event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={kind === 'task' ? '描述任务、期望结果与需要参考的上下文…' : kind === 'result' ? '把成员的结论、进展或待决策事项分享给群组…' : '记录目标、想法或决定…'} value={text} onChange={(event) => setText(event.target.value)} rows={3} required maxLength={30000} />{localError && <p role="alert" className="form-error">{localError}</p>}<div className="composer-footer"><span title="草稿保留在当前浏览器标签页；Ctrl / ⌘ + Enter 发布">{kind === 'task' ? '任务先入队，再由你投递到成员会话。' : '群组记录不会自动发送给成员。'}{text && <small className="draft-note">草稿保留 · Ctrl / ⌘ + Enter 发布</small>}</span><button className="button primary small-button" disabled={!!busy || posting || !text.trim() || (kind === 'task' && !activeMembers.length)}>{busy === 'message' ? <LoaderCircle size={14} className="spin" /> : <Send size={14} />}{kind === 'task' ? '创建任务' : '发布'}</button></div></form>
  </div></section>;
}

function AppModal({ modal, state, close, done, notify }: { modal: Exclude<NonNullable<Modal>, { type: 'help' | 'appearance' | 'replaceDraft' | 'shareLink' }>; state: AppState; close: () => void; done: (session?: Session, group?: Group) => Promise<void>; notify: (message: string) => void }) {
  const [title, setTitle] = useState(modal.type === 'rename' ? modal.session.title : modal.type === 'fork' ? `${modal.session.title} · Fork` : modal.type === 'handoff' ? `${modal.session.title} · 交接` : modal.type === 'group' ? modal.group?.title ?? '' : '');
  const [backend, setBackend] = useState<Backend>((modal.type === 'create' ? modal.backend : undefined) ?? state.backends.find((item) => item.installed && (modal.type !== 'handoff' || item.id !== modal.session.backend))?.id ?? 'claude');
  const recentSessions = useMemo(() => [...state.sessions].sort((first, second) => second.lastActivity.localeCompare(first.lastActivity)), [state.sessions]);
  const recentDirectories = [...new Set(recentSessions.map(session => session.cwd).filter(Boolean))].slice(0, 5);
  const creationGroupId = modal.type === 'create' || modal.type === 'addMember' ? modal.groupId : undefined;
  const [cwd, setCwd] = useState(() => {
    if (!creationGroupId) return state.defaultCwd;
    const groupMember = recentSessions.find(session => session.groupId === creationGroupId && !session.archived)
      ?? recentSessions.find(session => session.groupId === creationGroupId);
    return groupMember?.cwd || state.defaultCwd;
  });
  const [forkCwd, setForkCwd] = useState(modal.type === 'fork' ? modal.session.cwd : state.defaultCwd);
  const [goal, setGoal] = useState(modal.type === 'group' ? modal.group?.goal ?? '' : '');
  const [text, setText] = useState(modal.type === 'share' ? modal.text : '');
  const [executionMode, setExecutionMode] = useState<ExecutionMode>('default');
  useEffect(() => { if (!state.backends.find(item => item.id === backend)?.capabilities.autoMode) setExecutionMode('default'); }, [backend, state.backends]);
  const [handoffSummary, setHandoffSummary] = useState('请先检查当前工作区和文件状态，再继续完成原任务。');
  const [groupId, setGroupId] = useState(modal.type === 'fork' || modal.type === 'create' ? modal.groupId ?? '' : '');
  const [sourceId, setSourceId] = useState('');
  const [memberMode, setMemberMode] = useState<'new' | 'fork'>('new');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [discovered, setDiscovered] = useState<DiscoveredSession[] | null>(null);
  const [discoveryError, setDiscoveryError] = useState('');
  const [discoveryAttempt, setDiscoveryAttempt] = useState(0);
  const [importDirectory, setImportDirectory] = useState<{ id: string; cwd: string } | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [discoverQuery, setDiscoverQuery] = useState('');
  const [importId, setImportId] = useState<string | null>(null);
  const backendInfo = state.backends.find((item) => item.id === backend);
  const selectedSource = state.sessions.find((session) => session.id === sourceId);
  const filteredDiscovered = discovered?.filter((session) => `${session.title} ${session.cwd}`.toLowerCase().includes(discoverQuery.trim().toLowerCase()));
  useEffect(() => {
    if (modal.type !== 'import') return;
    let active = true; setDiscovered(null); setWarnings([]); setError(''); setDiscoveryError(''); setImportDirectory(null);
    api<{ sessions: DiscoveredSession[]; warnings?: string[] }>(`/discover?backend=${backend}`).then((result) => { if (active) { setDiscovered(result.sessions); setWarnings(result.warnings ?? []); } }).catch((cause) => { if (active) { setDiscoveryError(cause instanceof Error ? cause.message : '发现会话失败'); setDiscovered([]); } });
    return () => { active = false; };
  }, [backend, modal.type, discoveryAttempt]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (modal.type === 'import') return;
    setBusy(true); setError('');
    try {
      if (modal.type === 'rename') { await api(`/sessions/${modal.session.id}`, { title: title.trim() }, 'PATCH'); await done(); }
      if (modal.type === 'create') { const session = await api<Session>('/sessions', { title: title.trim(), backend, cwd: cwd.trim(), executionMode, groupId: modal.groupId || undefined }); await done(session); }
      if (modal.type === 'fork') { const session = await api<Session>(`/sessions/${modal.session.id}/fork`, { title: title.trim(), groupId: groupId || undefined, cwd: modal.session.backend === 'dsh' ? undefined : forkCwd.trim() }); notify('已创建 Fork 联系人，原会话保留'); await done(session); }
      if (modal.type === 'handoff') { const result = await api<{ session: Session; prompt: string }>(`/sessions/${modal.session.id}/handoff`, { title: title.trim(), backend, cwd: cwd.trim(), summary: handoffSummary.trim() }); await copyToClipboard(result.prompt); notify('已创建目标联系人，交接内容已复制'); await done(result.session); }
      if (modal.type === 'group') { const group = modal.group ? await api<Group>(`/groups/${modal.group.id}`, { title: title.trim(), goal: goal.trim() }, 'PATCH') : await api<Group>('/groups', { title: title.trim(), goal: goal.trim() }); await done(undefined, group); }
      if (modal.type === 'addMember') {
        if (memberMode === 'fork' && !sourceId) throw new Error('请选择要 Fork 的联系人');
        const session = memberMode === 'new' ? await api<Session>('/sessions', { title: title.trim(), backend, cwd: cwd.trim(), executionMode, groupId: modal.groupId }) : await api<Session>(`/sessions/${sourceId}/fork`, { title: title.trim() || `${selectedSource?.title} · 群组`, groupId: modal.groupId });
        notify(memberMode === 'fork' ? '已将上下文 Fork 入群，原会话保留' : '群组成员已创建'); await done(session);
      }
      if (modal.type === 'share') { await api(`/groups/${modal.session.groupId}/messages`, { text: text.trim(), kind: 'result', senderId: modal.session.id, recipientIds: [] }); notify('结果已分享到群组'); await done(); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败'); }
    finally { setBusy(false); }
  };
  const importSession = async (session: DiscoveredSession) => {
    if (session.cwdAvailable === false && importDirectory?.id !== session.nativeSessionId) {
      setImportDirectory({ id: session.nativeSessionId, cwd: session.cwd }); setError(''); return;
    }
    setBusy(true); setImportId(session.nativeSessionId); setError('');
    const cwd = importDirectory?.id === session.nativeSessionId ? importDirectory.cwd : session.cwd;
    try { const imported = await api<Session>('/import', { backend: session.backend, nativeSessionId: session.nativeSessionId, title: session.title, cwd }); notify('已导入原生会话'); await done(imported); }
    catch (cause) {
      const unavailable = cause instanceof ApiError && (cause.code === 'IMPORT_CWD_UNAVAILABLE' || cause.status === 400 && /^工作目录/.test(cause.message));
      if (unavailable) { setImportDirectory({ id: session.nativeSessionId, cwd }); setError('原工作目录不存在或无法访问，请选择现有目录后重试。'); }
      else setError(cause instanceof Error ? cause.message : '导入失败');
    }
    finally { setBusy(false); setImportId(null); }
  };
  const titleLabel = modal.type === 'create' ? '新建会话联系人' : modal.type === 'rename' ? '给联系人改个名字' : modal.type === 'fork' ? 'Fork 会话' : modal.type === 'handoff' ? '转到其他平台' : modal.type === 'group' ? modal.group ? '编辑群组' : '创建协作群组' : modal.type === 'addMember' ? '添加群组成员' : modal.type === 'share' ? '分享结果到群组' : '导入已有会话';
  const subtitle = modal.type === 'create' ? '选择 Agent，让下一段工作拥有独立的上下文。' : modal.type === 'fork' ? '延续这段上下文，开启另一条思路。原会话会保留。' : modal.type === 'handoff' ? '创建一个新的平台联系人，原会话保持不变。交接内容会复制到剪贴板。' : modal.type === 'group' ? '把相关的会话组织起来，围绕同一个目标工作。' : modal.type === 'import' ? '发现本机已有的原生会话，添加到联系人列表。' : modal.type === 'addMember' ? '每一位成员都有独立私聊，可以随时进入并纠正。' : modal.type === 'share' ? '检查并编辑内容，再将它作为成员结果记录到群组。' : '名称只影响 Dili 中的显示。';
  const backendPicker = <fieldset className="backend-picker"><legend>选择后端</legend>{state.backends.map((item) => <button type="button" key={item.id} aria-pressed={backend === item.id} disabled={busy || (modal.type !== 'import' && !item.installed) || (modal.type === 'handoff' && item.id === modal.session.backend)} className={backend === item.id ? 'selected' : ''} onClick={() => setBackend(item.id)}><BackendAvatar backend={item.id} small /><strong>{BACKEND[item.id].short}</strong><small>{item.id === (modal.type === 'handoff' ? modal.session.backend : '') ? '当前平台' : item.installed ? '本机已安装' : '未安装'}</small>{backend === item.id && <Check size={14} />}</button>)}</fieldset>;
  const nameField = <label className="form-label">联系人名称<input autoComplete="off" placeholder="例如：登录功能实现" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} required /></label>;
  const cwdField = <div className="cwd-field"><DirectoryField label="工作目录" value={cwd} onChange={setCwd} disabled={busy} help="Agent 将在运行 Dili 的机器上使用这个目录。" />{recentDirectories.length > 0 && <details className="recent-directories"><summary>最近使用的目录</summary><div>{recentDirectories.map(directory => <button key={directory} type="button" title={directory} onClick={() => setCwd(directory)}><Folder size={13} /><span>{directory}</span>{cwd === directory && <Check size={13} />}</button>)}</div></details>}</div>;
  return <ModalShell title={titleLabel} subtitle={subtitle} close={busy ? () => {} : close} wide={modal.type === 'import'}><form onSubmit={submit}>
    {modal.type === 'import' ? <>{backendPicker}<label className="search-field import-search"><Search size={16} /><input aria-label="搜索可导入会话" placeholder="搜索标题或工作目录…" value={discoverQuery} onChange={(event) => setDiscoverQuery(event.target.value)} /></label>{warnings.map((warning) => <p className="form-note" key={warning}>{warning}</p>)}<div className="discovered-list">{discovered === null ? <div className="discovery-empty"><LoaderCircle size={24} className="spin" /><p>正在发现本机会话…</p></div> : filteredDiscovered?.map((session) => {
      const exists = state.sessions.some((item) => item.backend === session.backend && item.nativeSessionId === session.nativeSessionId && !item.forkPending);
      const editingDirectory = importDirectory?.id === session.nativeSessionId;
      return <div className="discovered-entry" key={session.nativeSessionId}><div className="discovered-item"><BackendAvatar backend={session.backend} small /><div><strong>{session.title || session.nativeSessionId.slice(0, 12)}</strong><small title={session.cwd}>{shortPath(session.cwd)} · {relativeTime(session.lastActivity)}</small><div className="import-item-meta"><code>{session.nativeSessionId.slice(0, 24)}</code>{session.cwdAvailable === false && <span className="import-directory-warning">目录不可用</span>}{!exists && <button type="button" className="text-button" disabled={busy} onClick={() => { setImportDirectory(editingDirectory ? null : { id: session.nativeSessionId, cwd: session.cwd }); setError(''); }}>{editingDirectory ? '收起' : '更换目录'}</button>}</div></div><button className="button secondary small-button" type="button" disabled={busy || exists} onClick={() => void importSession(session)}>{importId === session.nativeSessionId ? <LoaderCircle size={14} className="spin" /> : exists ? <Check size={14} /> : <Plus size={14} />}{exists ? '已添加' : session.cwdAvailable === false && !editingDirectory ? '选择目录' : '添加'}</button></div>{editingDirectory && <div className="import-directory"><DirectoryField label="导入工作目录" value={importDirectory.cwd} onChange={cwd => setImportDirectory({ id: session.nativeSessionId, cwd })} disabled={busy} required={false} help="选择运行 Dili 的机器上的现有目录。历史上下文会保留，原项目文件需要你自行迁移。" /></div>}</div>;
    })}{!!discovered?.length && !filteredDiscovered?.length && <div className="discovery-empty"><Search size={26} /><p>没有匹配的原生会话</p><button type="button" className="text-button" onClick={() => setDiscoverQuery('')}>清除搜索</button></div>}{discoveryError ? <div className="discovery-empty"><p role="alert" className="form-error">{discoveryError}</p><button type="button" className="button secondary" onClick={() => setDiscoveryAttempt(value => value + 1)}>重新发现</button></div> : discovered?.length === 0 && <div className="discovery-empty"><Search size={26} /><p>尚未发现 {BACKEND[backend].short} 会话</p><small>先在原生工具中创建会话，或直接新建联系人。</small></div>}</div></> : <div className="modal-fields">
      {modal.type === 'addMember' && <div className="segmented-control"><button type="button" className={memberMode === 'new' ? 'selected' : ''} onClick={() => setMemberMode('new')}><Plus size={15} /> 新建会话</button><button type="button" className={memberMode === 'fork' ? 'selected' : ''} onClick={() => setMemberMode('fork')}><GitFork size={15} /> 从已有联系人 Fork</button></div>}
      {(modal.type === 'create' || (modal.type === 'addMember' && memberMode === 'new')) && backendPicker}
      {modal.type === 'addMember' && memberMode === 'fork' && <><label className="form-label">来源联系人<select required value={sourceId} onChange={(event) => { setSourceId(event.target.value); const source = state.sessions.find((session) => session.id === event.target.value); if (source) setTitle(`${source.title} · 群组`); }}><option value="">选择要延续的会话…</option>{state.sessions.filter((session) => !session.archived && !!session.nativeSessionId && !session.forkPending && state.backends.find((item) => item.id === session.backend)?.capabilities.fork).map((session) => <option key={session.id} value={session.id}>{session.title} · {BACKEND[session.backend].short}</option>)}</select></label><div className="form-note"><GitFork size={16} />通过后端原生能力 Fork 上下文。群组内的新会话独立运行，外面的原联系人保持不变。</div></>}
      {['create', 'rename', 'fork', 'addMember'].includes(modal.type) && nameField}
      {(modal.type === 'create' || (modal.type === 'addMember' && memberMode === 'new')) && <>{cwdField}<label className="form-label">执行模式<select value={executionMode} disabled={busy} onChange={event => setExecutionMode(event.target.value as ExecutionMode)}><option value="default">原生默认</option><option value="auto" disabled={!backendInfo?.capabilities.autoMode}>Auto · 自动审核</option></select></label><p className="form-note">{executionMode === 'auto' ? AUTO_MODE_NOTE[backend] : '沿用这个工具的原生权限配置。只影响当前联系人。'}</p>{!backendInfo?.capabilities.autoMode && <p className="form-note">所选后端尚未检测到 Auto 支持，请更新后端后刷新检测。</p>}</>}

      {modal.type === 'fork' && <><div className="fork-source"><BackendAvatar backend={modal.session.backend} small /><div><small>来源会话</small><strong>{modal.session.title}</strong></div><GitFork size={18} /></div><label className="form-label">新联系人放在哪里<select value={groupId} onChange={(event) => setGroupId(event.target.value)}><option value="">独立联系人</option>{state.groups.map((group) => <option key={group.id} value={group.id}>群组 · {group.title}</option>)}</select></label>{modal.session.backend === 'dsh' ? <p className="form-note"><CircleHelp size={16} />DeepSeek Harness 的 Fork 由原生界面处理，继续使用原工作目录。</p> : <DirectoryField label="新的工作目录" value={forkCwd} onChange={setForkCwd} disabled={busy} placeholder={modal.session.cwd} help="可沿用来源目录，或选择已有的隔离目录。" />}<p className="form-note"><CircleHelp size={16} />Fork 继承上下文；它不会自动创建 Git 分支或隔离文件。</p></>}
      {modal.type === 'handoff' && <><div className="fork-source"><BackendAvatar backend={modal.session.backend} small /><div><small>来源会话</small><strong>{modal.session.title}</strong></div><ArrowRightLeft size={18} /></div>{backendPicker}<label className="form-label">目标联系人名称<input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={120} /></label><DirectoryField label="工作目录" value={cwd} onChange={setCwd} disabled={busy} help="默认沿用来源会话的工作目录。" /><label className="form-label">交接说明<textarea rows={5} value={handoffSummary} onChange={(event) => setHandoffSummary(event.target.value)} maxLength={12000} /></label><p className="form-note">会自动附加最近对话、来源平台和工作目录；创建后会复制完整交接内容。</p></>}
      {modal.type === 'group' && <><label className="form-label">群组名称<input placeholder="例如：完成登录功能" value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={120} /></label><label className="form-label">共同目标<textarea placeholder="希望完成什么？怎样算完成？" value={goal} onChange={(event) => setGoal(event.target.value)} rows={4} maxLength={4000} /></label><p className="form-note"><UsersRound size={16} />创建后可添加新会话，或将现有联系人 Fork 入群。</p></>}
      {modal.type === 'share' && <><div className="fork-source"><BackendAvatar backend={modal.session.backend} small /><div><small>结果来自</small><strong>{modal.session.title}</strong></div></div><label className="form-label">分享内容<textarea rows={8} required placeholder="粘贴或整理成员的输出、结论与下一步…" value={text} onChange={(event) => setText(event.target.value)} maxLength={30000} /></label><p className="form-note">可以先在终端选中内容，再打开“分享结果”；也可以直接粘贴内容。</p></>}
      {((modal.type === 'create' || (modal.type === 'addMember' && memberMode === 'new')) && !backendInfo?.installed) && <p className="form-error">请先在本机安装所选后端，再到“连接与能力”刷新检测。</p>}
    </div>}
    {error && <p role="alert" className="form-error modal-error">{error}</p>}
    <div className="modal-footer"><button type="button" className="button secondary" disabled={busy} onClick={close}>{modal.type === 'import' ? '完成' : '取消'}</button>{modal.type !== 'import' && <button className="button primary" disabled={busy || ((modal.type === 'create' || (modal.type === 'addMember' && memberMode === 'new') || modal.type === 'handoff') && !backendInfo?.installed)}>{busy ? <LoaderCircle size={15} className="spin" /> : modal.type === 'fork' ? <GitFork size={15} /> : modal.type === 'handoff' ? <ArrowRightLeft size={15} /> : modal.type === 'share' ? <Share2 size={15} /> : modal.type === 'rename' || (modal.type === 'group' && modal.group) ? <Check size={15} /> : <Plus size={15} />}{modal.type === 'rename' || (modal.type === 'group' && modal.group) ? '保存修改' : modal.type === 'fork' ? '创建 Fork' : modal.type === 'handoff' ? '创建并继续' : modal.type === 'group' ? '创建群组' : modal.type === 'share' ? '分享到群组' : modal.type === 'addMember' ? memberMode === 'fork' ? 'Fork 入群' : '添加成员' : '创建联系人'}</button>}</div>
  </form></ModalShell>;
}
