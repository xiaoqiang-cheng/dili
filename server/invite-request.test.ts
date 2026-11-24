import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { RelayStore } from './relay-store.ts';
import { createRelayApp } from './relay-service.ts';
import { encodeInvite, newSecret } from './invite.ts';
import { inviteRequestState, submitInviteRequest } from './invite-request.ts';

test('a machine requests an invite from the relay and collects it once approved', async t => {
  const db = new DatabaseSync(':memory:'), store = new RelayStore(db);
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); db.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const relay = `http://127.0.0.1:${address.port}/connect`;
  server.on('request', createRelayApp(store, { serverUrl: relay, adminToken: 'admin-fixture', pluginToken: 'plugin-fixture', adminHtml: resolve('relay/index.html') }));
  await assert.rejects(submitInviteRequest(relay, 'not-an-email', 'A'), /电子邮箱/);
  await assert.rejects(submitInviteRequest(relay, 'a@example.com', ' '), /称呼/);
  const receipt = await submitInviteRequest(relay, ' A@Example.com ', ' 小强 ');
  assert.deepEqual([receipt.serverUrl, receipt.email, receipt.name], [relay, 'a@example.com', '小强']);
  assert.equal((await inviteRequestState(receipt)).status, 'pending');
  // A guessed id without the receipt learns nothing.
  await assert.rejects(inviteRequestState({ ...receipt, claim: newSecret() }), /找不到/);
  const review = await fetch(`${relay}/api/admin/requests/${receipt.id}/review`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer admin-fixture' }, body: JSON.stringify({ approve: true }) });
  assert.equal(review.status, 200);
  const approved = await inviteRequestState(receipt);
  assert.deepEqual([approved.status, approved.inviteStatus], ['approved', 'ready']);
  assert.match(approved.invite ?? '', /^SD1\./);
  assert.equal('claim' in approved, false);
});

test('an unreachable relay keeps the request, and a code for another relay is ignored', async () => {
  const receipt = { serverUrl: 'https://relay.example/connect', id: 'r1', claim: newSecret(), email: 'a@example.com', name: 'A', createdAt: '' };
  const offline = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
  const down = await inviteRequestState(receipt, offline);
  assert.equal(down.status, 'unknown'); assert.match(down.error ?? '', /无法连接/);
  const foreign = (async () => Response.json({ status: 'approved', inviteStatus: 'ready', invite: encodeInvite('https://evil.example/connect', newSecret()) })) as unknown as typeof fetch;
  const result = await inviteRequestState(receipt, foreign);
  assert.equal(result.invite, undefined); assert.match(result.error ?? '', /不一致/);
});
