import { useGroupHistory } from './group-history';
import SharePreview from './SharePreview';
import TerminalPane from './TerminalPane';
import { AtSign, Folder, LogOut, Send, Users, X } from 'lucide-react';
import { BackendAvatar, BrandMark } from './App';
import { hasShareMention, shareMentionAt } from './share-mentions';
import { t } from '../shared/i18n';
import type { Session } from '../shared/types';
import type { ChatAttachment } from '../shared/attachments';
import ImageAttachments from './ImageAttachments';
import VoiceInput, { appendVoiceText } from './VoiceInput';
import GroupImages from './GroupImages';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
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

  const composer = useRef<HTMLTextAreaElement>(null);
  const menuId = useId();
  const [mention, setMention] = useState<ReturnType<typeof shareMentionAt>>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [membersOpen, setMembersOpen] = useState(false);
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
  const activeRecipients = recipients.filter(id => members.some(member => member.id === id && hasShareMention(text, member.title)));
  const choices = mention ? members.filter(member => !member.archived && member.title.toLowerCase().includes(mention.query.toLowerCase())) : [];
  const selectedIndex = Math.min(mentionIndex, Math.max(0, choices.length - 1));
  const updateText = (value: string, caret: number) => {
    setText(value); setMention(shareMentionAt(value, caret)); setMentionIndex(0);
    setRecipients(current => current.filter(id => members.some(member => member.id === id && hasShareMention(value, member.title))));
  };
  const choose = (member: Session) => {
    const start = mention?.start ?? composer.current?.selectionStart ?? text.length;
    const end = mention?.end ?? start;
    const token = `@${member.title} `;
    setText(text.slice(0, start) + token + text.slice(end));
    setRecipients(current => current.includes(member.id) ? current : [...current, member.id]);
    setMention(null);
    requestAnimationFrame(() => { composer.current?.focus(); composer.current?.setSelectionRange(start + token.length, start + token.length); });
  };
  useEffect(() => { document.getElementById(`${menuId}-${selectedIndex}`)?.scrollIntoView({ block: 'nearest' }); }, [menuId, selectedIndex, mention?.query]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if ((!text.trim() && !images.length) || busy || uploading || voiceActive || !writable) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const message = await api<GroupMessage & { deliveryErrors?: { error: string }[] }>(`${endpoint}/messages`, {
        attachments: images.map(item => item.id), text: text.trim(), kind: activeRecipients.length ? 'task' : 'note', recipientIds: activeRecipients, deliverNow: true,
      });
      setReconnect(value => value + 1);
      setText(''); setImages([]); setRecipients([]); setMention(null);
      if (message.deliveryErrors?.length) setNotice(`消息已保存，部分任务未送达：${message.deliveryErrors.map(item => item.error).join('；')}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '发送失败'); }
    finally { setBusy(false); }
  };
  const workspaceSession = { id: status.groupId!, cwd: group?.workspace ?? '', title: group?.title ?? '' } as Session;
  return <main className="app-shell share-shell group-share-shell">
    <header className="share-topbar">
      <span className="brand-mark"><BrandMark size={17} /></span>
      <div className="share-heading"><h1>{detail?.group.title ?? t('share.groupTitle')}</h1></div>
      <span className="share-role" title={status.name}>{t(`share.${status.mode}`)}<span className="share-guest-name"> · {status.name}</span></span>
      <span className="connection-indicator" title={connected ? t('share.connected') : t('share.reconnecting')}><span className={`connection-dot ${connected ? 'online' : ''}`} /></span>
      <button className={`icon-button ${membersOpen ? 'active' : ''}`} aria-label={t('share.members')} title={t('share.members')} aria-expanded={membersOpen} onClick={() => setMembersOpen(value => !value)}><Users size={16} /></button>
      {writable && <button className={`icon-button ${preview ? 'active' : ''}`} title={t('share.files')} onClick={() => setPreview(value => !value)}><Folder size={16} /></button>}
      {status.mode === 'full' && <select aria-label="原生终端" value={terminal} onChange={event => setTerminal(event.target.value)}><option value="">原生终端</option>{members.map(member => <option key={member.id} value={member.id}>{member.title}</option>)}</select>}
      <button className="icon-button" aria-label={t('share.logout')} title={t('share.logout')} onClick={() => void api('/auth/logout', {}).finally(() => location.reload())}><LogOut size={16} /></button>
    </header>
    <div className="share-group-body"><div className="share-group-main">
    {(error || historyError) && <p role="alert" className="form-error">{error || historyError}</p>}
    {notice && <div className="share-notice" role="status"><span>{notice}</span><button type="button" className="icon-button" aria-label={t('common.close')} onClick={() => setNotice('')}><X size={14} /></button></div>}
    {membersOpen && <div className="share-group-details">{detail?.group.goal && <p>{detail.group.goal}</p>}<div className="share-member-list" aria-label={t('share.members')}>{members.map(member => <button type="button" className="share-member-item" disabled={!writable || busy || member.archived} key={member.id} onClick={() => { choose(member); setMembersOpen(false); }}><BackendAvatar backend={member.backend} small /><span>{member.title}<small>{member.running ? t('share.running') : t('share.stopped')}</small></span></button>)}</div></div>}
    <section ref={feed} className="group-timeline share-group-timeline" onScroll={() => { const node = feed.current; if (node) follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; }} aria-label="群消息">
      {detail?.page?.before != null && <button className="button secondary" disabled={older} onClick={() => void loadOlder()}>加载更早消息</button>}
      {!detail && <p>正在加载群聊…</p>}
      {detail?.messages.map(message => {
        const sender = members.find(member => member.id === message.senderId);
        return <article key={message.id} className={`group-message kind-${message.kind}${!message.senderId && message.senderName === status.name ? ' mine' : ''}`}>
          <span className="message-avatar">{sender ? <BackendAvatar backend={sender.backend} small /> : message.senderName.slice(0, 1)}</span>
          <div className="message-body"><div className="message-heading"><strong>{message.senderName}</strong><time>{new Date(message.createdAt).toLocaleString()}</time></div>
          {!!message.recipientIds.length && <div className="share-message-recipients">{message.recipientIds.map(id => `@${members.find(member => member.id === id)?.title ?? t('share.member')}`).join(' ')}</div>}
          <div className="bubble"><GroupImages groupId={status.groupId!} items={message.attachments} /><Markdown text={message.text} /></div></div>
        </article>;
      })}
    </section>
    {writable ? <form onSubmit={submit} className="message-composer group-composer share-group-composer">
      {activeRecipients.length > 0 && <div className="composer-references">{activeRecipients.map(id => { const member = members.find(item => item.id === id)!; return <span className="reference-chip" key={id}>@{member.title}<button type="button" className="icon-button" aria-label={t('share.unassign', { name: member.title })} onClick={() => { setRecipients(current => current.filter(item => item !== id)); }}><X size={12} /></button></span>; })}</div>}
      {choices.length > 0 && <div id={menuId} className="mention-menu" role="listbox" aria-label={t('share.pickMember')}>{choices.map((member, index) => <button type="button" role="option" id={`${menuId}-${index}`} aria-selected={index === selectedIndex} key={member.id} onMouseEnter={() => setMentionIndex(index)} onMouseDown={event => event.preventDefault()} onClick={() => choose(member)}><BackendAvatar backend={member.backend} small />{member.title}</button>)}</div>}
      <ImageAttachments sessionId={status.groupId!} scope="groups" actions={<><button type="button" className="icon-button" disabled={busy} title={t('share.pickMember')} aria-label={t('share.pickMember')} onClick={() => { const field = composer.current; const caret = field?.selectionStart ?? text.length; updateText(text.slice(0, caret) + '@' + text.slice(field?.selectionEnd ?? caret), caret + 1); requestAnimationFrame(() => { field?.focus(); field?.setSelectionRange(caret + 1, caret + 1); }); }}><AtSign size={16} /></button><VoiceInput sessionId={status.groupId!} scope="groups" disabled={busy || uploading} onActive={setVoiceActive} insert={speech => setText(current => appendVoiceText(current, speech))} />
      <button className="button primary" disabled={busy || uploading || voiceActive || (!text.trim() && !images.length)}><Send size={14} />{busy ? t('share.sending') : activeRecipients.length ? t('share.sendTask') : t('share.send')}</button></>} items={images} onChange={setImages} onBusy={setUploading} disabled={busy}>
      <textarea ref={composer} disabled={busy} aria-label="群消息内容" placeholder={t('share.composerHint')} value={text} maxLength={30000} rows={3}
        aria-controls={choices.length ? menuId : undefined} aria-activedescendant={choices.length ? `${menuId}-${selectedIndex}` : undefined}
        onChange={event => updateText(event.target.value, event.target.selectionStart)}
        onClick={event => { const field = event.currentTarget; setMention(shareMentionAt(field.value, field.selectionStart)); }}
        onBlur={event => { if (!(event.relatedTarget instanceof Element) || !event.relatedTarget.closest('.mention-menu')) setMention(null); }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (choices.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setMentionIndex((selectedIndex + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length); return; }
          if (choices.length && !event.shiftKey && ['Enter', 'Tab'].includes(event.key)) { event.preventDefault(); choose(choices[selectedIndex]); return; }
          if (event.key === 'Escape' && mention) { event.preventDefault(); setMention(null); return; }
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
        }} />
      </ImageAttachments>

    </form> : <p className="share-read-note">{t('share.readOnly')}</p>}
    {terminal && status.mode === 'full' && <div className="share-group-terminal"><TerminalPane sessionId={terminal} onSelection={() => {}} running={!!members.find(member => member.id === terminal)?.running} /></div>}
    </div>{preview && writable && <SharePreview key={status.groupId} session={workspaceSession} groupId={status.groupId} close={() => setPreview(false)} />}</div>
  </main>;
}
