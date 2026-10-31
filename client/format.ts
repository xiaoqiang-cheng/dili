/** Display-only formatting shared by the contact list, group cards and chat. */

export function relativeTime(value: string, now = Date.now()): string {
  const parsed = new Date(value).getTime();
  const minutes = Math.max(0, Math.floor((now - parsed) / 60000));
  if (!Number.isFinite(minutes)) return '—';
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  return `${Math.floor(minutes / 1440)} 天前`;
}

/** Last two path segments for compact cards; the full value stays in a title. */
export function shortPath(path: string): string {
  return path.replace(/\/$/, '').split('/').filter(Boolean).slice(-2).join('/') || path;
}
