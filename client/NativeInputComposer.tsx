import './chat-presentation.css';
import { useEffect, useRef, useState } from 'react';
import type { Session } from '../shared/types';
import type { ChatAttachment } from '../shared/attachments';
import { api, ApiError } from './api';
import ImageAttachments from './ImageAttachments';
import Markdown from './Markdown';
import ResizableComposer from './ResizableComposer';
import VoiceInput, { appendVoiceText } from './VoiceInput';
import { Plus } from 'lucide-react';
import { useAutoGrow, useCompactLayout } from './useCompactLayout';
import MessageQueue, { readQueue, type QueuedMessage } from './MessageQueue';
import './attachments.css';

type Sent = { text: string; attachments: string[]; queueId?: string };
type Draft = { text: string; attachments: ChatAttachment[]; pending?: string; pendingMessage?: Sent; queue?: QueuedMessage[] };
type NativeInputState = { generation: string | null; directSubmit?: boolean; submission?: { status: string; error?: string } | null };
const key = (id: string) => 'dili.native-input-draft.' + id;
const messageId = () => typeof crypto.randomUUID==='function' ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)),value=>value.toString(16).padStart(2,'0')).join('');
function read(id: string, backend?: string): Draft {
  // Claude previously used the stream-json composer. Preserve its latest draft,
  // uploads and uncertain receipt, but pause queues bound to the old process.
  try {
    const legacyKey = 'sessiondeck.codex-chat-draft.' + id;
    const legacy = backend === 'claude' ? JSON.parse(sessionStorage.getItem(legacyKey) || 'null') : null;
    if (legacy && typeof legacy.text === 'string') {
      const attachments: ChatAttachment[] = Array.isArray(legacy.attachments) ? legacy.attachments.filter((item: ChatAttachment) => typeof item?.id === 'string' && typeof item.name === 'string').slice(0,8) : [];
      const pending = legacy.pending;
      const migrated: Draft = { text: legacy.text.slice(0,30000), attachments, queue: readQueue(legacy.queue).map(item => ({ ...item, paused: true })),
        ...(typeof pending?.requestId === 'string' && typeof pending.text === 'string' ? { pending: pending.requestId, pendingMessage: { text: pending.text, attachments: Array.isArray(pending.attachments) ? pending.attachments.filter((item: ChatAttachment) => typeof item?.id === 'string').map((item: ChatAttachment) => item.id) : [], queueId: pending.queueId } } : {}),
      };
      sessionStorage.setItem(key(id), JSON.stringify(migrated));
      sessionStorage.removeItem(legacyKey);
      return migrated;
    }
  } catch { /* Keep the original draft if migration cannot be saved. */ }
  try { const value = JSON.parse(sessionStorage.getItem(key(id)) || 'null'); if (value && typeof value.text === 'string') return { text:value.text.slice(0,30000), attachments:Array.isArray(value.attachments) ? value.attachments.filter((item: ChatAttachment)=>item && typeof item.id === 'string' && typeof item.name === 'string').slice(0,8) : [], queue:readQueue(value.queue), ...(typeof value.pending === 'string' ? {pending:value.pending} : {}), ...(value.pendingMessage && typeof value.pendingMessage.text === 'string' && Array.isArray(value.pendingMessage.attachments) ? {pendingMessage:value.pendingMessage} : {}) }; } catch { /* invalid drafts are ignored */ }
  return {text:'',attachments:[]};
}
export default function NativeInputComposer({session,onTerminal,onSent,onActivityChange,onPendingChange}: {
  session:Session;onTerminal():void;onSent?():void;
  onActivityChange?(phase:'sending'|'accepted'|null):void;
  /** Keep a visible user bubble while native receipt is still in flight. */
  onPendingChange?(pending: { text: string } | null):void;
}) {
  const [voiceActive,setVoiceActive] = useState(false);
  const [draft,setDraft] = useState(() => read(session.id, session.backend));
  const [busy,setBusy] = useState(false), [uploading,setUploading] = useState(false), [preview,setPreview] = useState(false), [error,setError] = useState('');
  const latest = useRef(draft); latest.current = draft;
  const active = useRef(true);
  const sending = useRef(false);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const compact = useCompactLayout();
  useEffect(() => {
    active.current = true;
    const refresh = (event: Event) => { if ((event as CustomEvent).detail?.id === session.id) { const value = read(session.id); latest.current = value; setDraft(value); onPendingChange?.(value.pendingMessage ? { text: value.pendingMessage.text } : null); } };
    window.addEventListener('dili:native-draft', refresh);
    const initial = latest.current;
    onPendingChange?.(initial.pendingMessage ? { text: initial.pendingMessage.text } : null);
    return () => {active.current = false; window.removeEventListener('dili:native-draft', refresh); onPendingChange?.(null);};
  },[session.id]);
  function update(value: Draft) {
    let saved = true;
    try { sessionStorage.setItem(key(session.id),JSON.stringify(value)); } catch { saved = false; if (active.current) setError('无法保存草稿，请检查浏览器存储权限'); }
    if (!saved) return false;
    latest.current = value;
    if (active.current) setDraft(value);
    else window.dispatchEvent(new CustomEvent('dili:native-draft', {detail: {id: session.id}}));
    return saved;
  }
  function complete(pending: string, sent: Sent) {
    const current = active.current ? latest.current : read(session.id);
    if (current.pending !== pending) return;
    update({text:!sent.queueId && current.text === sent.text ? '' : current.text, attachments:sent.queueId ? current.attachments : current.attachments.filter(item=>!sent.attachments.includes(item.id)), queue:current.queue?.filter(item=>item.id!==sent.queueId)});
    // Keep the optimistic bubble until conversation history confirms the text.
    if (active.current) { onActivityChange?.('accepted'); onSent?.(); }
  }
  useAutoGrow(fieldRef, draft.text, compact);
  const canSend = !voiceActive && !busy && !uploading && !draft.pending && !session.archived && session.running && session.status !== 'waiting_approval' && (!!draft.text.trim() || !!draft.attachments.length);
  async function send(queued?: QueuedMessage) {
    if (voiceActive || sending.current || latest.current.pending || (!queued && !canSend) || session.archived || !session.running || session.status === 'waiting_approval') return;
    const source = queued || latest.current;
    sending.current = true;
    setBusy(true); setError('');
    onActivityChange?.('sending');
    let pending: string | undefined;
    try {
      const native = await api<NativeInputState>('/sessions/' + session.id + '/input');
      if (!active.current) return;
      if (!native.directSubmit) throw new Error('当前 Dili 后端尚未加载直接发送功能；请从独立终端正常重启服务，草稿已保留');
      if (!native.generation) throw new Error('请先启动会话');
      if (queued && queued.identity !== native.generation) throw new Error('原生终端已重启；排队消息已暂停，请编辑后重新加入队列');
      const current = latest.current;
      const sent: Sent = {text:source.text, attachments:source.attachments.map(item=>item.id), ...(queued ? {queueId:queued.id} : {})};
      pending = messageId();
      if (!update({...current,pending,pendingMessage:sent})) { update({...current,pending:undefined,pendingMessage:undefined}); pending = undefined; throw new Error('无法保存本次发送状态，请允许浏览器存储后重试'); }
      onPendingChange?.({ text: sent.text });
      const result = await api<{status:string;submitted?:boolean;error?:string}>('/sessions/' + session.id + '/input', {...sent,generation:native.generation,requestId:pending,submit:true});
      if (result.status !== 'accepted' || !result.submitted) throw new Error(result.error || '发送结果待确认，请核对发送结果或原生会话，避免重复发送');
      complete(pending,sent);
    } catch (cause) {
      if (pending && cause instanceof ApiError && cause.status >= 400 && cause.status < 500) {
        const current = active.current ? latest.current : read(session.id);
        if (current.pending === pending) update({...current,pending:undefined,pendingMessage:undefined});
        if (active.current) onPendingChange?.(null);
      }
      if (active.current) { onActivityChange?.(null); setError(cause instanceof Error ? cause.message : '发送失败'); }
      if (queued) { const current = active.current ? latest.current : read(session.id); update({...current,queue:current.queue?.map(item=>item.id===queued.id ? {...item,paused:true} : item)}); }
    } finally { sending.current = false; if(active.current) setBusy(false); }
  }
  async function enqueue() {
    if (!canSend || sending.current) return;
    if ((latest.current.queue?.length || 0) >= 10) { setError('最多排队 10 条消息'); return; }
    const source=latest.current;
    sending.current=true; setBusy(true); setError('');
    try {
      const native=await api<NativeInputState>('/sessions/'+session.id+'/input');
      if (!active.current) return;
      if (!native.directSubmit || !native.generation) throw new Error('原生连接尚未支持直接发送，请先更新并启动服务');
      const current=latest.current;
      update({...current,text:current.text===source.text ? '' : current.text,attachments:current.attachments.filter(item=>!source.attachments.some(sent=>sent.id===item.id)),queue:[...(current.queue||[]),{id:messageId(),text:source.text,attachments:source.attachments,identity:native.generation}]});
    } catch(cause) { if(active.current) setError(cause instanceof Error ? cause.message : '排队失败'); }
    finally { sending.current=false; if(active.current) setBusy(false); }
  }
  useEffect(()=>{
    // Only native completion can release queued work; terminal heuristics cannot.
    // One release per state transition, not per render or successful submission.
    const current=latest.current,head=current.queue?.[0];
    if (head && !head.paused && !current.pending && !sending.current && !voiceActive && !uploading && session.running && !session.archived && session.statusSource==='native' && session.status==='waiting_input') void send(head);
  },[session.running,session.archived,session.status,session.statusSource,session.lastAttentionKey,voiceActive]);
  function editQueue(item:QueuedMessage) {
    if (latest.current.text.trim() || latest.current.attachments.length) { setError('请先处理输入框中的草稿，再编辑排队消息'); return; }
    update({...latest.current,text:item.text,attachments:item.attachments,queue:latest.current.queue?.filter(value=>value.id!==item.id)});
  }
  async function checkSend() {
    const current = latest.current;
    if (!current.pending || !current.pendingMessage || busy) return;
    setBusy(true); setError('');
    try {
      const result = await api<NativeInputState>('/sessions/' + session.id + '/input?requestId=' + encodeURIComponent(current.pending));
      if (result.submission?.status === 'accepted') complete(current.pending,current.pendingMessage);
      else if (active.current) setError(result.submission?.error || '尚未确认发送结果，请核对原生会话后再操作');
    } catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : '查询失败'); }
    finally { if(active.current) setBusy(false); }
  }
  const field = <>{preview && <div className="composer-preview" aria-label="消息 Markdown 预览"><Markdown text={draft.text || '还没有文字内容'}/></div>}<textarea ref={fieldRef} aria-label="原生会话消息草稿" value={draft.text} maxLength={30000} rows={3} placeholder="描述任务，或继续补充你的想法…" disabled={session.archived} onChange={event=>{update({...latest.current,text:event.target.value});}} onKeyDown={event=>{
    if (event.key === 'Enter' && event.shiftKey && (event.ctrlKey || event.metaKey)) return;
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); if(canSend) void send(); }
  }}/></>;
  return <><MessageQueue items={draft.queue||[]} locked={busy || uploading || !!draft.pending} disabled={busy || uploading || !!draft.pending || session.archived || !session.running || session.status==='waiting_approval'} sendingId={draft.pendingMessage?.queueId} send={item=>void send(item)} edit={editQueue} remove={id=>update({...latest.current,queue:latest.current.queue?.filter(item=>item.id!==id)})}/><ResizableComposer><div className="chat-composer native-input-composer" data-tools-open={toolsOpen || undefined} data-empty={!draft.text.trim() && !draft.attachments.length || undefined}>
    <button type="button" className="icon-button composer-tools-toggle" aria-label="更多输入工具" aria-expanded={toolsOpen} onClick={() => setToolsOpen(open => !open)}><Plus size={18} /></button>
    {['claude','dsh'].includes(session.backend) ? <ImageAttachments sessionId={session.id} items={draft.attachments} onChange={change=>{ const current = active.current ? latest.current : read(session.id); update({...current,attachments:change(current.attachments)}); }} onBusy={setUploading} disabled={!!draft.pending || busy || session.archived}>{field}</ImageAttachments> : field}
    {error && <p className="attachment-error" role="alert">{error}</p>}
    {draft.pending && !busy && <div role="status"><p>{draft.pendingMessage ? '发送结果待确认；草稿已保留，不会自动重发。请先核对原生会话是否已出现这条消息。' : '上次填入结果待确认，请先核对原生会话。'}</p>{draft.pendingMessage && <button type="button" className="text-button" onClick={()=>void checkSend()}>核对发送结果</button>}<button type="button" className="text-button" onClick={onTerminal}>查看原生会话</button><button type="button" className="text-button" onClick={()=>{ update({...latest.current,pending:undefined,pendingMessage:undefined}); onPendingChange?.(null); }}>已核对，恢复草稿</button></div>}
    <div className="chat-composer-footer native-input-footer"><span className="composer-hint" data-actionable={busy || !!draft.pending || session.status === 'waiting_approval' || !session.running || undefined}>{busy ? '正在发送…' : draft.pending ? '请先核对上一条消息的发送结果' : session.status === 'waiting_approval' ? '请先在原生终端中处理审批' : !session.running ? '请先启动会话，草稿已保留' : 'Enter 发送 · Shift + Enter 换行'}</span><div><VoiceInput sessionId={session.id} disabled={session.archived || busy || !!draft.pending} onActive={setVoiceActive} insert={text => { if (!update({...latest.current,text:appendVoiceText(latest.current.text,text)})) throw new Error("草稿保存失败，识别文字保留在下方"); }} /><button className="text-button composer-preview-toggle" type="button" aria-pressed={preview} onClick={()=>setPreview(value=>!value)}>Markdown 预览</button>{session.status==='running' && <button type="button" className="text-button composer-queue" disabled={!canSend} onClick={()=>void enqueue()}>加入队列</button>}<button type="button" className="button primary small-button composer-send" disabled={!canSend} onClick={()=>{ setToolsOpen(false); void send(); }}>{busy ? '正在发送…' : '发送'}</button></div></div>
  </div></ResizableComposer></>;
}
