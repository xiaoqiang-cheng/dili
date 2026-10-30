import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { registerAgentChat } from './chat-api.ts';
import type { AgentChatSnapshot } from '../shared/chat.ts';
import type { Session } from '../shared/types.ts';

test('HTTP and SSE share a pending read, while a new native identity reads independently', async t => {
  const contact = { id: 'contact', backend: 'claude', nativeSessionId: 'old', running: true, forkPending: false, cwd: '/work' } as Session;
  const jobs: { id: string; resolve: (value: AgentChatSnapshot) => void }[] = [];
  const app = express();
  const api = registerAgentChat(app, {
    store: { session: () => contact, onChange: () => () => {} },
    adapters: { claude: {
      readChat: (id: string) => new Promise<AgentChatSnapshot>(resolve => jobs.push({ id, resolve })),
      chatSnapshot: () => undefined, onChat: () => () => {},
    } },
    instanceId: 'test', demo: false, closing: () => false, ready: () => true, sessions: () => [contact],
  } as unknown as Parameters<typeof registerAgentChat>[1]);
  app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status ?? 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/sessions/contact/chat`;
  const abort = new AbortController();
  t.after(async () => { abort.abort(); api.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const waitFor = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(check());
  };
  const first = fetch(url);
  await waitFor(() => jobs.length === 1);
  const second = fetch(url);
  const stream = await fetch(url + '/events', { signal: abort.signal });
  const reader = stream.body!.getReader();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(jobs.length, 1, 'SSE and both HTTP requests use one native history read');
  contact.nativeSessionId = 'new';
  const fresh = fetch(url);
  await waitFor(() => jobs.length === 2);
  assert.equal(jobs[1].id, 'new');
  const snapshot = (id: string): AgentChatSnapshot => ({ nativeSessionId: id, connected: true, revision: 0, activeTurnId: null, items: [], requests: [], truncated: false });
  jobs[0].resolve(snapshot('old'));
  jobs[1].resolve(snapshot('new'));
  assert.equal((await first).status, 409);
  assert.equal((await second).status, 409);
  assert.equal((await (await fresh).json()).nativeSessionId, 'new');
  const event = await reader.read();
  assert.match(new TextDecoder().decode(event.value), /unavailable/);
  reader.releaseLock();
  const after = fetch(url);
  await waitFor(() => jobs.length === 3);
  jobs[2].resolve(snapshot('new'));
  assert.equal((await after).status, 200, 'completed jobs do not become a stale response cache');
});
