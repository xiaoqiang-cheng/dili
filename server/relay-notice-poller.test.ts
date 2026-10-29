import test from 'node:test';
import assert from 'node:assert/strict';
import { RelayNoticePoller } from './relay-notice-poller.ts';
import type { RelayNotice } from './relay-notices.ts';

const pair = { deviceId: 'abcdefghijklmnop', name: 'x', serverUrl: 'https://relay.example/connect', publicUrl: '', pairedAt: '', serverPort: 18700, credential: 'secret' };

test('a paired device collects relay notices, acknowledges them and stays idle while unpaired', async () => {
  const urls: string[] = [], delivered: RelayNotice[][] = [];
  let paired = false, answered = false;
  const fetcher = (async (url: string, init: RequestInit) => {
    urls.push(url);
    assert.equal((init.headers as Record<string, string>).authorization, 'Bearer secret');
    if (!answered) { answered = true; return Response.json({ notices: [{ id: 42, text: '你好', createdAt: new Date().toISOString() }] }); }
    // Later polls hang like the relay's long poll until the poller is closed.
    await new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))));
  }) as typeof fetch;
  const poller = new RelayNoticePoller(() => paired ? pair : null, notices => delivered.push(notices), fetcher);
  poller.start();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(urls.length, 0);
  paired = true; poller.wake();
  for (let i = 0; i < 50 && urls.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(urls, [`${pair.serverUrl}/api/devices/${pair.deviceId}/notices?after=0`, `${pair.serverUrl}/api/devices/${pair.deviceId}/notices?after=42`]);
  assert.deepEqual(delivered.map(list => list.map(notice => notice.text)), [['你好']]);
  await poller.close();
});
