import assert from 'node:assert/strict';
import { test } from 'node:test';
import { P2PHealth, parseP2PUpstreams } from './relay-p2p.ts';

test('P2P upstreams accept a default and per-device private addresses', () => {
  const parsed = parseP2PUpstreams('10.144.0.2:4318,abcdefghijklmnop=10.144.0.3:4318');
  assert.equal(parsed.default, '10.144.0.2:4318');
  assert.equal(parsed.devices.get('abcdefghijklmnop'), '10.144.0.3:4318');
  assert.equal(parseP2PUpstreams('[fd00::2]:4318').default, '[fd00::2]:4318');
  assert.throws(() => parseP2PUpstreams('https://example.com:4318'), /P2P 上游/);
  assert.throws(() => parseP2PUpstreams('10.144.0.2'), /P2P 上游/);
});

test('the P2P health cache falls back after a failed probe and recovers after the TTL', async () => {
  const parsed = parseP2PUpstreams('10.144.0.2:4318');
  let now = 1000, healthy = true, probes = 0;
  const health = new P2PHealth(parsed, async () => { probes++; return healthy; }, () => now, 5000);
  assert.equal(await health.upstream('one'), '10.144.0.2:4318');
  assert.equal(await health.upstream('two'), '10.144.0.2:4318');
  assert.equal(probes, 1);
  healthy = false;
  now += 5001;
  assert.equal(await health.upstream('one'), undefined);
  assert.equal(probes, 2);
  healthy = true;
  now += 5001;
  assert.equal(await health.upstream('one'), '10.144.0.2:4318');
  assert.equal(probes, 3);
});

test('the relay route prefers a healthy P2P target and keeps the device headers', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const { createServer } = await import('node:http');
  const { resolve } = await import('node:path');
  const { RelayStore } = await import('./relay-store.ts');
  const { createRelayApp } = await import('./relay-service.ts');
  const { decodeInvite, newSecret } = await import('./invite.ts');
  const db = new DatabaseSync(':memory:'), store = new RelayStore(db);
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise<void>(accept => server.once('listening', accept));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(accept => server.close(() => accept())); db.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/connect`;
  server.on('request', createRelayApp(store, {
    serverUrl: base, adminToken: 'admin', pluginToken: 'plugin', adminHtml: resolve('relay/index.html'),
    p2p: { upstream: async () => '10.144.0.2:4318' },
  }));
  const invite = store.createInvite(base, 'p2p', 24);
  const device = store.redeem(decodeInvite(invite.invite).secret, newSecret(), newSecret(), 'p2p device');
  const route = await fetch(`http://127.0.0.1:${address.port}/internal/route`, { headers: { 'x-forwarded-uri': `/connect/d/${device.id}/api/state` } });
  assert.equal(route.status, 200);
  assert.equal(route.headers.get('x-sessiondeck-upstream'), '10.144.0.2:4318');
  assert.equal(route.headers.get('x-dili-device-host'), new URL(base).host);
});
