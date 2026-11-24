import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiBridge } from './pi.ts';
import { PiChatAdapter } from './agents/pi-chat.ts';
import type { AgentChatSnapshot } from '../shared/chat.ts';

const waitFor = async (check: () => boolean, timeout = 4000): Promise<void> => {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for Pi fixture');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

test('Pi bridge drives the documented RPC protocol, settings and extension UI', { skip: process.platform === 'win32' ? 'fixture is a POSIX executable' : false }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'deck-pi-rpc-'));
  const saved = { bin: process.env.SESSIONDECK_PI_BIN, dir: process.env.PI_CODING_AGENT_DIR, sessions: process.env.PI_CODING_AGENT_SESSION_DIR };
  process.env.SESSIONDECK_PI_BIN = new URL('./fixtures/pi-rpc.mjs', import.meta.url).pathname;
  process.env.PI_CODING_AGENT_DIR = join(home, 'agent');
  process.env.PI_CODING_AGENT_SESSION_DIR = join(home, 'sessions');
  const bridge = new PiBridge();
  const id = await (async () => {
    const opened = await bridge.open({ nativeSessionId: null, cwd: home, title: 'Fixture' });
    return opened.nativeSessionId;
  })();
  t.after(async () => {
    await bridge.closeAll();
    if (saved.bin === undefined) delete process.env.SESSIONDECK_PI_BIN; else process.env.SESSIONDECK_PI_BIN = saved.bin;
    if (saved.dir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved.dir;
    if (saved.sessions === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR; else process.env.PI_CODING_AGENT_SESSION_DIR = saved.sessions;
    await rm(home, { recursive: true, force: true });
  });
  assert.match(id, /^[a-f\d-]{36}$/i);
  assert.equal(bridge.has(id), true);
  const settings = await bridge.readSettings(id);
  assert.equal(settings.model, 'fixture/fixture-model');
  assert.equal(settings.effort, 'off');
  assert.deepEqual(settings.efforts?.map(item => item.id), ['off', 'high']);
  assert.equal(settings.permission, null);
  assert.equal(settings.permissions.length, 0);
  assert.equal(settings.modelReason, undefined);

  const turn = await bridge.sendPrompt(id, 'hello');
  await waitFor(() => bridge.getStatus(id).status === 'idle' && !!bridge.snapshotSync(id).items.some(item => item.type === 'assistant' && item.text === 'Hello world'));
  let snapshot: AgentChatSnapshot = bridge.snapshotSync(id);
  assert.equal(snapshot.activeTurnId, null);
  assert.deepEqual(snapshot.items.map(item => item.type), ['user', 'assistant']);
  assert.equal(snapshot.items[0]!.text, 'hello');
  assert.equal(snapshot.items[1]!.text, 'Hello world');
  assert.equal(turn.turnId.length > 0, true);

  const updated = await bridge.updateSettings(id, { version: settings.version, field: 'effort', value: 'high' });
  assert.equal(updated.effort, 'high');
  const modelUpdated = await bridge.updateSettings(id, { version: updated.version, field: 'model', value: 'fixture/fixture-model' });
  assert.equal(modelUpdated.model, 'fixture/fixture-model');

  await bridge.sendPrompt(id, 'ask');
  await waitFor(() => bridge.snapshotSync(id).requests.length === 1);
  snapshot = bridge.snapshotSync(id);
  assert.equal(snapshot.requests[0]!.kind, 'approval');
  assert.equal(bridge.getStatus(id).status, 'waiting_approval');
  await bridge.answerRequest(id, snapshot.requests[0]!.id, { decision: 'yes' });
  await waitFor(() => bridge.getStatus(id).status === 'idle' && bridge.snapshotSync(id).items.some(item => item.type === 'assistant' && item.text === 'confirmed:true'));
  assert.equal(bridge.snapshotSync(id).requests.length, 0);

  await bridge.sendPrompt(id, 'slow');
  await waitFor(() => bridge.getStatus(id).status === 'running');
  await bridge.abort(id);
  await waitFor(() => bridge.getStatus(id).status === 'idle' && bridge.snapshotSync(id).activeTurnId === null);

  const first = await bridge.sendPrompt(id, 'slow');
  await waitFor(() => bridge.snapshotSync(id).activeTurnId === first.turnId);
  const second = await bridge.sendPrompt(id, 'ask');
  await waitFor(() => bridge.snapshotSync(id).activeTurnId === second.turnId && bridge.snapshotSync(id).requests.length === 1);
  snapshot = bridge.snapshotSync(id);
  await bridge.answerRequest(id, snapshot.requests[0]!.id, { decision: 'yes' });
  await waitFor(() => bridge.getStatus(id).status === 'idle' && bridge.snapshotSync(id).activeTurnId === null);
  snapshot = bridge.snapshotSync(id);
  const users = snapshot.items.filter(item => item.type === 'user');
  assert.equal(users.at(-2)?.text, 'slow');
  assert.equal(users.at(-1)?.text, 'ask', 'the follow-up is persisted as its own turn');

  const forked = await bridge.open({ nativeSessionId: null, forkFrom: id, cwd: home, title: 'Forked' });
  assert.notEqual(forked.nativeSessionId, id);
  assert.equal(bridge.has(forked.nativeSessionId), true);
  await bridge.close(forked.nativeSessionId);
  assert.equal(bridge.has(forked.nativeSessionId), false);

  const adapter = new PiChatAdapter({ bridge });
  await adapter.stopSession(id);
  assert.equal(bridge.has(id), true);
  adapter.dispose();

  await bridge.close(id);
  assert.equal(bridge.has(id), false);
  assert.equal(bridge.getStatus(id).status, 'stopped');
  const resumed = await bridge.open({ nativeSessionId: id, cwd: home, title: 'Resumed' });
  assert.equal(resumed.nativeSessionId, id);
  assert.equal(bridge.has(id), true);
  await bridge.close(id);
});
