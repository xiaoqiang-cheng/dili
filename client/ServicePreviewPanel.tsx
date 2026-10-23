import { useEffect, useId, useMemo, useState } from 'react';
import { ExternalLink, Globe2, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { parseServicePreviewUrl, SERVICE_PREVIEW_PRESETS } from '../shared/service-preview';
import { Splitter } from './WorkspaceExplorer';
import { readLocalPreference, writeLocalPreference } from './ui';
import './service-preview.css';

const WIDTH = { min: 360, max: 960, fallback: 560, key: 'sessiondeck.layout.service-preview-px' };
const RECENT_KEY = 'sessiondeck.service-preview.recent';
const DRAFT_KEY = 'sessiondeck.service-preview.draft';

function readRecent(): string[] {
  try {
    const value = JSON.parse(readLocalPreference(RECENT_KEY) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string').slice(0, 6);
  } catch { return []; }
}

function remember(url: string) {
  const next = [url, ...readRecent().filter(item => item !== url)].slice(0, 6);
  writeLocalPreference(RECENT_KEY, JSON.stringify(next));
  return next;
}

export default function ServicePreviewPanel({ open, close, inert, embedded = false, initialUrl = '', onNavigate }: { open: boolean; close: () => void; inert: boolean; embedded?: boolean; initialUrl?: string; onNavigate?: (url: string) => void }) {
  const [draft, setDraft] = useState(() => initialUrl || readLocalPreference(DRAFT_KEY) || 'http://127.0.0.1:5173/');
  const [activeUrl, setActiveUrl] = useState(() => { const parsed = initialUrl ? parseServicePreviewUrl(initialUrl) : null; return parsed?.ok ? parsed.url : ''; });
  const hintId = useId();
  const errorId = useId();
  const [generation, setGeneration] = useState(0);
  const [error, setError] = useState('');
  const [recent, setRecent] = useState(readRecent);
  const [loading, setLoading] = useState(false);
  const [width, setWidth] = useState(() => {
    const saved = Number(readLocalPreference(WIDTH.key));
    return Number.isFinite(saved) ? Math.max(WIDTH.min, Math.min(WIDTH.max, saved)) : WIDTH.fallback;
  });

  useEffect(() => { writeLocalPreference(DRAFT_KEY, draft); }, [draft]);

  const openUrl = (value: string) => {
    const parsed = parseServicePreviewUrl(value);
    if (!parsed.ok) { setError(parsed.error); return; }
    setError('');
    setDraft(parsed.url);
    setActiveUrl(parsed.url);
    onNavigate?.(parsed.url);
    setGeneration(current => current + 1);
    setLoading(true);
    setRecent(remember(parsed.url));
  };

  const suggestions = useMemo(() => {
    const presetUrls = new Set<string>(SERVICE_PREVIEW_PRESETS.map(item => item.url));
    return [
      ...SERVICE_PREVIEW_PRESETS.map(item => ({ label: item.label, url: item.url as string })),
      ...recent.filter(url => !presetUrls.has(url)).map(url => ({ label: url.replace(/^https?:\/\//, ''), url })),
    ];
  }, [recent]);

  if (!open) return null;

  return <aside className={`service-preview-panel ${embedded ? 'embedded-preview' : ''}`} aria-label="网页服务" inert={inert} style={embedded ? undefined : { width }} onKeyDown={event => {
    if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); close(); }
  }}>
    {!embedded && <Splitter label="调整网页服务宽度" value={width} min={WIDTH.min} max={WIDTH.max} direction={-1} onChange={setWidth} onCommit={value => writeLocalPreference(WIDTH.key, String(value))} />}
    <header className="service-preview-header">
      <div className="service-preview-title"><Globe2 size={15} /><strong>网页服务</strong></div>
      <button type="button" className="icon-button" aria-label="关闭网页服务" title="关闭" onClick={close}><X size={16} /></button>
    </header>
    <form className="service-preview-form" onSubmit={event => { event.preventDefault(); openUrl(draft); }}>
      <label className="service-preview-url">
        <span className="sr-only">服务地址</span>
        <input value={draft} onChange={event => { setDraft(event.target.value); setError(''); }} placeholder="http://127.0.0.1:5173 或 :5173" spellCheck={false} autoComplete="off" aria-invalid={!!error} aria-describedby={error ? errorId : hintId} />
      </label>
      <button type="submit" className="button primary small-button">打开</button>
      {activeUrl && <>
        <button type="button" className="icon-button" aria-label="刷新预览" title="刷新" onClick={() => { setGeneration(current => current + 1); setLoading(true); }}><RefreshCw size={15} /></button>
        <a className="icon-button" aria-label="在新标签打开" title="在新标签打开" href={activeUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} /></a>
      </>}
    </form>
    <div className="service-preview-suggestions" aria-label="常用地址">
      {suggestions.map(item => <button type="button" key={item.url} className={activeUrl === item.url ? 'active' : ''} onClick={() => openUrl(item.url)}>{item.label}</button>)}
    </div>
    {error ? <p id={errorId} className="service-preview-error" role="alert">{error}</p>
      : <p id={hintId} className="service-preview-hint">直连预览：地址须能从当前浏览器访问；公网主机端口转发尚未接入。站点禁止嵌入时可在新标签打开。</p>}
    <div className="service-preview-frame-wrap">
      {!activeUrl && <div className="service-preview-empty"><Globe2 size={28} /><p>粘贴 Vite / 本地服务地址后点打开</p><p>例如 <code>http://10.11.1.111:5173/</code></p></div>}
      {activeUrl && <>
        {loading && <div className="service-preview-loading" role="status"><LoaderCircle size={16} className="spin" />正在加载…</div>}
        <iframe key={`${activeUrl}:${generation}`} className="service-preview-frame" title={`网页服务 ${activeUrl}`} src={activeUrl} sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" onLoad={() => setLoading(false)} />
      </>}
    </div>
  </aside>;
}
