import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store } from './store.ts';
import { lostInstallRoots, readInstallRoots, recordInstallRoot, relocateStoredWorkspaces } from './workspace-migration.ts';

const temporary = () => mkdtempSync(join(tmpdir(), 'dili-relocate-'));
const setup = () => {
  const base = temporary();
  const data = join(base, 'data');
  const oldRoot = join(base, 'Develop', 'sessiondeck');
  const newRoot = join(base, 'Develop', 'dili');
  mkdirSync(data, { recursive: true });
  return { base, data, oldRoot, newRoot };
};

test('records the current checkout, newest first and bounded', () => {
  const base = temporary();
  try {
    assert.deepEqual(readInstallRoots(base), []);
    recordInstallRoot(base, '/a');
    recordInstallRoot(base, '/b');
    assert.deepEqual(readInstallRoots(base), ['/b', '/a']);
    recordInstallRoot(base, '/a');
    assert.deepEqual(readInstallRoots(base), ['/a', '/b']);
    writeFileSync(join(base, 'install-root.json'), '{not json');
    assert.deepEqual(readInstallRoots(base), []);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('only counts checkouts that vanished while their parent survived', () => {
  const base = temporary();
  try {
    const parent = join(base, 'Develop');
    mkdirSync(join(parent, 'alive'), { recursive: true });
    // Deleted checkout, mount point still there: this is the rename case.
    assert.deepEqual(lostInstallRoots([join(parent, 'sessiondeck'), join(parent, 'alive')], '/current', existsSync), [join(parent, 'sessiondeck')]);
    // A temporarily unmounted tree keeps its parent missing: do not guess.
    assert.deepEqual(lostInstallRoots([join(base, 'gone', 'missing')], '/current', existsSync), []);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('rewrites contacts and groups from a vanished checkout before the first snapshot', () => {
  const { base, data, oldRoot, newRoot } = setup();
  const store = new Store(':memory:');
  try {
    mkdirSync(join(newRoot, 'docs'), { recursive: true });
    mkdirSync(join(newRoot, 'work'), { recursive: true });
    const inside = store.addSession({ backend: 'claude', title: 'inside', cwd: join(oldRoot, 'work') });
    const elsewhere = store.addSession({ backend: 'claude', title: 'elsewhere', cwd: join(base, 'other') });
    const group = store.addGroup('docs', '');
    store.updateGroup(group.id, { workspace: join(oldRoot, 'docs') });
    recordInstallRoot(data, oldRoot);

    const report = relocateStoredWorkspaces(store, { dataDir: data, root: newRoot });
    assert.deepEqual({ sessions: report.sessions, groups: report.groups, skipped: report.skipped.length }, { sessions: 1, groups: 1, skipped: 0 });
    assert.equal(store.session(inside.id)?.cwd, join(newRoot, 'work'));
    assert.equal(store.session(elsewhere.id)?.cwd, join(base, 'other'));
    assert.equal(store.group(group.id)?.workspace, join(newRoot, 'docs'));
    assert.ok(readInstallRoots(data).includes(newRoot));
  } finally {
    store.db.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('leaves paths alone while the recorded checkout still exists', () => {
  const { base, data, oldRoot, newRoot } = setup();
  const store = new Store(':memory:');
  try {
    mkdirSync(oldRoot, { recursive: true });
    mkdirSync(newRoot, { recursive: true });
    const session = store.addSession({ backend: 'claude', title: 'kept', cwd: oldRoot });
    recordInstallRoot(data, oldRoot);
    const report = relocateStoredWorkspaces(store, { dataDir: data, root: newRoot });
    assert.equal(report.sessions, 0);
    assert.equal(store.session(session.id)?.cwd, oldRoot);
    assert.ok(readInstallRoots(data).includes(newRoot));
  } finally {
    store.db.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('keeps the original path when the relocated directory does not exist', () => {
  const { base, data, oldRoot, newRoot } = setup();
  const store = new Store(':memory:');
  try {
    mkdirSync(newRoot, { recursive: true });
    const session = store.addSession({ backend: 'claude', title: 'lost', cwd: join(oldRoot, 'deleted-subdir') });
    recordInstallRoot(data, oldRoot);
    const report = relocateStoredWorkspaces(store, { dataDir: data, root: newRoot });
    assert.equal(report.sessions, 0);
    assert.equal(report.skipped.length, 1);
    assert.equal(report.skipped[0].target, join(newRoot, 'deleted-subdir'));
    assert.equal(store.session(session.id)?.cwd, join(oldRoot, 'deleted-subdir'));
    assert.equal(existsSync(join(newRoot, 'deleted-subdir')), false);
  } finally {
    store.db.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('rewrites every additional directory and the worktree pair together', () => {
  const { base, data, oldRoot, newRoot } = setup();
  const store = new Store(':memory:');
  try {
    mkdirSync(join(newRoot, 'extra'), { recursive: true });
    mkdirSync(join(newRoot, 'wt'), { recursive: true });
    const session = store.addSession({
      backend: 'codex', title: 'extra', cwd: join(oldRoot, 'work'),
      additionalDirectories: [join(oldRoot, 'extra'), join(base, 'keep')],
      worktree: { path: join(oldRoot, 'wt'), repository: oldRoot, branch: 'dili/x', base: 'abc123' },
    });
    recordInstallRoot(data, oldRoot);
    relocateStoredWorkspaces(store, { dataDir: data, root: newRoot });
    const updated = store.session(session.id);
    assert.deepEqual(updated?.additionalDirectories, [join(newRoot, 'extra'), join(base, 'keep')]);
    assert.deepEqual(updated?.worktree, { path: join(newRoot, 'wt'), repository: newRoot, branch: 'dili/x', base: 'abc123' });
    assert.equal(updated?.cwd, join(oldRoot, 'work'));
  } finally {
    store.db.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('a data directory that cannot record still lets the startup continue', () => {
  const { base, data, oldRoot, newRoot } = setup();
  const store = new Store(':memory:');
  const messages: string[] = [];
  try {
    recordInstallRoot(data, oldRoot);
    const blocked = join(base, 'blocked');
    writeFileSync(blocked, 'not a directory');
    const report = relocateStoredWorkspaces(store, { dataDir: blocked, root: newRoot, log: message => messages.push(message) });
    assert.equal(report.sessions, 0);
    assert.match(messages.join('\n'), /未能记录安装目录/u);
    assert.equal(readFileSync(join(data, 'install-root.json'), 'utf8').includes(oldRoot), true);
  } finally {
    store.db.close();
    rmSync(base, { recursive: true, force: true });
  }
});
