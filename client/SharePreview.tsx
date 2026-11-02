import { useEffect, useState } from 'react';
import { Folder, Globe, X } from 'lucide-react';
import type { Session } from '../shared/types';
import { t } from '../shared/i18n';
import { api } from './api';
import { appUrl } from './urls';
import WorkspaceExplorer from './WorkspaceExplorer';
import './preview-workspace.css';
import type { FileSelection } from './usePreviewWorkspace';

/** Preview scope is always supplied by the share, never by a visitor path. */
export default function SharePreview({ session, groupId, close }: { session: Session; groupId?: string; close(): void }) {
  const [selection, setSelection] = useState<FileSelection>();
  const [treeCollapsed, setTreeCollapsed] = useState(false);
  const [tab, setTab] = useState<'files' | 'web'>('files');
  const [targets, setTargets] = useState<{ url: string; label: string }[]>([]);
  const [page, setPage] = useState('');
  const [error, setError] = useState('');
  const endpoint = `/${groupId ? 'groups' : 'sessions'}/${groupId ?? session.id}/web-previews`;
  useEffect(() => { let live = true; void api<typeof targets>(endpoint).then(value => { if (live) setTargets(value); }).catch(cause => { if (live) setError(cause.message); }); return () => { live = false; }; }, [endpoint]);
  const open = async (url: string) => {
    setError('');
    try { const value = await api<{ path: string; hash: string }>(endpoint, { url }); setPage(appUrl(value.path) + value.hash); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <aside className="share-preview preview-workspace">
    <header className="drawer-header"><button className="icon-button" title={t('share.files')} aria-pressed={tab === 'files'} onClick={() => setTab('files')}><Folder size={16} /></button><button className="icon-button" title={t('share.web')} aria-pressed={tab === 'web'} onClick={() => setTab('web')}><Globe size={16} /></button><span className="share-spacer" /><button className="icon-button" aria-label={t('common.close')} onClick={close}><X size={16} /></button></header>
    {tab === 'files' ? <WorkspaceExplorer session={session} groupId={groupId} embedded selection={selection} onSelectFile={setSelection} treeCollapsed={treeCollapsed} onTreeCollapsed={setTreeCollapsed} close={close} /> : <div className="share-web-preview">
      <div className="drawer-header">{targets.map(target => <button key={target.url} className="button secondary small-button" onClick={() => void open(target.url)}>{target.label}</button>)}{!targets.length && <p>{t('share.webEmpty')}</p>}</div>
      {error && <p role="alert" className="form-error">{error}</p>}
      {page && <iframe title={t('share.web')} src={page} sandbox="allow-scripts allow-forms allow-downloads" referrerPolicy="no-referrer" />}
    </div>}
  </aside>;
}
