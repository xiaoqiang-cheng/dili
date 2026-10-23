import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, FileDiff, FileText, Folder, PanelLeftClose, PanelLeftOpen, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { EntryIcon, formatSize, gitStatusClass, gitStatusLabel, htmlPath, mediaKind, type Entry, type Tree, type FileResult, type DiffResult, type GitStatus, type Preview } from './workspace-files';
import WorkspaceFilePreview, { WorkspacePreviewContent } from './WorkspacePreview';
import type { FileSelection } from './usePreviewWorkspace';
import type { Session } from '../shared/types';
import { api } from './api';
import { readLocalPreference, writeLocalPreference } from './ui';
import { interfaceScale, viewportWidth } from './zoom';

// Tree and preview have independent pixel widths, like the VS Code explorer and
// an editor group. The preview only takes space while a file is open.
const TREE = { min: 180, max: 520, fallback: 260, key: 'sessiondeck.layout.explorer-tree-px' };
const PREVIEW = { min: 320, fallback: 560, key: 'sessiondeck.layout.explorer-preview-px' };
const MAIN_RESERVE = 360;
function savedWidth(key: string, fallback: number) {
  const raw = readLocalPreference(key);
  const saved = raw === null ? NaN : Number(raw);
  return Number.isFinite(saved) ? saved : fallback;
}
function useViewportWidth() {
  const [width, setWidth] = useState(() => viewportWidth());
  useEffect(() => {
    const resize = () => setWidth(viewportWidth());
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  return width;
}

export function Splitter({ label, value, min, max, onChange, onCommit, direction = 1, orientation = 'vertical' }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void; onCommit: (value: number) => void; direction?: 1 | -1; orientation?: 'vertical' | 'horizontal' }) {
  const drag = useRef<{ x: number; width: number; last: number } | null>(null);
  const clamp = (next: number) => Math.round(Math.max(min, Math.min(max, next)));
  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    // Pointer capture keeps the drag alive over terminals and iframes, which
    // would otherwise swallow document-level pointer events.
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: orientation === 'horizontal' ? event.clientY : event.clientX, width: value, last: value };
    document.body.classList.add('workspace-resizing');
    if (orientation === 'horizontal') document.body.classList.add('workspace-resizing-height');
  };
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const next = clamp(drag.current.width + direction * ((orientation === 'horizontal' ? event.clientY : event.clientX) - drag.current.x) / interfaceScale());
    drag.current.last = next;
    onChange(next);
  };
  const finish = () => {
    if (!drag.current) return;
    onCommit(drag.current.last);
    drag.current = null;
    document.body.classList.remove('workspace-resizing');
    document.body.classList.remove('workspace-resizing-height');
  };
  useEffect(() => () => document.body.classList.remove('workspace-resizing', 'workspace-resizing-height'), []);
  const keyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const negative = orientation === 'horizontal' ? 'ArrowUp' : 'ArrowLeft';
    const positive = orientation === 'horizontal' ? 'ArrowDown' : 'ArrowRight';
    if (event.key !== negative && event.key !== positive) return;
    event.preventDefault();
    const next = clamp(value + direction * (event.key === positive ? 24 : -24));
    onChange(next); onCommit(next);
  };
  return <div className={`workspace-splitter ${orientation === 'horizontal' ? 'horizontal-splitter' : ''}`} role="separator" tabIndex={0} aria-orientation={orientation} aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(value)} title={orientation === 'horizontal' ? '拖动调整高度' : '拖动调整宽度'}
    onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish} onKeyDown={keyDown}><span /></div>;
}

type ExplorerProps = { session: Session; close: () => void; picker?: ReactNode; embedded?: boolean; selection?: FileSelection; treeCollapsed?: boolean; onTreeCollapsed?: (value: boolean) => void; onSelectFile?: (selection?: FileSelection) => void };

export default function WorkspaceExplorer(props: ExplorerProps) {
  // Remount immediately when switching workspaces; pending responses from the
  // previous panel cannot expose another contact's file or error.
  return <WorkspaceExplorerPanel key={`${props.session.id}:${props.session.cwd}`} {...props} />;
}

function WorkspaceExplorerPanel({ session, close, picker, embedded, selection, treeCollapsed = false, onTreeCollapsed, onSelectFile }: ExplorerProps) {
  const [tab, setTab] = useState<'files' | 'git'>(() => selection?.kind === 'diff' ? 'git' : 'files');
  const [trees, setTrees] = useState<Record<string, Tree>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']));
  const [selectedPath, setSelectedPath] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const treeKey = embedded ? 'dili.preview-tree-width' : TREE.key;
  const [treeWidth, setTreeWidth] = useState(() => savedWidth(treeKey, embedded ? 190 : TREE.fallback));
  const container = useRef<HTMLElement>(null);
  const [panelWidth, setPanelWidth] = useState(560);
  useEffect(() => {
    if (!embedded || !container.current) return;
    const observer = new ResizeObserver(([entry]) => { if (entry.contentRect.width) setPanelWidth(entry.contentRect.width); });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, [embedded]);
  const chooseFile = (path: string, kind: 'file' | 'diff') => {
    onSelectFile?.({ path, kind });
    if (panelWidth < 480) onTreeCollapsed?.(true);
  };
  const [previewWidth, setPreviewWidth] = useState(() => savedWidth(PREVIEW.key, PREVIEW.fallback));
  const viewport = useViewportWidth();
  const live = useRef(true);
  const sequence = useRef(0);
  const requests = useRef(new Map<string, number>());
  const base = `/sessions/${encodeURIComponent(session.id)}/workspace`;

  // Each tree, Git status and the single preview have their own request scope.
  // An older completion cannot clear a newer request's loading/error state.
  const request = useCallback(async <T,>(scope: string, url: string, apply: (value: T) => void, failure: string) => {
    const version = ++sequence.current;
    requests.current.set(scope, version);
    setPending(current => new Set(current).add(scope));
    setErrors(current => { const next = { ...current }; delete next[scope]; return next; });
    const currentRequest = () => live.current && requests.current.get(scope) === version;
    try {
      const result = await api<T>(url);
      if (currentRequest()) apply(result);
    } catch (cause) {
      if (currentRequest()) setErrors(current => ({ ...current, [scope]: cause instanceof Error ? cause.message : failure }));
    } finally {
      if (currentRequest()) {
        requests.current.delete(scope);
        setPending(current => { const next = new Set(current); next.delete(scope); return next; });
      }
    }
  }, []);
  const loadTree = useCallback((path: string) => request<Tree>(`tree:${path}`, `${base}/tree${path ? `?path=${encodeURIComponent(path)}` : ''}`, result => {
    setTrees(current => ({ ...current, [path]: result }));
  }, '无法读取文件树'), [base, request]);
  const loadGit = useCallback(() => request<GitStatus>('git', `${base}/git/status`, setGit, '无法读取 Git 状态'), [base, request]);

  useEffect(() => {
    live.current = true;
    void loadTree(''); void loadGit();
    return () => { live.current = false; requests.current.clear(); };
  }, [loadTree, loadGit]);

  const clearPreview = () => {
    if (onSelectFile) { onSelectFile(undefined); return; }
    requests.current.delete('preview');
    setPending(current => { const next = new Set(current); next.delete('preview'); return next; });
    setErrors(current => { const next = { ...current }; delete next.preview; return next; });
    setSelectedPath(''); setPreview(null);
  };
  const openFile = (path: string) => {
    if (onSelectFile) { chooseFile(path, 'file'); return; }
    setSelectedPath(path); setPreview(null);
    const media = mediaKind(path);
    if (media) {
      setPreview({ kind: 'media', path, media });
      return;
    }
    void request<FileResult>('preview', `${base}/file?path=${encodeURIComponent(path)}`, result => {
      if (htmlPath(path) && !result.binary) setPreview({ kind: 'html', result, mode: 'preview', generation: 0 });
      else setPreview({ kind: 'file', result });
    }, '无法读取文件');
  };
  const openDiff = (path: string) => {
    if (onSelectFile) { chooseFile(path, 'diff'); return; }
    setSelectedPath(path); setPreview(null);
    void request<DiffResult>('preview', `${base}/git/diff?path=${encodeURIComponent(path)}`, result => setPreview({ kind: 'diff', result: { ...result, path: result.path || path } }), '无法读取 Git diff');
  };
  const selectTab = (next: typeof tab) => {
    if (next !== tab) { if (!embedded) clearPreview(); setTab(next); }
    if (next === 'git') void loadGit();
  };
  const refresh = () => {
    // Drop collapsed-directory caches, then refresh every expanded directory.
    // New and deleted files appear without reopening their parent directories.
    for (const scope of requests.current.keys()) if (scope.startsWith('tree:')) requests.current.delete(scope);
    setPending(current => new Set([...current].filter(scope => !scope.startsWith('tree:'))));
    setErrors(current => Object.fromEntries(Object.entries(current).filter(([scope]) => !scope.startsWith('tree:'))));
    setTrees(current => Object.fromEntries(Object.entries(current).filter(([path]) => expanded.has(path))));
    for (const path of expanded) void loadTree(path);
    void loadGit();
    if (selectedPath && !onSelectFile) { if (tab === 'git') openDiff(selectedPath); else openFile(selectedPath); }
  };
  const root = trees[''];
  const rows = useMemo(() => {
    const result: { entry: Entry; depth: number }[] = [];
    const visited = new Set<string>();
    const visit = (path: string, depth: number) => {
      if (visited.has(path) || depth > 64) return;
      visited.add(path);
      const entries = [...(trees[path]?.entries ?? [])].sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
      });
      for (const entry of entries) {
        result.push({ entry, depth });
        if (entry.kind === 'directory' && expanded.has(entry.path)) visit(entry.path, depth + 1);
      }
    };
    visit('', 0); return result;
  }, [trees, expanded]);
  const toggle = (entry: Entry) => {
    if (entry.kind !== 'directory') return openFile(entry.path);
    const next = new Set(expanded);
    if (next.has(entry.path)) next.delete(entry.path);
    else { next.add(entry.path); if (!trees[entry.path]) void loadTree(entry.path); }
    setExpanded(next);
  };
  const loading = pending.size > 0;
  const gitEntries = useMemo(() => [...(git?.entries ?? [])].sort((a, b) => a.path.localeCompare(b.path, 'zh-CN', { numeric: true, sensitivity: 'base' })), [git]);
  const visibleErrors = Object.entries(errors).filter(([scope]) => scope === 'preview' || (tab === 'git' ? scope === 'git' : scope.startsWith('tree:')));

  // Saved widths are preferences; the rendered widths always leave the main
  // workbench usable on the current window size.
  const treeMin = embedded ? 140 : TREE.min;
  const treeMax = Math.max(treeMin, Math.min(TREE.max, embedded ? panelWidth - 246 : viewport - MAIN_RESERVE));
  const shownTree = Math.max(treeMin, Math.min(treeWidth, treeMax));
  const highlightedPath = embedded ? selection?.path : selectedPath;
  const previewOpen = !onSelectFile && !!selectedPath;
  const previewMax = Math.max(PREVIEW.min, viewport - MAIN_RESERVE - shownTree);
  const shownPreview = Math.max(PREVIEW.min, Math.min(previewWidth, previewMax));


  return <aside ref={container} className={`workspace-explorer ${previewOpen ? 'preview-open' : ''} ${embedded ? `embedded-explorer ${treeCollapsed ? 'tree-collapsed' : ''}` : ''}`} aria-label="资源管理器" style={{ '--workspace-tree-width': `${shownTree}px`, '--workspace-preview-width': `${shownPreview}px` } as CSSProperties}>
    {embedded && <div className="workspace-combined-toolbar">
      <button className="icon-button" aria-label={treeCollapsed ? '展开目录' : '收起目录'} title={treeCollapsed ? '展开目录' : '收起目录'} aria-expanded={!treeCollapsed} onClick={() => onTreeCollapsed?.(!treeCollapsed)}>{treeCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button>
      <span title={selection?.path || session.cwd}><bdi>{selection?.path || session.cwd}</bdi></span>
      {selection && <><button className="icon-button" aria-label="重新读取文件" title="重新读取文件" onClick={() => setPreviewRevision(value => value + 1)}><RefreshCw size={14} /></button><button className="icon-button" aria-label="关闭文件预览" title="关闭文件预览" onClick={clearPreview}><X size={14} /></button></>}
    </div>}
    <div className="workspace-explorer-body">
    <div className="workspace-list-pane" hidden={embedded && treeCollapsed}>
      <header className="workspace-explorer-header"><div><strong>资源管理器</strong><small title={session.cwd}><bdi>{session.cwd}</bdi></small></div><button className="icon-button" aria-label="刷新资源管理器" title="刷新" onClick={refresh}><RefreshCw size={14} /></button><button className="icon-button" aria-label="关闭资源管理器" title="关闭" onClick={close}><X size={16} /></button></header>
      {picker}
      <nav className="workspace-tabs" aria-label="资源管理器视图"><button className={tab === 'files' ? 'active' : ''} aria-pressed={tab === 'files'} onClick={() => selectTab('files')}><Folder size={14} />文件</button><button className={tab === 'git' ? 'active' : ''} aria-pressed={tab === 'git'} onClick={() => selectTab('git')}><FileDiff size={14} />Git diff{!!git?.entries.length && <b>{git.entries.length}</b>}</button></nav>
      {visibleErrors.filter(([scope]) => scope !== 'preview').map(([scope, message]) => <div key={scope} className="workspace-error" role="alert">{message}</div>)}
      {loading && <div className="workspace-loading" role="status"><LoaderCircle size={14} className="spin" />读取中…</div>}
      {tab === 'files' ? <div className="workspace-tree">
        {!root && !pending.has('tree:') && <button className="workspace-empty" onClick={() => void loadTree('')}>读取工作区</button>}
        {root && !root.entries.length && <p className="workspace-note">此目录为空。</p>}
        {rows.map(({ entry, depth }) => <button key={entry.path} className={`workspace-entry ${highlightedPath === entry.path ? 'selected' : ''}`} style={{ paddingLeft: 10 + depth * 16 }} aria-expanded={entry.kind === 'directory' ? expanded.has(entry.path) : undefined} onClick={() => toggle(entry)}>{entry.kind === 'directory' ? expanded.has(entry.path) ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : <span className="workspace-file-spacer" aria-hidden="true" />}<EntryIcon entry={entry} /><span title={entry.path}>{entry.name}</span>{entry.kind === 'file' && <small>{formatSize(entry.size)}</small>}</button>)}
        {Object.entries(trees).filter(([path, tree]) => expanded.has(path) && tree.truncated).map(([path, tree]) => <p key={path} className="workspace-note">{path || '工作目录'}内容过多，仅显示前 {tree.entries.length} 项</p>)}
      </div> : <div className="workspace-git">{!git?.available && git && <p className="workspace-note">当前目录不是 Git 仓库，或 Git 不可用。</p>}{gitEntries.map(entry => { const name = entry.path.split('/').pop() ?? entry.path; const folder = entry.path.slice(0, entry.path.length - name.length).replace(/\/$/, ''); return <button key={`${entry.status}:${entry.path}`} className={`workspace-git-entry ${gitStatusClass(entry.status)} ${highlightedPath === entry.path ? 'selected' : ''}`} title={`${entry.path} · ${entry.status}`} onClick={() => openDiff(entry.path)}><EntryIcon entry={{ name: entry.path, path: entry.path, kind: 'file' }} /><span className="workspace-git-name">{name}</span>{folder && <small>{folder}</small>}<code>{gitStatusLabel(entry.status)}</code></button>; })}{git?.available && !gitEntries.length && <p className="workspace-note">工作区没有未提交变更。</p>}</div>}
    </div>
    {(!embedded || !treeCollapsed) && <Splitter label="调整文件树宽度" value={shownTree} min={treeMin} max={treeMax} onChange={setTreeWidth} onCommit={value => writeLocalPreference(treeKey, String(value))} />}
    {embedded && <div className="workspace-combined-preview">
      {selection ? <WorkspaceFilePreview compact key={`${selection.kind}:${selection.path}:${previewRevision}`} sessionId={session.id} path={selection.path} kind={selection.kind} close={clearPreview} /> : <div className="preview-unavailable"><FileText size={28} /><p>选择文件以预览内容</p>{treeCollapsed && <button className="text-button" onClick={() => onTreeCollapsed?.(false)}>展开目录</button>}</div>}
    </div>}
    {previewOpen && <><div className="workspace-preview-pane">
      {visibleErrors.filter(([scope]) => scope === 'preview').map(([scope, message]) => <div key={scope} className="workspace-error" role="alert">{message}</div>)}
      <WorkspacePreviewContent preview={preview} sessionId={session.id} selectedPath={selectedPath} loading={pending.has('preview')} clearPreview={clearPreview} setPreview={setPreview} />
    </div>
    <Splitter label="调整预览宽度" value={shownPreview} min={PREVIEW.min} max={previewMax} onChange={setPreviewWidth} onCommit={value => writeLocalPreference(PREVIEW.key, String(value))} /></>}
    </div>
  </aside>;
}
