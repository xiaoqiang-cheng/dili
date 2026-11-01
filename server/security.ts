import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';

export function allowedRequest(req: Pick<IncomingMessage, 'headers'>, port: number, allowAnyHost = false): boolean {
  const requestHost = req.headers.host;
  if (!requestHost) return false;
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (allowAnyHost) {
    try {
      const url = new URL(`http://${requestHost}`);
      if (url.host !== requestHost || url.port !== String(port)) return false;
    } catch { return false; }
  } else if (!hosts.has(requestHost)) return false;
  const origin = req.headers.origin;
  const origins = allowAnyHost ? new Set([`http://${requestHost}`]) : new Set([...hosts].map(h => `http://${h}`));
  if (origin && !origins.has(origin)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  return true;
}

export function validToken(value: unknown, expected: string): boolean {
  if (typeof value !== 'string') return false;
  const actual = Buffer.from(value);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

/**
 * The remote listener is only reached through the tunnel and reverse proxy, so
 * it accepts the configured public host (plus its own loopback address for
 * debugging) and a matching Origin. Loopback trust never applies there.
 */
export function allowedRemoteRequest(req: Pick<IncomingMessage, 'headers' | 'method'> & Pick<Partial<IncomingMessage>, 'url'>, publicUrl: string, localPort: number): boolean {
  const requestHost = req.headers.host;
  if (!requestHost) return false;
  const publicHost = publicUrl ? new URL(publicUrl).host : null;
  const hosts = new Set([`127.0.0.1:${localPort}`, `localhost:${localPort}`, ...(publicHost ? [publicHost] : [])]);
  if (!hosts.has(requestHost)) return false;
  const origin = req.headers.origin;
  const origins = new Set([`http://127.0.0.1:${localPort}`, `http://localhost:${localPort}`, ...(publicUrl ? [new URL(publicUrl).origin] : [])]);
  if (origin && !origins.has(origin)) return false;
  // Browsers always send Origin on cross-origin mutations; require it remotely
  // so a missing header cannot stand in for a same-origin request.
  if (!origin && req.method && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    // Opening a shared device link from another website is a normal top-level
    // navigation. Allow only the read-only app entry; API/fetch, frames,
    // WebSocket upgrades and all mutations keep their same-origin boundary.
    // The relay strips the verified device prefix before forwarding this URL.
    const entryNavigation = !origin && !req.headers.upgrade
      && ['GET', 'HEAD'].includes(req.method ?? '') && req.url?.split('?')[0] === '/'
      && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
    if (!entryNavigation) return false;
  }
  return true;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) {
      try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return undefined; }
    }
  }
  return undefined;
}

/**
 * The remote listener may be bound to a private interface. Host/Origin
 * checks alone would then expose it to every device on that interface, so the
 * socket source is restricted independently: loopback (FRP/local Caddy/SSH
 * forwards) plus the explicitly configured peer addresses.
 */
const loopbackSources = new BlockList();
loopbackSources.addSubnet('127.0.0.0', 8, 'ipv4');
loopbackSources.addAddress('::1', 'ipv6');

export function parseRemoteSources(value: string): BlockList {
  const list = new BlockList();
  for (const raw of value.split(',').map(item => item.trim()).filter(Boolean)) {
    const [address, prefix, extra] = raw.split('/');
    const family = isIP(address ?? '');
    if (!family || extra !== undefined || prefix !== undefined && !/^\d{1,3}$/.test(prefix)) throw new Error(`SESSIONDECK_REMOTE_ALLOW 包含无效来源：${raw}`);
    if (prefix === undefined) list.addAddress(address!, family === 4 ? 'ipv4' : 'ipv6');
    else {
      const bits = Number(prefix);
      if (bits < 0 || bits > (family === 4 ? 32 : 128)) throw new Error(`SESSIONDECK_REMOTE_ALLOW 前缀无效：${raw}`);
      list.addSubnet(address!, bits, family === 4 ? 'ipv4' : 'ipv6');
    }
  }
  return list;
}

export function remoteSourceAllowed(address: string | undefined, allow: BlockList): boolean {
  if (!address) return false;
  const normalized = address.split('%', 1)[0]!;
  const mapped = normalized.startsWith('::ffff:') && isIP(normalized.slice(7)) === 4 ? normalized.slice(7) : normalized;
  const family = isIP(mapped);
  if (!family) return false;
  return loopbackSources.check(mapped, family === 4 ? 'ipv4' : 'ipv6') || allow.check(mapped, family === 4 ? 'ipv4' : 'ipv6');
}
