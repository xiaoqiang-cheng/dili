import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RelayStore } from './relay-store.ts';
import { createRelayApp } from './relay-service.ts';

async function freePort() {
  const probe = createNetServer();
  await new Promise<void>(done => probe.listen(0, '127.0.0.1', done));
  const address = probe.address(); assert.ok(address && typeof address === 'object');
  await new Promise<void>(done => probe.close(() => done()));
  return address.port;
}

test('Dili asks its relay for an invite, keeps only a sealed receipt and forgets it on request', { timeout: 40_000 }, async t => {
  const db = new DatabaseSync(':memory:'), store = new RelayStore(db);
  const relayServer = createServer().listen(0, '127.0.0.1');
  await new Promise<void>(done => relayServer.once('listening', done));
  const relayAddress = relayServer.address(); assert.ok(relayAddress && typeof relayAddress !== 'string');
  const relay = `http://127.0.0.1:${relayAddress.port}/connect`;
  relayServer.on('request', createRelayApp(store, { serverUrl: relay, adminToken: 'admin-fixture', pluginToken: 'plugin-fixture', adminHtml: resolve('relay/index.html') }));

  const directory = await mkdtemp(join(tmpdir(), 'dili-invite-request-'));
  const client = join(directory, 'client'), data = join(directory, 'data');
  await mkdir(client, { recursive: true });
  await writeFile(join(client, 'index.html'), '<!doctype html>');
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: { ...process.env, PORT: String(port), SESSIONDECK_PORT: String(port), SESSIONDECK_HOST: '127.0.0.1', HOST: '127.0.0.1', SESSIONDECK_DATA_DIR: data, SESSIONDECK_CLIENT_DIR: client, SESSIONDECK_INVITE_RELAY_URL: relay },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = ''; child.stdout?.on('data', chunk => { logs += chunk; }); child.stderr?.on('data', chunk => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = new Promise<void>(done => child.once('exit', () => done()));
      child.kill('SIGTERM'); const hard = setTimeout(() => child.kill('SIGKILL'), 5000);
      await ended.finally(() => clearTimeout(hard));
    }
    relayServer.closeAllConnections(); await new Promise<void>(done => relayServer.close(() => done())); db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let csrf = '';
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null) assert.fail(`server exited: ${logs}`);
    try { const response = await fetch(`${base}/api/config`); if (response.ok) { csrf = (await response.json() as { csrfToken: string }).csrfToken; break; } } catch { /* not ready */ }
    await delay(50);
  }
  const call = async (method: string, body?: object) => {
    const response = await fetch(`${base}/api/remote/invite-request`, { method, headers: { 'content-type': 'application/json', 'x-sessiondeck-token': csrf, origin: base }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() as { request: { status: string; invite?: string; claim?: string } | null; error?: string } };
  };
  assert.deepEqual((await call('GET')).body, { request: null });
  assert.equal((await call('POST', { email: 'bad', name: 'A' })).status, 400);
  const created = await call('POST', { email: 'owner@example.com', name: '小强' });
  assert.equal(created.status, 201); assert.equal(created.body.request?.status, 'pending');
  assert.equal('claim' in (created.body.request ?? {}), false);
  assert.equal((await call('POST', { email: 'owner@example.com', name: '小强' })).status, 409);
  const [request] = store.requests();
  assert.equal(request?.email, 'owner@example.com');
  await fetch(`${relay}/api/admin/requests/${request!.id}/review`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer admin-fixture' }, body: JSON.stringify({ approve: true }) });
  const approved = await call('GET');
  assert.equal(approved.body.request?.status, 'approved');
  assert.match(approved.body.request?.invite ?? '', /^SD1\./);
  assert.deepEqual((await call('DELETE', {})).body, { request: null });
  assert.deepEqual((await call('GET')).body, { request: null });
});
