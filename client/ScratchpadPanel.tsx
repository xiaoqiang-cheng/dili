import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Check, Code2, Download, Eye, FilePenLine, LoaderCircle, Pencil, RotateCcw, Trash2, X } from 'lucide-react';
import { api, ApiError } from './api';
import { appUrl } from './urls';
import Markdown from './Markdown';
import { Splitter } from './WorkspaceExplorer';
import { readLocalPreference, writeLocalPreference } from './ui';
import { MAX_SCRATCHPAD_LENGTH, type Scratchpad } from '../shared/scratchpad';
import './scratchpad.css';

const LiveMarkdownEditor = lazy(() => import('./LiveMarkdownEditor'));

type Recovery = { key: string; content: string; revision: number };
type Model = { note: Scratchpad | null; content: string; conflict: Scratchpad | null; status: 'loading' | 'saved' | 'dirty' | 'saving' | 'failed'; error: string; recovery?: Recovery };
const draftPrefix = `sessiondeck.scratchpad-draft:${appUrl('/')}:`;
const tabId = (() => {
  try {
    const key = 'sessiondeck.scratchpad-tab';
    const id = sessionStorage.getItem(key) ?? crypto.randomUUID();
    sessionStorage.setItem(key, id); return id;
  } catch { return `${Date.now()}-${Math.random()}`; }
})();
const draftKey = `${draftPrefix}${tabId}`;
type Draft = { id: string; revision: number; content: string; conflicted?: boolean; timestamp?: number; recovery?: Recovery };
function readDraft(): { draft: Draft; otherTab: boolean; key: string } | null {
  try {
    const keys = [draftKey, ...Object.keys(localStorage).filter(key => key.startsWith(draftPrefix) && key !== draftKey)];
    const drafts = keys.flatMap(key => {
      try {
        const value = JSON.parse(readLocalPreference(key) ?? 'null');
        if (value && typeof value.content === 'string' && value.content.length <= MAX_SCRATCHPAD_LENGTH && typeof value.id === 'string' && Number.isSafeInteger(value.revision)) return [{ draft: value as Draft, otherTab: key !== draftKey, key }];
      } catch { /* Ignore a damaged draft independently of the other tabs. */ }
      return [];
    });
    return drafts.find(item => !item.otherTab) ?? drafts.sort((a, b) => (b.draft.timestamp ?? 0) - (a.draft.timestamp ?? 0))[0] ?? null;
  } catch { return null; }
}
function cache(model: Model) {
  if (!model.note) return;
  if (model.content === model.note.content && !model.conflict) {
    try { localStorage.removeItem(draftKey); } catch { /* Server persistence remains available. */ }
  } else {
    writeLocalPreference(draftKey, JSON.stringify({ id: model.note.id, revision: model.note.revision, content: model.content, conflicted: !!model.conflict, timestamp: Date.now(), recovery: model.recovery }));
  }
}

export default function ScratchpadPanel({ open, close, inert, embedded = false }: { open: boolean; close: () => void; inert: boolean; embedded?: boolean }) {
  const [model, setModel] = useState<Model>({ note: null, content: '', conflict: null, status: 'loading', error: '' });
  const current = useRef(model);
  const mounted = useRef(true);
  const saving = useRef(false);
  const saveSerial = useRef(0);
  const loading = useRef(false);
  const update = useCallback((fn: (model: Model) => Model) => {
    if (!mounted.current) return;
    const next = fn(current.current); current.current = next; cache(next); setModel(next);
  }, []);
  const [mode, setMode] = useState<'live' | 'source' | 'preview'>(() => {
    const saved = readLocalPreference('sessiondeck.scratchpad-mode');
    return saved === 'source' || saved === 'preview' ? saved : 'live';
  });
  const [focusRequest, setFocusRequest] = useState(0);
  const selectMode = (next: typeof mode) => {
    setMode(next); writeLocalPreference('sessiondeck.scratchpad-mode', next);
    if (next === 'source') requestAnimationFrame(() => editor.current?.focus());
    if (next === 'live') setFocusRequest(value => value + 1);
  };
  const [clearing, setClearing] = useState(false);
  const [undo, setUndo] = useState<string | null>(null);
  const [width, setWidth] = useState(() => {
    const saved = Number(readLocalPreference('sessiondeck.layout.scratchpad-px'));
    return saved >= 280 && saved <= 560 ? saved : 340;
  });
  const editor = useRef<HTMLTextAreaElement>(null);

  const sync = useCallback(async () => {
    if (!mounted.current || loading.current || saving.current) return;
    loading.current = true;
    const serial = saveSerial.current;
    try {
      const latest = await api<Scratchpad>('/scratchpad');
      if (serial !== saveSerial.current) return;
      update(previous => {
        if (!previous.note) {
          const recovered = readDraft();
          const draft = recovered?.draft;
          if (draft && draft.content !== latest.content) {
            const conflict = recovered?.otherTab || draft.conflicted || draft.id !== latest.id || draft.revision !== latest.revision;
            const recovery = recovered.otherTab ? { key: recovered.key, content: draft.content, revision: draft.revision } : draft.recovery;
            return { note: latest, content: draft.content, conflict: conflict ? latest : null, status: 'dirty', error: '', recovery };
          }
        } else if (previous.content !== previous.note.content || previous.conflict) {
          if (previous.content === latest.content) return { note: latest, content: latest.content, conflict: null, status: 'saved', error: '' };
          if (previous.note.id !== latest.id || previous.note.revision !== latest.revision) return { ...previous, conflict: latest, error: '' };
          return previous;
        }
        return { note: latest, content: latest.content, conflict: null, status: 'saved', error: '' };
      });
    } catch (cause) {
      update(previous => ({ ...previous, status: 'failed', error: cause instanceof Error ? cause.message : '无法读取笔记' }));
    } finally { loading.current = false; }
  }, [update]);

  const save = useCallback(async () => {
    const snapshot = current.current;
    if (!mounted.current || saving.current || !snapshot.note || snapshot.conflict || snapshot.content === snapshot.note.content) return;
    saving.current = true;
    saveSerial.current++;
    update(previous => ({ ...previous, status: 'saving', error: '' }));
    try {
      const note = await api<Scratchpad>('/scratchpad', { id: snapshot.note.id, revision: snapshot.note.revision, content: snapshot.content }, 'PATCH');
      update(previous => ({ ...previous, note, status: previous.content === note.content ? 'saved' : 'dirty', error: '' }));
    } catch (cause) {
      update(previous => ({ ...previous, status: 'failed', error: cause instanceof Error ? cause.message : '保存失败' }));
      if (cause instanceof ApiError && cause.status === 409) {
        saving.current = false;
        await sync();
      }
    } finally {
      saving.current = false;
      // A user may have typed again while the save was in flight.
      if (current.current.status === 'dirty') void save();
    }
  }, [sync, update]);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!open) return;
    void sync();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void sync(); }, 15_000);
    const resume = () => { void sync().then(() => { if (current.current.status === 'failed' || current.current.status === 'dirty') void save(); }); };
    window.addEventListener('focus', resume); window.addEventListener('online', resume);
    return () => { clearInterval(timer); window.removeEventListener('focus', resume); window.removeEventListener('online', resume); };
  }, [open, sync, save]);
  useEffect(() => {
    if (!model.note || model.conflict || model.content === model.note.content) return;
    const timer = setTimeout(() => void save(), 600);
    return () => clearTimeout(timer);
  }, [model.content, model.note?.revision, model.conflict, save]);

  const edit = (content: string) => {
    update(previous => ({ ...previous, content, status: content === previous.note?.content ? 'saved' : 'dirty', error: '' }));
  };
  const restore = () => { if (undo !== null) { edit(undo); setUndo(null); setClearing(false); } };
  const resolveConflict = (useLatest: boolean) => {
    const previous = current.current;
    if (!previous.conflict) return;
    // Consume a recovered draft only on an explicit decision, and only if the
    // source tab has not edited it again in the meantime.
    const recovery = previous.recovery;
    if (recovery?.key?.startsWith(draftPrefix)) {
      try {
        const value = JSON.parse(readLocalPreference(recovery.key) ?? 'null');
        if (value?.content === recovery.content && value?.revision === recovery.revision) localStorage.removeItem(recovery.key);
      } catch { /* Keep an unrecognized source draft. */ }
    }
    if (useLatest) setUndo(previous.content);
    update(model => ({ ...model, note: model.conflict!, content: useLatest ? model.conflict!.content : model.content, conflict: null, status: useLatest ? 'saved' : 'dirty', error: '', recovery: undefined }));
  };
  const status = model.conflict ? '需要核对' : model.status === 'saved' ? '已保存' : model.status === 'saving' ? '保存中…' : model.status === 'loading' ? '读取中…' : model.status === 'failed' ? '保存未完成' : '待保存';
  const exportNote = () => {
    const url = URL.createObjectURL(new Blob([model.content], { type: 'text/markdown;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = '随手记.md'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return !open ? null : <aside className={`scratchpad-panel ${embedded ? 'embedded-preview' : ''}`} aria-label="随手记" inert={inert} style={embedded ? undefined : { width }} onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); close(); }
    if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); void save(); }
  }}>
    {!embedded && <Splitter label="调整随手记宽度" value={width} min={280} max={560} direction={-1} onChange={setWidth} onCommit={value => writeLocalPreference('sessiondeck.layout.scratchpad-px', String(value))} />}
    <header className="scratchpad-header"><span><FilePenLine size={16} /><strong>随手记</strong></span><div>
      <button className="icon-button" aria-label="导出随手记" title="导出 Markdown" disabled={!model.content} onClick={exportNote}><Download size={15} /></button>
      <button className="icon-button" aria-label="清空随手记" title="清空笔记" disabled={!model.content || !model.note || !!model.conflict || saving.current} onClick={() => setClearing(true)}><Trash2 size={15} /></button>
      <button className="icon-button" aria-label="关闭随手记" title="收起，内容会保留" onClick={close}><X size={16} /></button>
    </div></header>
    <div className="scratchpad-toolbar"><div role="group" aria-label="随手记显示方式"><button aria-pressed={mode === 'live'} onClick={() => selectMode('live')}><Pencil size={13} />实时</button><button aria-pressed={mode === 'source'} onClick={() => selectMode('source')}><Code2 size={14} />源码</button><button aria-pressed={mode === 'preview'} onClick={() => selectMode('preview')}><Eye size={14} />预览</button></div><span role="status" aria-live="polite" className={`scratchpad-status ${model.status === 'failed' || model.conflict ? 'failed' : ''}`}>{model.status === 'saving' ? <LoaderCircle size={12} className="spin" /> : model.status === 'saved' ? <Check size={12} /> : null}{status}</span></div>
    {model.error && <div className="scratchpad-banner" role="alert"><p>{model.error}。未保存内容保留在此浏览器。</p><button className="text-button" onClick={() => void (model.note ? save() : sync())}>重试</button></div>}
    {model.conflict && <div className="scratchpad-banner" role="alert"><p>发现未保存草稿，或笔记已在其他页面更新。你的内容已保留，请核对后选择。</p><details><summary>查看最新内容</summary><pre>{model.conflict.content || '（空白笔记）'}</pre></details><div>
      <button className="text-button" onClick={() => resolveConflict(false)}>保存我的内容</button>
      <button className="text-button" onClick={() => resolveConflict(true)}>使用最新内容</button>
    </div></div>}
    {clearing && <div className="scratchpad-banner" role="alert"><p>清空这张笔记？清空后可以撤销。</p><div><button className="text-button" onClick={() => setClearing(false)}>取消</button><button className="text-button danger" onClick={() => { setUndo(model.content); edit(''); setClearing(false); }}>确认清空</button></div></div>}
    {undo !== null && <div className="scratchpad-undo"><span>先前内容可恢复</span><button className="text-button" onClick={restore}><RotateCcw size={12} />撤销</button></div>}
    {mode === 'live' ? model.note ? <Suspense fallback={<div className="loading-state"><LoaderCircle className="spin" size={18} /><p>正在加载实时编辑器…</p></div>}><LiveMarkdownEditor value={model.content} onChange={edit} onBlur={() => void save()} focusRequest={focusRequest} /></Suspense> : <div className="scratchpad-empty">正在读取笔记…</div> : mode === 'preview' ? <div className="scratchpad-preview">{model.content ? <Markdown text={model.content} onToggleTask={model.note ? (offset, checked) => {
      const tail = model.content.slice(offset);
      const match = /^(?:[-+*]|\d+[.)])\s+\[([ xX])\]/.exec(tail);
      if (!match) return;
      const position = offset + match[0].lastIndexOf('[') + 1;
      edit(`${model.content.slice(0, position)}${checked ? 'x' : ' '}${model.content.slice(position + 1)}`);
    } : undefined} /> : <div className="scratchpad-empty"><FilePenLine size={26} /><p>把想法和待办留在这里</p><button className="text-button" onClick={() => selectMode('live')}>开始记录</button></div>}</div> : <textarea ref={editor} className="scratchpad-editor" aria-label="随手记内容" placeholder={'随手记下想法、待办或命令…\n\n# 今天\n- [ ] 要做的事\n\n支持 Markdown，输入后自动保存。'} value={model.content} maxLength={MAX_SCRATCHPAD_LENGTH} disabled={!model.note} spellCheck={false} onChange={event => edit(event.target.value)} onBlur={() => void save()} />}
    <footer className="scratchpad-footer"><span>Markdown · 自动保存</span><span>{model.content.length.toLocaleString()} / 30,000</span></footer>
  </aside>;
}
