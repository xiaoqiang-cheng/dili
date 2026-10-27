import { appUrl } from './urls';

export function machineHome() {
  const value = new URLSearchParams(location.search).get('machineHome');
  try {
    const url = new URL(value || '');
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.hash === '#/machines') return url.href;
  } catch { /* A normal machine visit has no launcher return URL. */ }
  return '';
}
/** Only the official relay alias is rewritten; private/custom deployments stay untouched. */
export function publicMachineUrl(value: string) {
  const url = new URL(value);
  if (url.origin === 'https://discoverpaw.com' && /^\/connect\/d\/[a-z0-9]{16}\/?$/.test(url.pathname)) url.hostname = 'dili.discoverpaw.com';
  return url.href;
}
export function openMachine(url: string, home = new URL(appUrl('/#/machines'), location.origin).href) {
  const target = new URL(publicMachineUrl(url));
  target.searchParams.set('machineHome', home);
  target.hash = '/contacts';
  return target.href;
}
// Invite fragments are removed before authentication or rendering, and kept
// only in memory. They never enter HTTP requests or persistent card storage.
let incomingInvite = '';
export function capturePairingInvite() {
  if (!location.hash.startsWith('#/pair?')) return;
  const params = new URLSearchParams(location.hash.slice(7));
  if (!params.has('invite')) return;
  incomingInvite = params.get('invite') || '';
  params.delete('invite');
  history.replaceState(null, '', `${location.pathname}${location.search}#/pair?${params}`);
}
capturePairingInvite();
export function pairingInvite() { return incomingInvite; }
export function clearPairingInvite() { incomingInvite = ''; }
