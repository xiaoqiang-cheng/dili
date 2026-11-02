import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { defaultDataDir, existingDataDir, legacyDataDir, migrateDataDir, resolveDataDir } from './data-dir.ts';
import { acquireInstanceLock } from './instance-lock.ts';

const temporaryHome = () => mkdtempSync(join(tmpdir(), 'dili-data-dir-'));

test('default directories follow the canonical name, the demo flag and an explicit override', () => {
  const home = '/home/someone';
  assert.equal(defaultDataDir({ home }), '/home/someone/.local/share/dili');
  assert.equal(defaultDataDir({ home, demo: true }), '/home/someone/.local/share/dili-demo');
  assert.equal(legacyDataDir({ home }), '/home/someone/.local/share/sessiondeck');
  assert.equal(legacyDataDir({ home, demo: true }), '/home/someone/.local/share/sessiondeck-demo');
  assert.equal(resolveDataDir({}, home), '/home/someone/.local/share/dili');
  assert.equal(resolveDataDir({ SESSIONDECK_DEMO: '1' }, home), '/home/someone/.local/share/dili-demo');
  assert.equal(resolveDataDir({ SESSIONDECK_DATA_DIR: './custom-data' }, home), resolve('custom-data'));
});

test('maintenance commands read the pre-rename directory until the service migrates it', () => {
  const home = temporaryHome();
  try {
    assert.equal(existingDataDir({}, home), join(home, '.local/share/dili'));
    mkdirSync(join(home, '.local/share/sessiondeck'), { recursive: true });
    // The server has not restarted yet, so the real store is still there.
    assert.equal(existingDataDir({}, home), join(home, '.local/share/sessiondeck'));
    // An explicit directory is never redirected to a guess.
    assert.equal(existingDataDir({ SESSIONDECK_DATA_DIR: join(home, 'explicit') }, home), join(home, 'explicit'));
    mkdirSync(join(home, '.local/share/dili'));
    assert.equal(existingDataDir({}, home), join(home, '.local/share/dili'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('migrates the pre-rename directory once and leaves a working compatibility link', async () => {
  const home = temporaryHome();
  const legacy = legacyDataDir({ home });
  const canonical = defaultDataDir({ home });
  try {
    mkdirSync(join(legacy, 'backups'), { recursive: true });
    writeFileSync(join(legacy, 'sessiondeck.sqlite'), 'store');
    const messages: string[] = [];
    const result = await migrateDataDir(canonical, { explicit: false, home, log: message => messages.push(message) });
    assert.equal(result.dataDir, canonical);
    assert.equal(result.migratedFrom, legacy);
    assert.equal(readFileSync(join(canonical, 'sessiondeck.sqlite'), 'utf8'), 'store');
    assert.equal(readFileSync(join(legacy, 'sessiondeck.sqlite'), 'utf8'), 'store');
    assert.equal(lstatSync(legacy).isSymbolicLink(), true);
    assert.equal(existsSync(join(legacy, 'backups')), true);
    assert.equal(messages.length, 1);

    const again = await migrateDataDir(canonical, { explicit: false, home });
    assert.deepEqual(again, { dataDir: canonical, migratedFrom: null, note: null });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('migrates the demo directory separately', async () => {
  const home = temporaryHome();
  try {
    mkdirSync(legacyDataDir({ home, demo: true }), { recursive: true });
    mkdirSync(legacyDataDir({ home }), { recursive: true });
    const result = await migrateDataDir(defaultDataDir({ home, demo: true }), { demo: true, explicit: false, home });
    assert.equal(result.dataDir, defaultDataDir({ home, demo: true }));
    assert.equal(existsSync(legacyDataDir({ home, demo: true })), true);
    assert.equal(lstatSync(legacyDataDir({ home })).isDirectory(), true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('keeps the old directory while another instance is using it', async () => {
  const home = temporaryHome();
  const legacy = legacyDataDir({ home });
  try {
    mkdirSync(legacy, { recursive: true });
    const lease = await acquireInstanceLock(legacy);
    const running = await migrateDataDir(defaultDataDir({ home }), { explicit: false, home });
    assert.equal(running.dataDir, legacy);
    assert.match(running.note ?? '', /正被另一个实例使用/u);
    assert.equal(existsSync(defaultDataDir({ home })), false);
    await lease.release();
    const later = await migrateDataDir(defaultDataDir({ home }), { explicit: false, home });
    assert.equal(later.dataDir, defaultDataDir({ home }));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('never moves an explicitly configured custom directory', async () => {
  const home = temporaryHome();
  const legacy = legacyDataDir({ home });
  const custom = join(home, 'custom-data');
  try {
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'sessiondeck.sqlite'), 'store');
    const result = await migrateDataDir(custom, { explicit: true, home });
    assert.deepEqual(result, { dataDir: custom, migratedFrom: null, note: null });
    assert.equal(existsSync(custom), false);
    assert.equal(statSync(join(legacy, 'sessiondeck.sqlite')).isFile(), true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('an explicit pre-rename default still migrates and reports the canonical path', async () => {
  const home = temporaryHome();
  const legacy = legacyDataDir({ home });
  try {
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'sessiondeck.sqlite'), 'store');
    const result = await migrateDataDir(legacy, { explicit: true, home });
    assert.equal(result.dataDir, defaultDataDir({ home }));
    assert.equal(result.migratedFrom, legacy);
    assert.equal(lstatSync(legacy).isSymbolicLink(), true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('leaves a hand-made symlink alone instead of renaming it', async () => {
  const home = temporaryHome();
  const legacy = legacyDataDir({ home });
  const elsewhere = join(home, 'elsewhere');
  try {
    mkdirSync(elsewhere, { recursive: true });
    mkdirSync(join(home, '.local/share'), { recursive: true });
    symlinkSync(elsewhere, legacy, 'dir');
    const result = await migrateDataDir(defaultDataDir({ home }), { explicit: false, home });
    assert.equal(result.dataDir, legacy);
    assert.match(result.note ?? '', /符号链接/u);
    assert.equal(lstatSync(legacy).isSymbolicLink(), true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('an explicit legacy symlink continues to use its real store', async () => {
  const home = temporaryHome();
  try {
    const legacy = legacyDataDir({ home }), elsewhere = join(home, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    mkdirSync(join(home, '.local/share'), { recursive: true });
    symlinkSync(elsewhere, legacy, 'dir');
    const result = await migrateDataDir(legacy, { explicit: true, home });
    assert.equal(result.dataDir, legacy);
    assert.equal(existsSync(defaultDataDir({ home })), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('an explicit legacy store is not replaced by a separate existing canonical store', async () => {
  const home = temporaryHome();
  try {
    const legacy = legacyDataDir({ home }), canonical = defaultDataDir({ home });
    mkdirSync(legacy, { recursive: true });
    mkdirSync(canonical, { recursive: true });
    writeFileSync(join(legacy, 'sessiondeck.sqlite'), 'old store');
    writeFileSync(join(canonical, 'sessiondeck.sqlite'), 'other store');
    const result = await migrateDataDir(legacy, { explicit: true, home });
    assert.equal(result.dataDir, legacy);
    assert.match(result.note ?? '', /不会自动合并/u);
    assert.equal(readFileSync(join(legacy, 'sessiondeck.sqlite'), 'utf8'), 'old store');
    assert.equal(readFileSync(join(canonical, 'sessiondeck.sqlite'), 'utf8'), 'other store');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
