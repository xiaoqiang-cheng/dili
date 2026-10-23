import { useEffect, useState } from 'react';
import type { Session } from '../shared/types';
import { parseServicePreviewUrl } from '../shared/service-preview';
import { appUrl } from './urls';
import { readLocalPreference, writeLocalPreference } from './ui';

type WorkspaceSource = { sessionId: string; cwd: string };
export type FileSelection = { path: string; kind: 'file' | 'diff' };
export type PreviewTab =
  | ({ id: string; kind: 'explorer'; selection?: FileSelection; treeCollapsed?: boolean } & WorkspaceSource)
  | { id: 'scratchpad'; kind: 'note' }
  | { id: string; kind: 'web'; url: string };
type PreviewState = { tabs: PreviewTab[]; activeId: string | null; open: boolean };
const storageKey = () => `dili.preview-workspace:${appUrl('/')}`;
const explorerId = (source: WorkspaceSource) => `explorer:${JSON.stringify([source.sessionId, source.cwd])}`;
function restore(): PreviewState {
  const empty: PreviewState = { tabs: [], activeId: null, open: false };
  try {
    const saved = JSON.parse(readLocalPreference(storageKey()) ?? 'null');
    if (!saved || !Array.isArray(saved.tabs)) return empty;
    const seen = new Set<string>();
    const tabs: PreviewTab[] = [];
    let activeId: string | null = null;
    for (const tab of saved.tabs.slice(0, 100)) {
      if (!tab || typeof tab.id !== 'string' || tab.id.length > 12000 || seen.has(tab.id)) continue;
      if (tab.kind === 'note' && tab.id === 'scratchpad') tabs.push({ id: tab.id, kind: 'note' });
      else if (tab.kind === 'web' && tab.id.startsWith('web:') && typeof tab.url === 'string') {
        const parsed = tab.url ? parseServicePreviewUrl(tab.url) : null;
        if (!tab.url || parsed?.ok) tabs.push({ id: tab.id, kind: 'web', url: parsed?.ok ? parsed.url : '' });
      }
      else if (['explorer', 'file', 'diff'].includes(tab.kind) && typeof tab.sessionId === 'string' && typeof tab.cwd === 'string') {
        const id = explorerId(tab);
        const selection = tab.kind === 'explorer' ? tab.selection : { path: tab.path, kind: tab.kind };
        const validSelection = selection && typeof selection.path === 'string' && selection.path.length <= 4096 && ['file', 'diff'].includes(selection.kind) ? selection as FileSelection : undefined;
        let workspace = tabs.find(item => item.id === id) as Extract<PreviewTab, { kind: 'explorer' }> | undefined;
        if (!workspace) { workspace = { id, kind: 'explorer', sessionId: tab.sessionId, cwd: tab.cwd }; tabs.push(workspace); }
        // Migrate individual file tabs into their workspace; the active file wins.
        if (validSelection && (!workspace.selection || tab.id === saved.activeId)) workspace.selection = validSelection;
        if (tab.kind === 'explorer') workspace.treeCollapsed = tab.treeCollapsed === true;
        if (tab.id === saved.activeId) activeId = id;
      }
      if (tab.id === saved.activeId && tabs.some(item => item.id === tab.id)) activeId = tab.id;
      seen.add(tab.id);
    }
    return { tabs, activeId: activeId ?? tabs[0]?.id ?? null, open: saved.open === true && tabs.length > 0 };
  } catch { return empty; }
}
export function usePreviewWorkspace() {
  const [state, setState] = useState(restore);
  useEffect(() => { writeLocalPreference(storageKey(), JSON.stringify(state)); }, [state]);
  const openTab = (tab: PreviewTab) => setState(current => ({ tabs: current.tabs.some(item => item.id === tab.id) ? current.tabs : [...current.tabs, tab], activeId: tab.id, open: true }));
  const openExplorer = (session: Session) => openTab({ id: explorerId({ sessionId: session.id, cwd: session.cwd }), kind: 'explorer', sessionId: session.id, cwd: session.cwd });
  const selectFile = (id: string, selection?: FileSelection) => setState(current => ({ ...current, tabs: current.tabs.map(tab => tab.id === id && tab.kind === 'explorer' ? { ...tab, selection } : tab) }));
  const collapseTree = (id: string, treeCollapsed: boolean) => setState(current => ({ ...current, tabs: current.tabs.map(tab => tab.id === id && tab.kind === 'explorer' ? { ...tab, treeCollapsed } : tab) }));
  const openNote = () => openTab({ id: 'scratchpad', kind: 'note' });
  const openWeb = () => openTab({ id: `web:${crypto.randomUUID()}`, kind: 'web', url: '' });
  const select = (id: string) => setState(current => current.tabs.some(tab => tab.id === id) ? { ...current, activeId: id, open: true } : current);
  const close = (id: string) => setState(current => {
    const index = current.tabs.findIndex(tab => tab.id === id);
    if (index < 0) return current;
    const tabs = current.tabs.filter(tab => tab.id !== id);
    return { tabs, activeId: current.activeId === id ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null) : current.activeId, open: current.open && tabs.length > 0 };
  });
  const navigate = (id: string, url: string) => setState(current => ({ ...current, tabs: current.tabs.map(tab => tab.kind === 'web' && tab.id === id ? { ...tab, url } : tab) }));
  const hide = () => setState(current => ({ ...current, open: false }));
  const show = () => setState(current => ({ ...current, open: current.tabs.length > 0 }));
  return { ...state, openExplorer, selectFile, collapseTree, openNote, openWeb, select, close, navigate, hide, show };
}
export type PreviewWorkspaceController = ReturnType<typeof usePreviewWorkspace>;
