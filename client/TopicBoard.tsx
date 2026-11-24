import { useMemo, useState, type FormEvent } from 'react';
import { Archive, ArchiveRestore, ChevronDown, ChevronRight, GitFork, Hash, LoaderCircle, Pin, PinOff, Plus, Search, Trash2 } from 'lucide-react';
import type { AppState, Backend, Group, GroupMessage, Session } from '../shared/types';
import { api } from './api';
import { BACKEND, BackendAvatar } from './App';
import DirectoryField from './DirectoryField';
import ModalShell from './Modal';
import { t } from '../shared/i18n';
import { canJoinTopic, forkTitle, topicCategories, topicPreview } from './topics';
import './topics.css';

const FOLDED_KEY = 'dili.topics.folded';
const readFolded = () => { try { const value = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '[]'); return new Set<string>(Array.isArray(value) ? value.filter(item => typeof item === 'string') : []); } catch { return new Set<string>(); } };

/** The topic board's channel sidebar: `# name` rows grouped by the working
 * directory of their participants, like a server's categories. The active
 * channel lists its participants, which are also ordinary contacts. */
export function TopicList({ topics, sessions, activeId, showArchived, setShowArchived, query, open, openSession, publish, pin, archive }: {
  topics: Group[]; sessions: Session[]; activeId: string | null; showArchived: boolean; setShowArchived: (value: boolean) => void; query: string;
  open: (id: string) => void; openSession: (session: Session) => void; publish: () => void; pin: (topic: Group) => void; archive: (topic: Group) => void;
}) {
  const [folded, setFolded] = useState(readFolded);
  const toggle = (key: string) => setFolded(current => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    try { localStorage.setItem(FOLDED_KEY, JSON.stringify([...next])); } catch { /* folding is a convenience */ }
    return next;
  });
  const needle = query.trim().toLowerCase();
  const shown = useMemo(() => topics.filter(topic => !!topic.archived === showArchived
    && `${topic.title} ${topic.goal} ${topic.lastMessage?.text ?? ''}`.toLowerCase().includes(needle)), [topics, showArchived, needle]);
  const categories = useMemo(() => topicCategories(shown, sessions), [shown, sessions]);
  const archivedCount = topics.filter(topic => topic.archived).length;
  return <div className="topic-board">
    <div className="topic-board-head">
      <h2><Hash size={16} />{t('topic.board')}</h2>
      <button className="icon-button" aria-label={t('topic.publish')} title={t('topic.publish')} onClick={publish}><Plus size={16} /></button>
    </div>
    {categories.length ? <nav className="topic-channels" aria-label={t(showArchived ? 'topic.archivedList' : 'topic.list')}>{categories.map(category => {
      // A search or the active channel always shows through a folded category.
      const closed = folded.has(category.key) && !needle;
      const rows = closed ? category.topics.filter(topic => topic.id === activeId || !!topic.unread) : category.topics;
      return <section key={category.key} className="topic-category">
        <button className="topic-category-head" aria-expanded={!closed} title={category.path || undefined} aria-label={t(closed ? 'topic.expand' : 'topic.collapse', { name: category.label })} onClick={() => toggle(category.key)}>{closed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}<span>{category.label}</span></button>
        <ul>{rows.map(topic => {
          const members = sessions.filter(session => session.groupId === topic.id && !session.archived);
          const active = topic.id === activeId;
          const working = members.some(member => member.status === 'running');
          const waiting = members.some(member => !member.archived && member.unread > 0 && (member.status === 'waiting_approval' || member.status === 'error'));
          return <li key={topic.id} className={`topic-channel${active ? ' active' : ''}${topic.unread ? ' unread' : ''}`}>
            <button className="topic-channel-main" aria-current={active ? 'true' : undefined} title={topicPreview(topic)} onClick={() => open(topic.id)}>
              <Hash size={15} className="topic-channel-hash" aria-hidden="true" />
              <span className="topic-channel-name">{topic.title}</span>
              {topic.pinned && <Pin size={11} className="topic-channel-pin" aria-label={t('topic.unpin')} />}
              {working && <i className="topic-channel-working" title={t('topic.working')} aria-label={t('topic.working')} />}
              {waiting && <i className="topic-channel-waiting" aria-hidden="true" />}
              {!!topic.unread && <b className="topic-channel-unread" aria-label={t('topic.newReplies', { count: topic.unread })}>{topic.unread > 99 ? '99+' : topic.unread}</b>}
            </button>
            <span className="topic-channel-actions">
              <button className="icon-button" aria-label={t(topic.pinned ? 'topic.unpin' : 'topic.pin')} title={t(topic.pinned ? 'topic.unpin' : 'topic.pin')} onClick={() => pin(topic)}>{topic.pinned ? <PinOff size={12} /> : <Pin size={12} />}</button>
              <button className="icon-button" aria-label={t(topic.archived ? 'topic.restore' : 'topic.archive')} title={t(topic.archived ? 'topic.restore' : 'topic.archive')} onClick={() => archive(topic)}>{topic.archived ? <ArchiveRestore size={12} /> : <Archive size={12} />}</button>
            </span>
            {active && members.length > 0 && <ul className="topic-channel-members" aria-label={t('topic.members', { count: members.length })}>{members.map(member => <li key={member.id}><button onClick={() => openSession(member)} title={t('topic.openSession', { name: member.title })}><BackendAvatar backend={member.backend} small /><span className="topic-channel-member-name">{member.title}</span>{member.status === 'running' && <i className="topic-channel-working" aria-hidden="true" />}</button></li>)}</ul>}
          </li>;
        })}</ul>
      </section>;
    })}</nav> : <div className="topic-empty">{needle ? <><Search size={24} /><p>{t('topic.noMatch')}</p></> : showArchived ? <p>{t('topic.noArchived')}</p> : <><Hash size={28} /><h3>{t('topic.firstTitle')}</h3><p>{t('topic.firstNote')}</p><button className="button primary small-button" onClick={publish}><Plus size={14} />{t('topic.publish')}</button></>}</div>}
    {(archivedCount > 0 || showArchived) && <button className="text-button topic-archive-toggle" onClick={() => setShowArchived(!showArchived)}><Archive size={13} />{showArchived ? t('topic.backToList') : t('topic.archivedCount', { count: archivedCount })}</button>}
  </div>;
}

type NewParticipant = { key: string; backend: Backend; title: string; cwd: string };
export type TopicDialogMode = { type: 'create' } | { type: 'add'; topic: Group } | { type: 'edit'; topic: Group };

/** Publish a topic, add participants to one, or edit its title and post.
 * Existing contacts join as forks: their own chat continues untouched. */
export function TopicDialog({ mode, state, close, done, notify }: { mode: TopicDialogMode; state: AppState; close: () => void; done: (topic: Group, errors: string[]) => void; notify: (text: string) => void }) {
  const topic = mode.type === 'create' ? undefined : mode.topic;
  const [title, setTitle] = useState(topic?.title ?? '');
  const [body, setBody] = useState(topic?.goal ?? '');
  const [picked, setPicked] = useState<string[]>([]);
  const [fresh, setFresh] = useState<NewParticipant[]>([]);
  const [filter, setFilter] = useState('');
  const [respond, setRespond] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const installed = state.backends.filter(backend => backend.installed);
  const recentDirectory = useMemo(() => [...state.sessions].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity)).find(session => session.cwd)?.cwd ?? state.defaultCwd, [state.sessions, state.defaultCwd]);
  const candidates = useMemo(() => state.sessions.filter(session => !session.archived && session.groupId !== topic?.id)
    .filter(session => `${session.title} ${session.cwd}`.toLowerCase().includes(filter.trim().toLowerCase()))
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity)), [state.sessions, topic?.id, filter]);
  const addFresh = () => setFresh(current => [...current, { key: crypto.randomUUID(), backend: installed[0]?.id ?? 'claude', title: '', cwd: recentDirectory }]);
  const editing = mode.type === 'edit';
  const participants = picked.length + fresh.length;

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError('');
    if (fresh.some(item => !item.title.trim() || !item.cwd.trim())) { setError(t('topic.missingNew')); return; }
    setBusy(true);
    try {
      if (editing) {
        const updated = await api<Group>(`/groups/${topic!.id}`, { title: title.trim() }, 'PATCH');
        done(updated, []); return;
      }
      const target = topic ?? await api<Group>('/groups', { kind: 'topic', title: title.trim(), goal: body.trim() });
      const joined: Session[] = [], errors: string[] = [];
      // Each participant joins independently; one that cannot fork does not stop the rest.
      for (const id of picked) {
        const source = state.sessions.find(session => session.id === id)!;
        try { joined.push(await api<Session>(`/sessions/${id}/fork`, { title: forkTitle(source.title, target.title), groupId: target.id, placement: 'directory', briefing: 'none' })); }
        catch (cause) { errors.push(`${source.title}：${cause instanceof Error ? cause.message : t('topic.forkFailed')}`); }
      }
      for (const item of fresh) {
        try { joined.push(await api<Session>('/sessions', { backend: item.backend, title: item.title.trim(), cwd: item.cwd.trim(), groupId: target.id, placement: 'directory', briefing: 'none' })); }
        catch (cause) { errors.push(`${item.title.trim()}：${cause instanceof Error ? cause.message : t('topic.createFailed')}`); }
      }
      // The opening post is the topic's first message; a late joiner is asked to catch up.
      const text = topic ? t('topic.lateJoin') : body.trim() || title.trim();
      if (!topic || (respond && joined.length)) {
        const result = await api<GroupMessage & { deliveryErrors?: { sessionId: string; error: string }[] }>(`/groups/${target.id}/messages`, { text, kind: joined.length ? 'task' : 'note', recipientIds: joined.map(session => session.id), deliverNow: joined.length > 0 });
        for (const failure of result.deliveryErrors ?? []) errors.push(`${joined.find(session => session.id === failure.sessionId)?.title ?? t('topic.someone')}：${failure.error}`);
      }
      if (topic && joined.length) notify(t('topic.joined', { count: joined.length }));
      done(target, errors);
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('topic.failed')); }
    finally { setBusy(false); }
  };

  const heading = t(mode.type === 'create' ? 'topic.publish' : mode.type === 'add' ? 'topic.add' : 'topic.edit');
  const subtitle = t(mode.type === 'create' ? 'topic.publishNote' : mode.type === 'add' ? 'topic.addNote' : 'topic.editNote');
  return <ModalShell title={heading} subtitle={subtitle} close={busy ? () => {} : close} wide={mode.type !== 'edit'}><form className="topic-dialog" onSubmit={submit}>
    {mode.type !== 'add' && <>
      <label className="form-label">{t('topic.title')}<input autoFocus value={title} onChange={event => setTitle(event.target.value)} maxLength={120} required placeholder={t('topic.titlePlaceholder')} /></label>
      {!editing && <label className="form-label">{t('topic.body')}<textarea value={body} onChange={event => setBody(event.target.value)} maxLength={30000} rows={6} placeholder={t('topic.bodyPlaceholder')} /></label>}
    </>}
    {!editing && <fieldset className="topic-participant-picker">
      <legend>{participants ? t('topic.picked', { count: participants }) : t('topic.picker')}</legend>
      <label className="search-field"><Search size={14} /><input aria-label={t('topic.searchContacts')} placeholder={t('topic.searchContacts')} value={filter} onChange={event => setFilter(event.target.value)} /></label>
      <ul className="topic-candidates">{candidates.slice(0, 60).map(session => {
        const check = canJoinTopic(session, state.backends);
        const on = picked.includes(session.id);
        return <li key={session.id}><label className={check.ok ? '' : 'disabled'} title={check.ok ? t('topic.forkInto', { name: session.title }) : check.reason}>
          <input type="checkbox" disabled={!check.ok || busy} checked={on} onChange={() => setPicked(current => on ? current.filter(id => id !== session.id) : [...current, session.id])} />
          <BackendAvatar backend={session.backend} small /><span className="topic-candidate-name"><strong>{session.title}</strong><small>{check.ok ? session.cwd : check.reason}</small></span>{check.ok && <GitFork size={13} className="topic-fork-mark" />}
        </label></li>;
      })}{!candidates.length && <li className="topic-candidates-empty">{t('topic.noCandidates')}</li>}</ul>
      {fresh.map(item => <div className="topic-new-participant" key={item.key}>
        <select aria-label={t('topic.backend')} value={item.backend} onChange={event => setFresh(current => current.map(entry => entry.key === item.key ? { ...entry, backend: event.target.value as Backend } : entry))}>{installed.map(backend => <option key={backend.id} value={backend.id}>{BACKEND[backend.id].short}</option>)}</select>
        <input aria-label={t('topic.newName')} placeholder={t('topic.newNamePlaceholder')} value={item.title} maxLength={120} onChange={event => setFresh(current => current.map(entry => entry.key === item.key ? { ...entry, title: event.target.value } : entry))} />
        <button type="button" className="icon-button" aria-label={t('topic.removeNew')} onClick={() => setFresh(current => current.filter(entry => entry.key !== item.key))}><Trash2 size={14} /></button>
        <DirectoryField label={t('topic.directory')} value={item.cwd} onChange={cwd => setFresh(current => current.map(entry => entry.key === item.key ? { ...entry, cwd } : entry))} disabled={busy} />
      </div>)}
      <button type="button" className="text-button" disabled={!installed.length || busy} onClick={addFresh}><Plus size={13} />{t('topic.addNew')}</button>
      {mode.type === 'add' && <label className="checkbox-row"><input type="checkbox" checked={respond} onChange={event => setRespond(event.target.checked)} /><span>{t('topic.respond')}<small>{t('topic.respondNote')}</small></span></label>}
      {mode.type === 'create' && !participants && <p className="form-note">{t('topic.later')}</p>}
    </fieldset>}
    {error && <p role="alert" className="form-error">{error}</p>}
    <div className="modal-footer"><button type="button" className="button secondary" disabled={busy} onClick={close}>{t('topic.cancel')}</button><button className="button primary" disabled={busy || (mode.type === 'add' && !participants)}>{busy && <LoaderCircle size={14} className="spin" />}{t(mode.type === 'create' ? 'topic.submitCreate' : mode.type === 'add' ? 'topic.submitAdd' : 'topic.submitEdit')}</button></div>
  </form></ModalShell>;
}
