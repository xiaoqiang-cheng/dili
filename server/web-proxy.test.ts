import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { WebProxy, parseProxyTarget } from './web-proxy.ts';

const upstream = createServer((req, res) => {
  if (req.url === '/redirect') { res.writeHead(302, { location: '/login?next=1' }); res.end(); return; }
  if (req.url === '/cookie') { res.writeHead(200, { 'set-cookie': 'sid=abc; Path=/; HttpOnly; SameSite=Strict' }); res.end('cookie'); return; }
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ url: req.url, method: req.method, body, host: req.headers.host, origin: req.headers.origin }));
  });
});
const proxy = new WebProxy();
let proxyServer: ReturnType<typeof createServer>;
let target: ReturnType<WebProxy['register']>;
let base = '';

before(async () => {
  await new Promise<void>(accept => upstream.listen(0, '127.0.0.1', accept));
  const address = upstream.address();
  assert.ok(address && typeof address === 'object');
  target = proxy.register(new URL(`http://127.0.0.1:${address.port}/`), { initialQuery: '?token=secret', initialCookie: 'dsh-auth-', hash: '#session' });
  proxyServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const match = /^\/base\/web-proxy\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!match || !proxy.handle(req, res, { token: match[1]!, suffix: match[2]?.replace(/^\//, '') ?? '', search: url.search, publicBase: '/base' })) {
      res.statusCode = 404; res.end('missing');
    }
  });
  proxyServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const match = /^\/base\/web-proxy\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!match || !proxy.handleUpgrade(req, socket, head, { token: match[1]!, suffix: match[2]?.replace(/^\//, '') ?? '', search: url.search })) socket.destroy();
  });
  await new Promise<void>(accept => proxyServer.listen(0, '127.0.0.1', accept));
  const proxyAddress = proxyServer.address();
  assert.ok(proxyAddress && typeof proxyAddress === 'object');
  base = `http://127.0.0.1:${proxyAddress.port}`;
});

after(async () => {
  await new Promise<void>(accept => proxyServer.close(() => accept()));
  await new Promise<void>(accept => upstream.close(() => accept()));
});

test('proxy forwards paths, the initial query and the request body', async () => {
  const echoed = await (await fetch(`${base}/base/web-proxy/${target.token}/api/status?x=1`, { method: 'POST', body: 'hello' })).json() as Record<string, string>;
  assert.equal(echoed.url, '/api/status?x=1');
  assert.equal(echoed.method, 'POST');
  assert.equal(echoed.body, 'hello');
  assert.match(echoed.host ?? '', /^127\.0\.0\.1:\d+$/);
});

test('proxy adds the private launch query only to the target root', async () => {
  const root = await (await fetch(`${base}/base/web-proxy/${target.token}/`)).json() as Record<string, string>;
  assert.equal(root.url, '/?token=secret');
  const asset = await (await fetch(`${base}/base/web-proxy/${target.token}/assets/app.js`)).json() as Record<string, string>;
  assert.equal(asset.url, '/assets/app.js');
  const reloaded = await (await fetch(`${base}/base/web-proxy/${target.token}/`, { headers: { cookie: 'dsh-auth-x=1' } })).json() as Record<string, string>;
  assert.equal(reloaded.url, '/', 'the one-time launch token must not be replayed after dsh has its cookie');
  const freshTab = await (await fetch(`${base}/base/web-proxy/${target.token}/`)).json() as Record<string, string>;
  assert.equal(freshTab.url, '/?token=secret', 'a fresh browser still needs the launch token');
});

test('proxy rewrites redirects and cookies into the public proxy prefix', async () => {
  const redirect = await fetch(`${base}/base/web-proxy/${target.token}/redirect`, { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), '/base/web-proxy/' + target.token + '/login?next=1');
  const cookie = await fetch(`${base}/base/web-proxy/${target.token}/cookie`);
  assert.equal(cookie.headers.get('set-cookie'), `sid=abc; Path=/base/web-proxy/${target.token}/; HttpOnly; SameSite=Strict`);
});

test('proxy rejects unknown targets and parses only HTTP targets', () => {
  assert.equal(proxy.get('missing'), undefined);
  assert.throws(() => parseProxyTarget('ftp://127.0.0.1/file'), /只支持/);
  assert.equal(parseProxyTarget('http://127.0.0.1:5173/').origin, 'http://127.0.0.1:5173');
});

test('proxy tunnels WebSocket upgrades without exposing the target origin', async () => {
  const socketServer = new WebSocketServer({ server: upstream });
  socketServer.on('connection', socket => socket.on('message', data => socket.send(`echo:${data.toString()}`)));
  const client = new WebSocket(`ws://${base.replace('http://', '')}/base/web-proxy/${target.token}/socket`);
  await new Promise<void>((accept, reject) => { client.once('open', accept); client.once('error', reject); });
  client.send('hello');
  const reply = await new Promise<string>(accept => client.once('message', data => accept(data.toString())));
  assert.equal(reply, 'echo:hello');
  client.close();
  socketServer.close();
});
