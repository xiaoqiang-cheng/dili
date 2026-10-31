import { appUrl } from './urls';

/** Streams the standalone HTML snapshot to a download; errors stay in the UI. */
export async function exportSessionHtml(session: { id: string; title: string }): Promise<void> {
  const response = await fetch(appUrl(`/api/sessions/${encodeURIComponent(session.id)}/export`), { credentials: 'same-origin' });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `导出失败（${response.status}）`);
  }
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const fallback = `${session.title || 'conversation'}.html`;
  let filename = fallback;
  if (encoded) { try { filename = decodeURIComponent(encoded); } catch { /* keep the readable fallback */ } }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
