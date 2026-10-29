import assert from 'node:assert/strict';
import test from 'node:test';
import { cachedChatView, chatViews, syncChatViews, transcriptViews } from '../client/chat-view-cache.ts';
import type { Session } from '../shared/types.ts';
import type { AgentChatSnapshot } from '../shared/chat.ts';

test('recent views are bounded, identity-bound, cleared on restart and cannot authorize actions', () => {
  const contact = { id: 'a', backend: 'claude', nativeSessionId: 'native-a', forkPending: false, cwd: '/work' } as Session;
  const view: AgentChatSnapshot = { instanceId: 'one', nativeSessionId: 'native-a', revision: 2, connected: true, activeTurnId: 'busy', requests: [{ id: 'ask', kind: 'approval', title: 'Approve' }], truncated: false, items: [] };
  syncChatViews({ instanceId: 'one', sessions: [contact] });
  chatViews.put(contact, view);
  const cached = cachedChatView(contact)!;
  assert.equal(cached.connected, false); assert.equal(cached.activeTurnId, null); assert.deepEqual(cached.requests, []);
  assert.equal(view.connected, true, 'the authoritative snapshot is not mutated');
  assert.equal(chatViews.get({ ...contact, nativeSessionId: 'fork' }), null);
  chatViews.put(contact, view);
  const clock = Date.now;
  const now = clock();
  try { Date.now = () => now + 600_001; assert.equal(chatViews.get(contact), null); } finally { Date.now = clock; }
  chatViews.put(contact, view);
  syncChatViews({ instanceId: 'two', sessions: [contact] });
  assert.equal(chatViews.get(contact), null);
  for (let i = 0; i < 9; i++) chatViews.put({ ...contact, id: String(i) }, view);
  assert.equal(chatViews.get({ ...contact, id: '0' }), null);
  assert.ok(chatViews.get({ ...contact, id: '8' }));
  chatViews.put(contact, { ...view, items: [{ id: 'huge', type: 'assistant', text: 'x'.repeat(1_000_000), status: 'completed' }] });
  assert.equal(chatViews.get(contact), null);
  transcriptViews.put(contact, { messages: [], truncated: false });
  syncChatViews({ instanceId: 'two', sessions: [] });
  assert.equal(transcriptViews.get(contact), null);
});
