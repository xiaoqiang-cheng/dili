const KEY = 'dili.machines.v1';
export type Machine = { url: string; name: string };
export function machineUrl(value: string) {
  const url = new URL(value.trim());
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请输入完整的 http(s) 机器地址，不含密码、查询参数或分享链接。');
  url.pathname = url.pathname.replace(/\/*$/, '/');
  return url.href;
}
export function readMachines(): Machine[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(value) ? value.slice(0, 100).flatMap(item => {
      try { return typeof item.name === 'string' ? [{ url: machineUrl(item.url), name: item.name.slice(0, 80) }] : []; } catch { return []; }
    }) : [];
  } catch { return []; }
}
