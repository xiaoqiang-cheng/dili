/** Canonical browser address only. Never changes a device's signed pairing or transport. */
export function relayPublicUrl(value: string): string {
  const url = new URL(value);
  if (url.origin === 'https://discoverpaw.com' && /^\/connect\/d\/[a-z0-9]{16}\/?$/.test(url.pathname)) {
    url.hostname = 'dili.discoverpaw.com';
  }
  return url.href;
}
