import { Braces, File, FileCode2, FileImage, FileText, Folder } from 'lucide-react';
import { appUrl } from './urls';

export type Entry = { name: string; path: string; kind: 'file' | 'directory'; size?: number };
export type Tree = { path: string; entries: Entry[]; truncated: boolean };
export type FileResult = { path: string; content: string; truncated: boolean; binary: boolean; size: number };
export type DiffResult = { path: string; diff: string; truncated?: boolean; available: boolean };
export type GitStatus = { entries: { path: string; status: string }[]; available: boolean };
type MediaKind = 'image' | 'video' | 'audio';
export type HtmlMode = 'preview' | 'source';
export type Preview =
  | { kind: 'file'; result: FileResult }
  | { kind: 'diff'; result: DiffResult }
  | { kind: 'html'; result: FileResult; mode: HtmlMode; generation: number }
  | { kind: 'media'; path: string; media: MediaKind };

export function markdownPath(path: string) { return /\.(?:md|markdown|mdx)$/i.test(path); }
export function htmlPath(path: string) { return /\.html?$/i.test(path); }
export function mediaKind(path: string): MediaKind | null {
  if (/\.(?:png|jpe?g|gif|webp|svg|ico|bmp)$/i.test(path)) return 'image';
  if (/\.(?:mp4|webm|mov|ogv)$/i.test(path)) return 'video';
  if (/\.(?:mp3|wav|ogg|m4a|aac)$/i.test(path)) return 'audio';
  return null;
}
export function workspaceRawUrl(sessionId: string, path: string) {
  return appUrl(`/api/sessions/${encodeURIComponent(sessionId)}/workspace/raw/${path.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`);
}
export function formatSize(size?: number) { if (size === undefined) return ''; if (size < 1024) return `${size} B`; if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`; return `${(size / 1024 / 1024).toFixed(1)} MB`; }
function fileIconClass(path: string) {
  const name = path.split('/').pop() ?? path;
  if (markdownPath(name)) return 'workspace-file-icon-markdown';
  if (/\.(?:tsx?|jsx?|mjs|cjs|vue|svelte|py|rb|go|rs|java|kt|swift|c|cpp|h|hpp|css|scss|less|html|xml)$/i.test(name)) return 'workspace-file-icon-code';
  if (/\.(?:json|ya?ml|toml|ini|env)$/i.test(name) || /^(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(name)) return 'workspace-file-icon-config';
  if (/\.(?:png|jpe?g|gif|webp|svg|ico|bmp)$/i.test(name)) return 'workspace-file-icon-image';
  if (/\.(?:mp4|webm|mov|ogv|mp3|wav|ogg|m4a|aac)$/i.test(name)) return 'workspace-file-icon-media';
  return 'workspace-file-icon-file';
}
export function EntryIcon({ entry }: { entry: Entry }) {
  if (entry.kind === 'directory') return <Folder size={14} className="workspace-entry-icon workspace-folder-icon" />;
  const className = fileIconClass(entry.path);
  const Icon = className.endsWith('-markdown') ? FileText : className.endsWith('-config') ? Braces : className.endsWith('-image') || className.endsWith('-media') ? FileImage : className.endsWith('-code') ? FileCode2 : File;
  return <Icon size={14} className={`workspace-entry-icon ${className}`} />;
}
export function gitStatusClass(status: string) {
  if (status === '??' || status.includes('A')) return 'git-added';
  if (status.includes('D')) return 'git-deleted';
  if (status.includes('R')) return 'git-renamed';
  if (status.includes('U')) return 'git-conflict';
  return 'git-modified';
}
export function gitStatusLabel(status: string) {
  if (status === '??') return 'U';
  return status.replace(/\s/g, '').at(-1) ?? status;
}

