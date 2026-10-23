import { useEffect, useState } from 'react';
import { Code2, Columns2, Eye, FileDiff, LoaderCircle, RefreshCw, Rows3, X } from 'lucide-react';
import { api } from './api';
import Markdown from './Markdown';
import DiffView, { DiffStats, type DiffMode } from './DiffView';
import { readLocalPreference, writeLocalPreference } from './ui';
import { EntryIcon, htmlPath, markdownPath, mediaKind, workspaceRawUrl, type DiffResult, type FileResult, type HtmlMode, type Preview } from './workspace-files';

export function WorkspacePreviewContent({ preview, sessionId, selectedPath, loading, clearPreview, setPreview }: {
  preview: Preview | null; sessionId: string; selectedPath: string; loading: boolean;
  clearPreview: () => void; setPreview: (update: (current: Preview | null) => Preview | null) => void;
}) {
  const [diffMode, setDiffMode] = useState<DiffMode>(() => readLocalPreference('sessiondeck.diff-mode') === 'inline' ? 'inline' : 'split');
  const file = preview?.kind === 'file' ? preview.result : null;
  const html = preview?.kind === 'html' ? preview : null;
  const media = preview?.kind === 'media' ? preview : null;
  const diff = preview?.kind === 'diff' ? preview.result : null;
  const previewReady = !!preview;
  const chooseDiffMode = (mode: DiffMode) => { setDiffMode(mode); writeLocalPreference('sessiondeck.diff-mode', mode); };
  const setHtmlMode = (mode: HtmlMode) => setPreview(current => current?.kind === 'html' ? { ...current, mode } : current);
  const refreshHtml = () => setPreview(current => current?.kind === 'html' ? { ...current, generation: current.generation + 1 } : current);
  const rawUrl = (path: string) => workspaceRawUrl(sessionId, path);
  return <>
      {file && <section className="workspace-preview"><header><EntryIcon entry={{ name: file.path, path: file.path, kind: 'file' }} /><strong title={file.path}><bdi>{file.path}</bdi></strong><button className="icon-button" aria-label="关闭文件预览" onClick={clearPreview}><X size={14} /></button></header>{file.binary ? <p className="workspace-note">二进制文件不支持预览。</p> : markdownPath(file.path) ? <Markdown text={file.content} /> : <pre>{file.content}</pre>}{file.truncated && <p className="workspace-note">文件过大，预览已截断。</p>}</section>}
      {html && <section className="workspace-preview workspace-html-preview"><header><EntryIcon entry={{ name: html.result.path, path: html.result.path, kind: 'file' }} /><strong title={html.result.path}><bdi>{html.result.path}</bdi></strong><div className="diff-mode-switch" role="group" aria-label="网页显示方式"><button className="icon-button" aria-label="预览网页" title="预览" aria-pressed={html.mode === 'preview'} onClick={() => setHtmlMode('preview')}><Eye size={14} /></button><button className="icon-button" aria-label="查看源码" title="源码" aria-pressed={html.mode === 'source'} onClick={() => setHtmlMode('source')}><Code2 size={14} /></button></div>{html.mode === 'preview' && <button className="icon-button" aria-label="刷新网页预览" title="刷新预览" onClick={refreshHtml}><RefreshCw size={14} /></button>}<button className="icon-button" aria-label="关闭文件预览" onClick={clearPreview}><X size={14} /></button></header>{html.mode === 'preview' ? <iframe key={html.generation} className="workspace-html-frame" title={`预览 ${html.result.path}`} src={rawUrl(html.result.path)} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" /> : <pre>{html.result.content}</pre>}{html.result.truncated && html.mode === 'source' && <p className="workspace-note">文件过大，预览已截断。</p>}</section>}
      {media && <section className="workspace-preview workspace-media-preview"><header><EntryIcon entry={{ name: media.path, path: media.path, kind: 'file' }} /><strong title={media.path}><bdi>{media.path}</bdi></strong><button className="icon-button" aria-label="关闭文件预览" onClick={clearPreview}><X size={14} /></button></header><div className="workspace-media-stage">{media.media === 'image' ? <img src={rawUrl(media.path)} alt={media.path} /> : media.media === 'video' ? <video src={rawUrl(media.path)} controls playsInline preload="metadata" /> : <audio src={rawUrl(media.path)} controls preload="metadata" />}</div></section>}
      {diff && <section className="workspace-preview workspace-diff"><header><FileDiff size={14} className="workspace-entry-icon" /><strong title={diff.path}><bdi>{diff.path}</bdi></strong>{diff.available && diff.diff && <DiffStats diff={diff.diff} />}<div className="diff-mode-switch" role="group" aria-label="差异显示方式"><button className="icon-button" aria-label="并排显示" title="并排显示" aria-pressed={diffMode === 'split'} onClick={() => chooseDiffMode('split')}><Columns2 size={14} /></button><button className="icon-button" aria-label="内联显示" title="内联显示" aria-pressed={diffMode === 'inline'} onClick={() => chooseDiffMode('inline')}><Rows3 size={14} /></button></div><button className="icon-button" aria-label="关闭 diff 预览" onClick={clearPreview}><X size={14} /></button></header>{!diff.available ? <p className="workspace-note">Git diff 不可用。</p> : !diff.diff ? <p className="workspace-note">此文件没有可显示的文本差异。</p> : <DiffView diff={diff.diff} mode={diffMode} />}{diff.truncated && <p className="workspace-note">差异过大，预览已截断。</p>}</section>}
      {!previewReady && loading && <div className="workspace-preview workspace-preview-empty"><LoaderCircle size={18} className="spin" /><p>正在打开 {selectedPath}</p></div>}
  </>;
}

export default function WorkspaceFilePreview({ sessionId, path, kind, close, compact }: { compact?: boolean; sessionId: string; path: string; kind: 'file' | 'diff'; close: () => void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    setLoading(true); setError(''); setPreview(null);
    const base = `/sessions/${encodeURIComponent(sessionId)}/workspace`;
    const media = kind === 'file' ? mediaKind(path) : null;
    if (media) { setPreview({ kind: 'media', path, media }); setLoading(false); return; }
    const load = async () => {
      try {
        if (kind === 'diff') {
          const result = await api<DiffResult>(`${base}/git/diff?path=${encodeURIComponent(path)}`);
          if (live) setPreview({ kind: 'diff', result: { ...result, path: result.path || path } });
        } else {
          const result = await api<FileResult>(`${base}/file?path=${encodeURIComponent(path)}`);
          if (live) setPreview(htmlPath(path) && !result.binary ? { kind: 'html', result, mode: 'preview', generation: 0 } : { kind: 'file', result });
        }
      } catch (cause) { if (live) setError(cause instanceof Error ? cause.message : '无法读取文件'); }
      finally { if (live) setLoading(false); }
    };
    void load();
    return () => { live = false; };
  }, [sessionId, path, kind, attempt]);
  return <div className="workspace-file-tab">
    {!compact && <div className="preview-file-actions"><span title={path}><bdi>{path}</bdi></span><button className="icon-button" aria-label="重新读取文件" title="重新读取文件" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={14} /></button></div>}
    {error && <div className="workspace-error" role="alert">{error}<button className="text-button" onClick={() => setAttempt(value => value + 1)}>重试</button></div>}
    <WorkspacePreviewContent preview={preview} sessionId={sessionId} selectedPath={path} loading={loading} clearPreview={close} setPreview={setPreview} />
  </div>;
}
