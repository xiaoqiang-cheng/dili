import { useGroupHistory } from './group-history';
import SharePreview from './SharePreview';
import TerminalPane from './TerminalPane';
import { Folder } from 'lucide-react';
import { t } from '../shared/i18n';
import type { Session } from '../shared/types';
import type { ChatAttachment } from '../shared/attachments';
import ImageAttachments from './ImageAttachments';
import VoiceInput, { appendVoiceText } from './VoiceInput';
import GroupImages from './GroupImages';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AuthStatus } from '../shared/auth';
import type { AppState, GroupMessage } from '../shared/types';
import { api } from './api';
import { appUrl } from './urls';
import Markdown from './Markdown';
import './group-chat.css';

type ShareStatus = Extract<AuthStatus, { kind: 'share' }>;
/** Group discussion is shared; only the full tier can open member terminals. */
export default function GroupShareApp({ status }: { status: ShareStatus }) {
  const [state, setState] = useState<AppState | null>(null);
  const [preview, setPreview] = useState(false);
  const [terminal, setTerminal] = useState('');
  const [reconnect, setReconnect] = useState(0);
  const [text, setText] = useState('');
  const [images, setImages] = useState<ChatAttachment[]>([]);
  const [uploading, setUploading] = useState(false), [voiceActive, setVoiceActive] = useState(false);
  const [recipients, setRecipients] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);

  const feed = useRef<HTMLElement>(null);
  const follow = useRef(true);

  const writable = status.mode !== 'read';
  const endpoint = `/groups/${status.groupId}`;
  const group = state?.groups.find(item => item.id === status.groupId);
  const { detail, error: historyError, loadOlder, loadingOlder: older } = useGroupHistory(status.groupId!, group?.updatedAt, reconnect, state?.instanceId);
  useEffect(() => { if (follow.current && feed.current) feed.current.scrollTop = feed.current.scrollHeight; }, [detail?.messages]);
  useEffect(() => {
    let active = true;
    const accept = (next: AppState) => { if (active) setState(previous => previous?.instanceId === next.instanceId && (previous?.revision ?? -1) > (next.revision ?? -1) ? previous : next); };
    void api<AppState>('/state').then(accept).catch(cause => setError(cause.message));
    const events = new EventSource(appUrl('/api/events'));
    events.onopen = () => { setConnected(true); setReconnect(value => value + 1); };
    events.onerror = () => { setConnected(false); void api('/auth/status').then(value => { if ((value as { kind?: string }).kind !== 'share') window.dispatchEvent(new Event('sessiondeck:auth-required')); }).catch(() => {}); };
    events.addEventListener('state', event => { try { accept(JSON.parse((event as MessageEvent).data)); } catch { /* reconnect recovers */ } });
    return () => { active = false; events.close(); };
  }, []);
  const members = state?.sessions ?? [];
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if ((!text.trim() && !images.length) || busy || uploading || voiceActive || !writable) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const message = await api<GroupMessage & { deliveryErrors?: { error: string }[] }>(`${endpoint}/messages`, {
        attachments: images.map(item => item.id), text: text.trim(), kind: recipients.length ? 'task' : 'note', recipientIds: recipients, deliverNow: true,
      });
      setReconnect(value => value + 1);
      setText(''); setImages([]); setRecipients([]);
      if (message.deliveryErrors?.length) setNotice(`消息已保存，部分任务未送达：${message.deliveryErrors.map(item => item.error).join('；')}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '发送失败'); }
    finally { setBusy(false); }
  };
  const workspaceSession = { id: status.groupId!, cwd: group?.workspace ?? '', title: group?.title ?? '' } as Session;
  return <main className="app-shell share-shell group-share-shell">
    <header className="share-topbar"><div className="share-heading"><h1>{detail?.group.title ?? '共享群聊'}</h1><p>{detail?.group.goal}</p></div>
      <span className="share-role">{t(`share.${status.mode}`)} · {status.name} · {connected ? '已连接' : '重连中'}</span>
      <button className="button secondary small-button" onClick={() => void api('/auth/logout', {}).finally(() => location.reload())}>退出共享</button>
      {writable && <button className="icon-button" title={t('share.files')} onClick={() => setPreview(value => !value)}><Folder size={16} /></button>}
      {status.mode === 'full' && <select aria-label="原生终端" value={terminal} onChange={event => setTerminal(event.target.value)}><option value="">原生终端</option>{members.map(member => <option key={member.id} value={member.id}>{member.title}</option>)}</select>}
    </header>
    <div className="share-group-body"><div className="share-group-main">
    {(error || historyError) && <p role="alert" className="form-error">{error || historyError}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="group-member-strip" aria-label="群成员">{members.map(member => <span className="group-member-chip" key={member.id}>{member.title} · {member.running ? '运行中' : '未运行'}</span>)}</div>
    <section ref={feed} onScroll={() => { const node = feed.current; if (node) follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; }} aria-label="群消息" style={{ flex: 1, overflow: 'auto', padding: '16px' }}>
      {detail?.page?.before != null && <button className="button secondary" disabled={older} onClick={() => void loadOlder()}>加载更早消息</button>}
      {!detail && <p>正在加载群聊…</p>}
      {detail?.messages.map(message => <article key={message.id} className="group-share-message">
        <strong>{message.senderName}</strong> <time>{new Date(message.createdAt).toLocaleString()}</time>
        {!!message.recipientIds.length && <p>{message.recipientIds.map(id => `@${members.find(member => member.id === id)?.title ?? '群成员'}`).join(' ')}</p>}
        <GroupImages groupId={status.groupId!} items={message.attachments} /><Markdown text={message.text} />
      </article>)}
    </section>
    {writable ? <form onSubmit={submit} style={{ padding: '16px' }}>
      <fieldset disabled={busy}><legend>分派给成员（不选则发送群消息）</legend>{members.map(member => <label key={member.id} style={{ marginRight: 12 }}><input type="checkbox" checked={recipients.includes(member.id)} onChange={event => setRecipients(current => event.target.checked ? [...current, member.id] : current.filter(id => id !== member.id))} />@{member.title}</label>)}</fieldset>
      <ImageAttachments sessionId={status.groupId!} scope="groups" actions={<><VoiceInput sessionId={status.groupId!} scope="groups" disabled={busy || uploading} onActive={setVoiceActive} insert={speech => setText(current => appendVoiceText(current, speech))} />
      <button className="button primary" disabled={busy || uploading || voiceActive || (!text.trim() && !images.length)}>{busy ? '发送中…' : recipients.length ? '发送并分派' : '发送'}</button></>} items={images} onChange={setImages} onBusy={setUploading} disabled={busy}>
      <textarea disabled={busy} aria-label="群消息内容" placeholder="输入群消息或任务…" value={text} maxLength={30000} rows={3} onChange={event => setText(event.target.value)} style={{ width: '100%' }} />
      </ImageAttachments>

    </form> : <p className="form-note" style={{ padding: 16 }}>这是只读分享，可以查看群聊进展。</p>}
    {terminal && status.mode === 'full' && <div className="share-group-terminal"><TerminalPane sessionId={terminal} onSelection={() => {}} running={!!members.find(member => member.id === terminal)?.running} /></div>}
    </div>{preview && writable && <SharePreview key={status.groupId} session={workspaceSession} groupId={status.groupId} close={() => setPreview(false)} />}</div>
  </main>;
}
