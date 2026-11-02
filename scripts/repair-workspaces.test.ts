import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { applyWorkspaces, planWorkspaces } from './repair-workspaces.ts';

/** A throwaway store shaped like the server's: `(id, data)` rows with JSON payloads. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dili-workspace-repair-'));
  const dataDir = join(root, 'data');
  const from = join(root, 'sessiondeck');
  const to = join(root, 'dili');
  for (const directory of [dataDir, from, to]) mkdirSync(directory);
  const db = new DatabaseSync(join(dataDir, 'sessiondeck.sqlite'));
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE groups (id TEXT PRIMARY KEY, data TEXT NOT NULL);');
  const insertSession = db.prepare('INSERT INTO sessions (id, data) VALUES (?, ?)');
  const insertGroup = db.prepare('INSERT INTO groups (id, data) VALUES (?, ?)');
  const session = (id: string, patch: Record<string, unknown> = {}) => ({ id, backend: 'codex', title: `联系人 ${id}`, cwd: from, archived: false, nativeSessionId: null, groupId: null, ...patch });
  insertSession.run('s1', JSON.stringify(session('s1')));
  insertSession.run('s2', JSON.stringify(session('s2', { cwd: join(from, 'gone') })));
  insertGroup.run('g1', JSON.stringify({ id: 'g1', title: '群一', goal: '', workspace: from, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }));
  insertGroup.run('g2', JSON.stringify({ id: 'g2', title: '群二', goal: '', workspace: join(from, 'gone'), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }));
  db.close();
  return { root, dataDir, from, to };
}

test('plan reports only rewrites whose new directory exists', (t) => {
  const { root, dataDir, from, to } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plan = planWorkspaces({ dataDir, from, to });
  assert.equal(plan.sessions.length, 1);
  assert.equal(plan.sessions[0].id, 's1');
  assert.deepEqual(plan.sessions[0].fields, [{ field: 'cwd', from, to }]);
  assert.equal(plan.groups.length, 1);
  assert.equal(plan.groups[0].id, 'g1');
  assert.deepEqual(plan.missing.map(entry => entry.field).sort(), ['cwd', 'workspace']);
  assert.equal(plan.missing[0].target.startsWith(to), true);
});

test('apply rewrites the stored JSON and is idempotent', (t) => {
  const { root, dataDir, from, to } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = applyWorkspaces({ dataDir, from, to });
  assert.equal(first.writtenSessions, 1);
  assert.equal(first.writtenGroups, 1);

  const db = new DatabaseSync(join(dataDir, 'sessiondeck.sqlite'), { readOnly: true });
  try {
    const session = JSON.parse(String((db.prepare('SELECT data FROM sessions WHERE id = ?').get('s1') as { data: string }).data));
    assert.equal(session.cwd, to);
    assert.equal(session.title, '联系人 s1');
    assert.equal(session.backend, 'codex');
    const skipped = JSON.parse(String((db.prepare('SELECT data FROM sessions WHERE id = ?').get('s2') as { data: string }).data));
    assert.equal(skipped.cwd, join(from, 'gone'));
    const group = JSON.parse(String((db.prepare('SELECT data FROM groups WHERE id = ?').get('g1') as { data: string }).data));
    assert.equal(group.workspace, to);
  } finally { db.close(); }

  // Re-running must be a no-op, not a second rewrite of the same prefix.
  const second = applyWorkspaces({ dataDir, from, to });
  assert.equal(second.writtenSessions, 0);
  assert.equal(second.writtenGroups, 0);
});

test('a missing data directory fails instead of silently doing nothing', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dili-workspace-repair-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => planWorkspaces({ dataDir: join(root, 'nope'), from: join(root, 'a'), to: join(root, 'b') }), /数据目录不存在/);
});
