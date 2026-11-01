import { DirectoryDialog } from './DirectoryField';
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowLeft, ChevronDown, FilePenLine, Folder, FolderOpen, Globe2, Maximize2, Minimize2, PanelRightClose, Plus, X } from 'lucide-react';
import type { Session } from '../shared/types';
import WorkspaceExplorer, { Splitter } from './WorkspaceExplorer';
import ScratchpadPanel from './ScratchpadPanel';
import ServicePreviewPanel from './ServicePreviewPanel';
import type { PreviewTab, PreviewWorkspaceController } from './usePreviewWorkspace';
import { appUrl } from './urls';
import { readLocalPreference, writeLocalPreference } from './ui';
import './preview-workspace.css';

function tabTitle(tab: PreviewTab, sessions: Session[]) {
  if (tab.kind === 'note') return '随手记';
  if (tab.kind === 'web') return tab.url ? new URL(tab.url).host : '新网页';
  if (tab.custom) return `文件 · ${tab.cwd.split('/').filter(Boolean).at(-1) || '/'}`;
  return `文件 · ${sessions.find(session => session.id === tab.sessionId)?.title ?? '工作区'}`;
}
function TabIcon({ tab }: { tab: PreviewTab }) {
  const Icon = tab.kind === 'note' ? FilePenLine : tab.kind === 'web' ? Globe2 : Folder;
  return <Icon size={14} aria-hidden="true" />;
}

type SourceTab = Extract<PreviewTab, { sessionId: string }>;
function WorkspaceTabContent({ tab, sessions, controller, close }: {
  tab: SourceTab; sessions: Session[]; controller: PreviewWorkspaceController; close: () => void;
}) {
  const [choosing, setChoosing] = useState(false);
  const session = sessions.find(item => item.id === tab.sessionId);
  if (!session || (!tab.custom && session.cwd !== tab.cwd)) return <div className="preview-unavailable">
    <Folder size={26} /><p>原工作区已移除或目录已改变。</p><p>请从当前联系人重新打开文件。</p>
  </div>;
  const picker = <div className="workspace-directory-controls">
    <select aria-label="资源管理器工作区" value={tab.custom ? '__custom__' : session.id} onChange={event => {
      const next = sessions.find(item => item.id === event.target.value);
      if (next) controller.openExplorer(next);
    }}>
      {tab.custom && <option value="__custom__">{tab.cwd}</option>}
      {sessions.filter(item => !item.archived || item.id === session.id).map(item => <option key={item.id} value={item.id}>{item.cwd}</option>)}
    </select>
    <button className="icon-button" aria-label="打开任意目录" title="打开目录" onClick={() => setChoosing(true)}><FolderOpen size={16} /></button>
    {choosing && <DirectoryDialog initialPath={tab.cwd} parent={null} close={() => setChoosing(false)} choose={path => { controller.openDirectory(session, path); setChoosing(false); }} />}
  </div>;
  return <WorkspaceExplorer session={session} root={tab.custom ? tab.cwd : undefined} embedded close={close} picker={picker}
    selection={tab.selection} treeCollapsed={tab.treeCollapsed ?? false}
    onTreeCollapsed={value => controller.collapseTree(tab.id, value)}
    onSelectFile={selection => controller.selectFile(tab.id, selection)} />;
}

export default function PreviewWorkspace({ controller, sessions, currentSession, inert, remote = false }: { controller: PreviewWorkspaceController; sessions: Session[]; currentSession?: Session; inert: boolean; remote?: boolean }) {
  const { tabs, activeId, open, select, close, hide } = controller;
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => { if (!open) setFullscreen(false); }, [open]);
  const prefix = useId();
  const panel = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  const [availableWidth, setAvailableWidth] = useState(1200);
  const widthKey = `dili.preview-width:${appUrl('/')}`;
  const [width, setWidth] = useState(() => {
    const value = Number(readLocalPreference(widthKey));
    return Number.isFinite(value) && value >= 320 ? value : 560;
  });
  useLayoutEffect(() => {
    const parent = panel.current?.parentElement;
    if (!parent) return;
    const observer = new ResizeObserver(([entry]) => setAvailableWidth(entry.contentRect.width));
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId, open, availableWidth]);
  const maxWidth = Math.max(320, availableWidth - (availableWidth >= 1100 ? 640 : 24));
  const shownWidth = Math.min(width, maxWidth);
  const focusTab = (id: string) => {
    select(id);
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus());
  };
  const closeTab = (id: string) => {
    const restoreFocus = list.current?.contains(document.activeElement);
    close(id);
    if (restoreFocus) requestAnimationFrame(() => {
      if (tabs.length > 1) list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
      else document.querySelector<HTMLButtonElement>('[aria-label="打开预览面板"]')?.focus();
    });
  };
  const tabKeys = (event: KeyboardEvent, index: number) => {
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else if (event.key === 'Delete') { event.preventDefault(); closeTab(tabs[index].id); return; }
    else return;
    event.preventDefault(); focusTab(tabs[next].id);
  };
  const add = (action: () => void) => { if (menu.current) menu.current.open = false; action(); };
  const note = tabs.find(tab => tab.kind === 'note');
  const tabId = (tab: PreviewTab) => `${prefix}-tab-${encodeURIComponent(tab.id)}`;
  const contentId = (tab: PreviewTab) => `${prefix}-content-${encodeURIComponent(tab.id)}`;
  return <aside ref={panel} className={`preview-workspace${fullscreen ? ' preview-fullscreen' : ''}`} aria-label="统一预览面板" hidden={!open} inert={inert} style={{ width: shownWidth }} onKeyDown={event => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (fullscreen) { setFullscreen(false); return; } hide(); document.querySelector<HTMLButtonElement>('[aria-label="打开预览面板"]')?.focus(); }
  }}>
    {!fullscreen && <Splitter label="调整预览面板宽度" value={shownWidth} min={320} max={maxWidth} direction={-1} onChange={setWidth} onCommit={value => writeLocalPreference(widthKey, String(value))} />}
    <header className="preview-workspace-header">
      <button className="icon-button preview-mobile-back" aria-label="返回工作台" title="返回工作台" onClick={hide}><ArrowLeft size={16} /></button>
      <div ref={list} className="preview-tab-list" role="tablist" aria-label="预览标签页">
        {tabs.map((tab, index) => <div key={tab.id} className={`preview-tab ${tab.id === activeId ? 'active' : ''}`}>
          <button type="button" id={tabId(tab)} role="tab" aria-selected={tab.id === activeId} aria-controls={contentId(tab)} tabIndex={tab.id === activeId ? 0 : -1} title={'cwd' in tab ? `${tabTitle(tab, sessions)}\n${tab.cwd}` : tab.kind === 'web' ? tab.url || '新网页' : '随手记 · 自动保存'} onClick={() => select(tab.id)} onKeyDown={event => tabKeys(event, index)}><TabIcon tab={tab} /><span>{tabTitle(tab, sessions)}</span></button>
          <button type="button" className="preview-tab-close" aria-label={`关闭标签 ${tabTitle(tab, sessions)}`} title="关闭标签" onClick={() => closeTab(tab.id)}><X size={12} /></button>
        </div>)}
      </div>
      <details ref={menu} className="preview-add-menu" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }} onKeyDown={event => { if (event.key === 'Escape' && menu.current?.open) { event.preventDefault(); menu.current.open = false; menu.current.querySelector('summary')?.focus(); } }}>
        <summary aria-label="新建预览标签" title="新建预览标签"><Plus size={16} /><ChevronDown size={10} /></summary>
        <div className="preview-add-options">
          <button type="button" disabled={!currentSession} onClick={() => add(() => { if (currentSession) controller.openExplorer(currentSession); })}><Folder size={15} /><span>浏览文件</span></button>
          <button type="button" onClick={() => add(controller.openNote)}><FilePenLine size={15} /><span>随手记</span></button>
          <button type="button" onClick={() => add(controller.openWeb)}><Globe2 size={15} /><span>新网页</span></button>
        </div>
      </details>
      <button type="button" className="icon-button" aria-label={fullscreen ? '退出预览全屏' : '全屏预览面板'} title={fullscreen ? '退出全屏（Esc）' : '全屏预览面板'} aria-pressed={fullscreen} onClick={() => setFullscreen(value => !value)}>{fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
      <button type="button" className="icon-button" aria-label="隐藏预览面板" title="隐藏面板，保留标签页" onClick={hide}><PanelRightClose size={16} /></button>
    </header>
    <div className="preview-workspace-body">
      {tabs.filter(tab => tab.kind !== 'note').map(tab => <div key={tab.id} id={contentId(tab)}
        role="tabpanel" aria-labelledby={tabId(tab)} className="preview-tab-content" hidden={activeId !== tab.id} tabIndex={0}>
        {tab.kind === 'web'
          ? <ServicePreviewPanel open embedded close={() => closeTab(tab.id)} inert={inert} remote={remote}
              initialUrl={tab.url} onNavigate={url => controller.navigate(tab.id, url)} />
          : <WorkspaceTabContent tab={tab} sessions={sessions} controller={controller} close={() => closeTab(tab.id)} />}
      </div>)}
      {/* Keep the note model alive even after closing its tab, so queued saves
          and local recovery keep the same guarantees as the original panel. */}
      <div id={note ? contentId(note) : undefined} role={note ? 'tabpanel' : undefined} aria-labelledby={note ? tabId(note) : undefined} className="preview-tab-content" hidden={!note || activeId !== note.id} tabIndex={0}>
        <ScratchpadPanel open={!!note} embedded close={() => closeTab('scratchpad')} inert={inert} />
      </div>
    </div>
  </aside>;
}
