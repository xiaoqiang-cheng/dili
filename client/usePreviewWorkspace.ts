import { useEffect, useState } from 'react';
import type { Session } from '../shared/types';
import { parseServicePreviewUrl } from '../shared/service-preview';
import { appUrl } from './urls';
import { readLocalPreference, writeLocalPreference } from './ui';

type WorkspaceSource = { sessionId: string; cwd: string };
export type PreviewTab =
  | ({ id: string; kind: 'explorer' } & WorkspaceSource)
  | ({ id: string; kind: 'file' | 'diff'; path: string } & WorkspaceSource)
  | { id: 'scratchpad'; kind: 'note' }
  | { id: string; kind: 'web'; url: string };
type PreviewState = { tabs: PreviewTab[]; activeId: string | null; open: boolean };
const storageKey = () => `dili.preview-workspace:${appUrl('/')}`;
function restore(): PreviewState {
  const empty: PreviewState = { tabs: [], activeId: null, open: false };
  try {
    const saved = JSON.parse(readLocalPreference(storageKey()) ?? 'null');
    if (!saved || !Array.isArray(saved.tabs)) return empty;
    const seen = new Set<string>();
    const tabs: PreviewTab[] = [];
    for (const tab of saved.tabs.slice(0, 100)) {
      if (!tab || typeof tab.id !== 'string' || tab.id.length > 12000 || seen.has(tab.id)) continue;
      if (tab.kind === 'note' && tab.id === 'scratchpad') tabs.push({ id: tab.id, kind: 'note' });
      else if (tab.kind === 'web' && tab.id.startsWith('web:') && typeof tab.url === 'string') {
        const parsed = tab.url ? parseServicePreviewUrl(tab.url) : null;
        if (!tab.url || parsed?.ok) tabs.push({ id: tab.id, kind: 'web', url: parsed?.ok ? parsed.url : '' });
      }
      else if (['explorer', 'file', 'diff'].includes(tab.kind) && typeof tab.sessionId === 'string' && typeof tab.cwd === 'string') {
        if (tab.kind === 'explorer') tabs.push({ id: tab.id, kind: tab.kind, sessionId: tab.sessionId, cwd: tab.cwd });
        else if (typeof tab.path === 'string' && tab.path.length <= 4096) tabs.push({ id: tab.id, kind: tab.kind, sessionId: tab.sessionId, cwd: tab.cwd, path: tab.path });
      }
      seen.add(tab.id);
    }
    return { tabs, activeId: tabs.some(tab => tab.id === saved.activeId) ? saved.activeId : tabs[0]?.id ?? null, open: saved.open === true && tabs.length > 0 };
  } catch { return empty; }
}
export function usePreviewWorkspace() {
  const [state, setState] = useState(restore);
  useEffect(() => { writeLocalPreference(storageKey(), JSON.stringify(state)); }, [state]);
  const openTab = (tab: PreviewTab) => setState(current => ({ tabs: current.tabs.some(item => item.id === tab.id) ? current.tabs : [...current.tabs, tab], activeId: tab.id, open: true }));
  const openExplorer = (session: Session) => openTab({ id: `explorer:${JSON.stringify([session.id, session.cwd])}`, kind: 'explorer', sessionId: session.id, cwd: session.cwd });
  const openFile = (session: Session, path: string, kind: 'file' | 'diff') => openTab({ id: `${kind}:${JSON.stringify([session.id, session.cwd, path])}`, kind, sessionId: session.id, cwd: session.cwd, path });
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
  return { ...state, openExplorer, openFile, openNote, openWeb, select, close, navigate, hide, show };
}
export type PreviewWorkspaceController = ReturnType<typeof usePreviewWorkspace>;
