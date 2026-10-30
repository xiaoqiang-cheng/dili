import { Archive, Ellipsis, Pin, PinOff, Settings2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Group, Session } from '../shared/types';
import { BackendAvatar, relativeTime } from './App';
import './group-chat.css';

/** WeChat-style group avatar: member avatars tiled 2×2 or 3×3, with a group mark. */
export function GroupAvatar({ members, small = false }: { members: Session[]; small?: boolean }) {
  const shown = members.slice(0, 9);
  const columns = shown.length <= 1 ? 1 : shown.length <= 4 ? 2 : 3;
  return <span className={`group-avatar${small ? ' small' : ''}`} aria-hidden="true">
    <span className="group-avatar-grid" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
      {shown.length ? shown.map(member => <BackendAvatar key={member.id} backend={member.backend} small />) : <span className="group-avatar-empty" />}
    </span>
    <span className="group-avatar-mark">群</span>
  </span>;
}

/** Actionable member reminders affect attention sorting, not the group's message
 * unread count. Reading group replies does not resolve an approval or error. */
export const memberNeedsAction = (member: Session) => !member.archived && member.unread > 0 && (member.status === 'waiting_approval' || member.status === 'error');
export const groupNeedsAttention = (group: Group, members: Session[]) => (group.unread ?? 0) > 0 || members.some(memberNeedsAction);

export default function GroupCard({ group, members, active, onOpen, onPin, onEdit, onArchive }: {
  group: Group; members: Session[]; active: boolean; onOpen: () => void; onPin: () => void; onEdit: () => void; onArchive: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menu]);
  const live = members.filter(member => !member.archived);
  const unread = group.unread ?? 0;
  const errors = live.filter(member => member.status === 'error').length;
  const approvals = live.filter(member => member.status === 'waiting_approval').length;
  const running = live.filter(member => member.status === 'running').length;
  const status = [errors && `异常 ${errors}`, approvals && `待审批 ${approvals}`, running && `执行中 ${running}`].filter(Boolean).join(' · ');
  const preview = group.lastMessage ? `${group.lastMessage.senderName}：${group.lastMessage.text}` : group.goal || `${live.length} 位成员`;
  return <article className={`session-card group-card${active ? ' active' : ''}${group.archived ? ' archived-card' : ''}`} onClick={event => { if (!(event.target as Element).closest('button, .dropdown-menu')) onOpen(); }}>
    {group.pinned && <button className="icon-button card-pin pinned" aria-label={`取消置顶 ${group.title}`} title="取消置顶" onClick={onPin}><PinOff size={13} /></button>}
    <div className="card-head">
      <span className="avatar-wrap"><GroupAvatar members={live} />{unread > 0 && <span className="unread-badge" aria-label={`${unread} 条未读`}>{unread > 99 ? '99+' : unread}</span>}</span>
      <div className="card-title">
        <div className="card-title-row"><button className="card-main" aria-current={active ? 'true' : undefined} aria-label={`进入群聊 ${group.title}`} onClick={onOpen}><h3 title={group.title}>{group.title}</h3></button><span className="group-badge">{group.archived ? '已归档' : '群聊'} · {live.length}</span></div>
        <div className="card-prompt"><p title={preview}>{preview}</p></div>
      </div>
      {status && <span className="card-state"><span className={`status-badge ${errors ? 'error' : approvals ? 'waiting' : 'running'}`} title={status}>{status}</span></span>}
    </div>
    <div className="card-activity"><time dateTime={group.lastMessage?.at ?? group.updatedAt}>{relativeTime(group.lastMessage?.at ?? group.updatedAt)}</time>
      <span className="card-menu-anchor" ref={menuRef}><button className="icon-button" aria-label={`${group.title} 的更多操作`} aria-expanded={menu} onClick={() => setMenu(!menu)}><Ellipsis size={15} /></button>
        {menu && <div className="dropdown-menu"><button onClick={() => { setMenu(false); onPin(); }}>{group.pinned ? <PinOff size={14} /> : <Pin size={14} />}{group.pinned ? '取消置顶' : '置顶群聊'}</button><button onClick={() => { setMenu(false); onEdit(); }}><Settings2 size={14} />群设置</button><span /><button onClick={() => { setMenu(false); onArchive(); }}><Archive size={14} />{group.archived ? '恢复群聊' : '归档群聊'}</button></div>}
      </span>
    </div>
  </article>;
}
