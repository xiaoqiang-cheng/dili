import { randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * An authenticated, host-side HTTP/WebSocket proxy for local web services.
 *
 * The proxy is deliberately stateful but ephemeral: the browser only receives
 * an opaque capability token, while the upstream origin lives in this process.
 * That keeps a remote PWA from using Dili as an arbitrary-address proxy, and it
 * keeps upstream query tokens (for example dsh's launch token) out of the
 * browser-visible URL.
 */
export type WebProxyTarget = {
  token: string;
  origin: string;
  basePath: string;
  initialQuery: string;
  initialCookie: string;
  hash: string;
  label: string;
  rewriteOrigin: boolean;
  expiresAt: number;
};

type RegisterOptions = {
  label?: string;
  initialQuery?: string;
  initialCookie?: string;
  hash?: string;
  rewriteOrigin?: boolean;
  ttlMs?: number;
};

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_TARGETS = 256;

function normalizedBasePath(pathname: string): string {
  if (!pathname || pathname === '/') return '/';
  return `${pathname.replace(/\/+$/, '')}/`;
}

function cookieHeader(value: string | undefined, strip: string[]): string | undefined {
  if (!value) return undefined;
  const kept = value.split(';').map(part => part.trim()).filter(part => {
    const name = part.split('=', 1)[0]?.trim();
    return !!name && !strip.includes(name);
  });
  return kept.length ? kept.join('; ') : undefined;
}

function requestHeaders(
  req: IncomingMessage,
  target: WebProxyTarget,
  stripCookies: string[],
  upgrade = false,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { ...req.headers };
  for (const name of HOP_BY_HOP) if (!upgrade || (name !== 'connection' && name !== 'upgrade')) delete headers[name];
  headers.host = new URL(target.origin).host;
  headers['x-forwarded-host'] = req.headers.host;
  headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] ?? 'http';
  const cookie = cookieHeader(req.headers.cookie, stripCookies);
  if (cookie) headers.cookie = cookie;
  else delete headers.cookie;
  if (target.rewriteOrigin) {
    if (headers.origin) headers.origin = target.origin;
    if (typeof headers.referer === 'string') {
      try {
        const referer = new URL(headers.referer);
        headers.referer = `${target.origin}${referer.pathname}${referer.search}`;
      } catch { /* Leave malformed referers untouched. */ }
    }
  }
  return headers;
}

function rewriteLocation(value: string, target: WebProxyTarget, proxyPath: string): string {
  if (value.startsWith('/') && !value.startsWith('//')) return `${proxyPath}${value.slice(1)}`;
  try {
    const url = new URL(value);
    if (url.origin === target.origin) return `${proxyPath}${url.pathname.replace(/^\/+/, '')}${url.search}${url.hash}`;
  } catch { /* Relative redirects already resolve under the proxy prefix. */ }
  return value;
}

function rewriteSetCookie(value: string, proxyPath: string): string {
  const [first, ...rest] = value.split(';');
  if (!first) return value;
  const kept = rest.filter(part => {
    const key = part.trim().split('=', 1)[0]?.toLowerCase();
    return key !== 'domain' && key !== 'path';
  });
  return [first.trim(), `Path=${proxyPath}`, ...kept.map(part => part.trim())].join('; ');
}

export class WebProxy {
  private readonly targets = new Map<string, WebProxyTarget>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  register(url: URL, options: RegisterOptions = {}): WebProxyTarget {
    for (const [token, target] of this.targets) if (target.expiresAt <= this.now()) this.targets.delete(token);
    while (this.targets.size >= MAX_TARGETS) {
      const oldest = this.targets.keys().next().value as string | undefined;
      if (!oldest) break;
      this.targets.delete(oldest);
    }
    const token = randomBytes(24).toString('base64url');
    const target: WebProxyTarget = {
      token,
      origin: url.origin,
      basePath: normalizedBasePath(url.pathname),
      initialQuery: options.initialQuery ?? '',
      initialCookie: options.initialCookie ?? '',
      hash: options.hash ?? url.hash,
      label: options.label ?? `${url.host}${url.pathname}`,
      rewriteOrigin: options.rewriteOrigin ?? false,
      expiresAt: this.now() + (options.ttlMs ?? DEFAULT_TTL_MS),
    };
    this.targets.set(token, target);
    return target;
  }

  get(token: string): WebProxyTarget | undefined {
    const target = this.targets.get(token);
    if (!target) return undefined;
    if (target.expiresAt <= this.now()) { this.targets.delete(token); return undefined; }
    return target;
  }

  private upstreamUrl(target: WebProxyTarget, suffix: string, search: string, cookie?: string): URL {
    const path = suffix ? `${target.basePath}${suffix.replace(/^\/+/, '')}` : target.basePath;
    const url = new URL(path, `${target.origin}/`);
    // dsh redirects its one-time launch token to an auth cookie. Replaying the
    // token after the cookie exists makes dsh redirect forever, while a fresh
    // tab or another browser still needs the token to authenticate.
    const hasInitialCookie = !!target.initialCookie && (cookie ?? '').split(';').some(part => part.trim().startsWith(target.initialCookie));
    const initial = !suffix && !hasInitialCookie ? target.initialQuery : '';
    if (initial) url.search = initial.replace(/^\?/, '') + (search ? `&${search.replace(/^\?/, '')}` : '');
    else url.search = search;
    return url;
  }

  handle(
    req: IncomingMessage,
    res: ServerResponse,
    route: { token: string; suffix: string; search: string; publicBase: string; stripCookies?: string[] },
  ): boolean {
    const target = this.get(route.token);
    if (!target) return false;
    const proxyPath = `${route.publicBase}/web-proxy/${target.token}/`;
    const upstream = this.upstreamUrl(target, route.suffix, route.search, req.headers.cookie);
    const transport = upstream.protocol === 'https:' ? https : http;
    let responded = false;
    // EventSource/SSE can legitimately stay quiet for minutes; a socket timeout
    // here would silently cut live agent output. Ordinary requests keep a bound.
    const streaming = String(req.headers.accept ?? '').includes('text/event-stream');
    const request = transport.request(upstream, {
      method: req.method,
      headers: requestHeaders(req, target, route.stripCookies ?? []),
      timeout: streaming ? 0 : 120_000,
    }, response => {
      responded = true;
      res.statusCode = response.statusCode ?? 502;
      for (const [name, value] of Object.entries(response.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name)) continue;
        if (name === 'set-cookie') {
          res.setHeader(name, (Array.isArray(value) ? value : [value]).map(cookie => rewriteSetCookie(cookie, proxyPath)));
        } else if (name === 'location') {
          res.setHeader(name, rewriteLocation(String(value), target, proxyPath));
        } else {
          res.setHeader(name, value);
        }
      }
      response.on('error', () => res.destroy());
      response.pipe(res);
    });
    request.on('timeout', () => request.destroy(new Error('上游服务响应超时')));
    request.on('error', error => {
      if (res.headersSent) { res.destroy(); return; }
      responded = true;
      res.statusCode = 502;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end(`无法连接主机上的服务：${error.message}`);
    });
    req.on('aborted', () => request.destroy());
    res.on('close', () => { if (!responded) request.destroy(); });
    req.pipe(request);
    return true;
  }

  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    route: { token: string; suffix: string; search: string; stripCookies?: string[] },
  ): boolean {
    const target = this.get(route.token);
    if (!target) return false;
    const upstream = this.upstreamUrl(target, route.suffix, route.search, req.headers.cookie);
    const transport = upstream.protocol === 'https:' ? https : http;
    const request = transport.request(upstream, {
      method: 'GET',
      headers: requestHeaders(req, target, route.stripCookies ?? [], true),
    });
    // Do not put a socket timeout on a WebSocket: it would close a healthy idle
    // terminal after the handshake. Use a one-shot handshake timer instead.
    let upgraded = false;
    const handshake = setTimeout(() => request.destroy(new Error('上游 WebSocket 响应超时')), 30_000);
    request.on('upgrade', (response, upstreamSocket, upstreamHead) => {
      upgraded = true;
      clearTimeout(handshake);
      const lines = [`HTTP/1.1 101 Switching Protocols`];
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        lines.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`);
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) upstreamSocket.write(head);
      if (upstreamHead.length) socket.write(upstreamHead);
      upstreamSocket.on('error', () => socket.destroy());
      socket.on('error', () => upstreamSocket.destroy());
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
    });
    request.on('response', response => {
      clearTimeout(handshake);
      response.resume();
      if (!socket.destroyed) socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      socket.destroy();
    });
    request.on('error', () => { clearTimeout(handshake); if (!socket.destroyed) socket.destroy(); });
    socket.on('error', () => request.destroy());
    socket.on('close', () => { clearTimeout(handshake); if (!upgraded) request.destroy(); });
    request.end();
    return true;
  }
}

export function parseProxyTarget(value: string): URL {
  const trimmed = value.trim();
  const url = new URL(trimmed);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('只支持 http 或 https 服务');
  if (url.username || url.password) throw new Error('服务地址不能包含账号密码');
  return url;
}
