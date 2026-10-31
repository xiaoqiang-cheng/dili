import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from 'react';
import { ImagePlus, LoaderCircle, X } from 'lucide-react';
import type { ChatAttachment } from '../shared/attachments';
import { MAX_CHAT_ATTACHMENTS } from '../shared/attachments';
import { MAX_TERMINAL_IMAGE_BYTES, TERMINAL_IMAGE_TYPES } from '../shared/terminal-images';
import { uploadChatImage } from './api';
import { appUrl } from './urls';
import './attachments.css';

export default function ImageAttachments({ sessionId, scope = 'sessions', items, onChange, onBusy, disabled, hidden, children, actions }: {
  sessionId: string; scope?: 'sessions' | 'groups'; items: ChatAttachment[]; onChange(update: (items: ChatAttachment[]) => ChatAttachment[]): void; onBusy(busy: boolean): void; disabled?: boolean; /** Keep the composer children but never offer file input or clipboard drops. */ hidden?: boolean; children: ReactNode; actions?: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef(items); latest.current = items;
  const change = useRef(onChange); change.current = onChange;
  const active = useRef(true), busy = useRef(false);
  const [uploading, setUploading] = useState(false), [error, setError] = useState('');
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function add(files: File[]) {
    if (!files.length) return;
    if (busy.current || disabled) { setError(busy.current ? '图片仍在上传，请稍后再添加' : '请先确认当前发送结果，再添加图片'); return; }
    if (files.length + latest.current.length > MAX_CHAT_ATTACHMENTS) { setError('每条消息最多添加 8 张图片'); return; }
    busy.current = true; setUploading(true); onBusy(true); setError('');
    try {
      for (const file of files) {
        if (!(TERMINAL_IMAGE_TYPES as readonly string[]).includes(file.type)) throw new Error('仅支持 PNG、JPEG、GIF 或 WebP 图片');
        if (file.size > MAX_TERMINAL_IMAGE_BYTES) throw new Error('每张图片不能超过 10 MiB');
        const item = await uploadChatImage(sessionId, file, scope);
        // Keep uploaded metadata in the draft even if this view was closed.
        latest.current = [...latest.current, item];
        change.current(current => current.some(value => value.id === item.id) ? current : [...current, item].slice(0, MAX_CHAT_ATTACHMENTS));
      }
    } catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : '图片上传失败'); }
    finally { busy.current = false; if (active.current) { setUploading(false); onBusy(false); } }
  }
  function paste(event: ClipboardEvent) {
    const files = Array.from(event.clipboardData.items).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter((item): item is File => !!item);
    if (!files.length) return;
    event.preventDefault(); event.stopPropagation();
    // Rich clipboard often has both screenshot and text; preserve the text.
    const text = event.clipboardData.getData('text/plain');
    if (text && event.target instanceof HTMLTextAreaElement) {
      const field = event.target;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      const start = field.selectionStart;
      setter.call(field, field.value.slice(0,start) + text + field.value.slice(field.selectionEnd));
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
    void add(files);
  }
  function drop(event: DragEvent) {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault(); event.stopPropagation(); void add(Array.from(event.dataTransfer.files));
  }
  return <div className="image-composer" onPasteCapture={hidden ? undefined : paste} onDragOver={hidden ? undefined : event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={hidden ? undefined : drop}>
    {children}
    {!hidden && !!items.length && <div className="chat-attachments" aria-label="待发送图片">{items.map(item => <figure key={item.id}><img src={appUrl('/api/' + scope + '/' + encodeURIComponent(sessionId) + '/attachments/' + encodeURIComponent(item.id))} alt={item.name} /><figcaption>{item.name}</figcaption><button type="button" className="icon-button" aria-label={'移除图片 ' + item.name} disabled={disabled} onClick={() => change.current(current => current.filter(value => value.id !== item.id))}><X size={12}/></button></figure>)}</div>}
    {!hidden && <div className="attachment-actions"><input ref={input} type="file" accept={TERMINAL_IMAGE_TYPES.join(',')} multiple hidden onChange={event => { void add(Array.from(event.target.files ?? [])); event.target.value=''; }}/><button type="button" className="text-button" title="添加图片，也支持粘贴、拖入" disabled={disabled || uploading || items.length >= MAX_CHAT_ATTACHMENTS} onClick={() => input.current?.click()}>{uploading ? <LoaderCircle size={14} className="spin"/> : <ImagePlus size={14}/>}添加图片</button><span>支持粘贴、拖入图片</span>{actions}</div>}
    {!hidden && error && <p className="attachment-error" role="alert">{error}</p>}
  </div>;
}
