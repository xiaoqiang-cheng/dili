import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from './store.ts';
import { StatePublisher } from './state.ts';
import { applyGroupRead, applyStatePatch } from '../client/state.ts';

test('group read receipts clear member badges without dropping other pending changes or newer reminders', t => {
  const store = new Store(':memory:');
  const group = store.addGroup('群聊', '');
  const done = store.addSession({ backend: 'claude', title: '完成', cwd: '/tmp', groupId: group.id, status: 'waiting_input', unread: 2 });
  const approval = store.addSession({ backend: 'codex', title: '审批', cwd: '/tmp', groupId: group.id, status: 'waiting_approval', unread: 1 });
  const outsider = store.addSession({ backend: 'dsh', title: '群外', cwd: '/tmp', unread: 3 });
  store.updateGroup(group.id, { unread: 4 });
  const publisher = new StatePublisher(store, { instanceId: 'read-receipts', backends: [], defaultCwd: '/tmp', demo: true });
  t.after(() => { publisher.close(); store.close(); });
  const before = publisher.snapshot();
  store.updateSession(outsider.id, { title: '并发改名' });
  const read = store.markGroupRead(group.id);
  const snapshot = publisher.snapshot();
  const receipt = { ...read, instanceId: snapshot.instanceId!, revision: snapshot.revision!, members: snapshot.sessions.filter(item => item.groupId === group.id) };
  const applied = applyGroupRead(before, receipt)!;
  assert.equal(applied.groups[0].unread, 0);
  assert.equal(applied.sessions.find(item => item.id === done.id)!.unread, 0);
  assert.equal(applied.sessions.find(item => item.id === approval.id)!.unread, 1);
  assert.equal(applied.sessions.find(item => item.id === outsider.id)!.unread, 3);
  assert.equal(applied.revision, before.revision, 'partial receipt cannot advance the global patch cursor');
  assert.deepEqual(applyStatePatch(applied, publisher.takePatch()!), snapshot);
  store.updateGroup(group.id, { unread: 1 });
  store.updateSession(done.id, { unread: 1 });
  const newer = publisher.snapshot();
  assert.equal(applyGroupRead(newer, receipt), newer, 'late read cannot hide a later reply');
  assert.equal(applyGroupRead(before, { ...receipt, instanceId: 'restarted' }), before);
  assert.equal(applyGroupRead(null, receipt), null);
});

test('committed metadata produces small ordered patches without full table rereads', t => {
  const store = new Store(':memory:');
  for (let i = 0; i < 500; i++) store.addSession({ backend: 'codex', title: `contact ${i}`, cwd: '/tmp' });
  const publisher = new StatePublisher(store, { instanceId: 'first', backends: [], defaultCwd: '/tmp', demo: true });
  t.after(() => { publisher.close(); store.close(); });
  const before = publisher.snapshot();
  store.sessions = () => assert.fail('must not reread all sessions');
  store.groups = () => assert.fail('must not reread all groups');
  store.activities = () => assert.fail('must not reread all activities');
  store.updateSession(before.sessions[10].id, { status: 'running' });
  const during = publisher.snapshot();
  store.updateSession(before.sessions[11].id, { status: 'waiting_approval' });
  const patch = publisher.takePatch()!;
  assert.equal(patch.sessions!.length, 2);
  assert.equal(patch.groups, undefined);
  assert.ok(JSON.stringify(patch).length < JSON.stringify(before).length / 100);
  const applied = applyStatePatch(before, patch)!;
  assert.deepEqual(applied, publisher.snapshot());
  assert.equal(applied.sessions[0], before.sessions[0], 'unchanged contacts preserve references');
  assert.deepEqual(applyStatePatch(during, patch), applied, 'HTTP snapshot may overlap an unpublished patch');
  assert.equal(applyStatePatch(applied, patch), applied, 'duplicate patch is ignored');
  assert.equal(applyStatePatch(before, { ...patch, baseRevision: patch.revision + 1, revision: patch.revision + 2 }), null);
  assert.equal(applyStatePatch(before, { ...patch, instanceId: 'restarted' }), null);
  assert.equal(publisher.takePatch(), null);
});

test('rolled back rows never escape through snapshots or delta events', t => {
  const store = new Store(':memory:');
  const publisher = new StatePublisher(store, { instanceId: 'first', backends: [], defaultCwd: '/tmp', demo: true });
  t.after(() => { publisher.close(); store.close(); });
  assert.throws(() => store.transaction(() => { store.addGroup('rolled back', ''); store.addSession({ backend: 'codex', title: 'partial', cwd: '/tmp' }); throw new Error('abort'); }));
  assert.equal(publisher.snapshot().groups.length, 0);
  assert.equal(publisher.snapshot().sessions.length, 0);
  assert.equal(publisher.takePatch(), null);
  store.addGroup('committed', '');
  assert.equal(publisher.takePatch()!.groups![0].title, 'committed');
});

test('activity patches retain the newest 100 entries across coalescing and reconnect', t => {
  const store = new Store(':memory:');
  for (let i = 0; i < 100; i++) store.activity(null, 'test', String(i));
  const publisher = new StatePublisher(store, { instanceId: 'first', backends: [], defaultCwd: '/tmp', demo: true });
  t.after(() => { publisher.close(); store.close(); });
  const initial = publisher.snapshot();
  for (let i = 100; i < 350; i++) store.activity(null, 'test', String(i));
  const patch = publisher.takePatch()!;
  assert.equal(patch.activities?.upsert.length, 100);
  assert.deepEqual(applyStatePatch(initial, patch), publisher.snapshot());
  assert.deepEqual(publisher.snapshot().activities, store.activities());
});
