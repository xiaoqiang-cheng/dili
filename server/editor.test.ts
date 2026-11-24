import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EDITOR_ENV, EditorUnavailableError, editorMissingMessage, findOnPath, openInEditor, resolveEditorCommand } from './editor.ts';

/** A throwaway bin directory: one script per test, no real editor involved. */
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'dili-editor-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = (name: string, body: string) => {
    const file = join(bin, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  };
  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ ...process.env, PATH: `${bin}:/usr/bin:/bin`, ...extra });
  return { root, bin, script, env };
}

const status = (error: unknown) => (error as { status?: number }).status;

test('findOnPath returns the first executable file and ignores everything else', (t) => {
  const { bin, script } = fixture(t);
  writeFileSync(join(bin, 'code'), 'not executable');
  chmodSync(join(bin, 'code'), 0o644);
  mkdirSync(join(bin, 'code-insiders'));
  assert.equal(findOnPath(['code'], { PATH: bin }), null, 'a non-executable file is not a usable command');
  assert.equal(findOnPath(['code-insiders'], { PATH: bin }), null, 'a directory is not a usable command');
  assert.equal(findOnPath(['codium'], { PATH: bin }), null);
  assert.equal(findOnPath(['codium'], { PATH: '' }), null);
  const executable = script('codium', 'exit 0');
  assert.equal(findOnPath(['code', 'codium'], { PATH: bin }), executable, 'the first usable name on the list wins');
  assert.equal(findOnPath(['codium'], { PATH: `/nonexistent:${bin}` }), executable, 'later PATH entries are still searched');
});

test('the configured command replaces the default lookup, absolute or on PATH', (t) => {
  const { bin, script, env } = fixture(t);
  script('code', 'exit 0');
  script('cursor', 'exit 0');
  assert.equal(resolveEditorCommand(env()), join(bin, 'code'));
  assert.equal(resolveEditorCommand(env({ [EDITOR_ENV]: 'cursor' })), join(bin, 'cursor'));
  assert.equal(resolveEditorCommand(env({ [EDITOR_ENV]: join(bin, 'cursor') })), join(bin, 'cursor'));
  assert.equal(resolveEditorCommand(env({ [EDITOR_ENV]: '/nonexistent/editor' })), null);
  assert.equal(resolveEditorCommand(env({ [EDITOR_ENV]: '   ' })), join(bin, 'code'), 'blank configuration falls back to code');
});

test('a workspace path is one argument, never a shell command', async (t) => {
  const { root, script, env } = fixture(t);
  const record = join(root, 'record');
  script('code', 'printf \'%s\\n\' "$1" > "$RECORD"');
  // A directory name that would run `touch` if the path were parsed by a shell.
  const workspace = join(root, `dir with space 'quote' $(touch pwned) ; echo injected`);
  mkdirSync(workspace);
  const result = await openInEditor(workspace, env({ RECORD: record }));
  assert.equal(result.state, 'exited');
  assert.equal(result.exitCode, 0);
  assert.equal(result.path, workspace);
  assert.equal(readFileSync(record, 'utf8').trim(), workspace);
  assert.equal(existsSync(join(process.cwd(), 'pwned')), false, 'nothing was interpreted as a command');
});

test('a failing editor CLI is reported with its exit code, not as success', async (t) => {
  const { root, script, env } = fixture(t);
  script('code', 'echo "cannot open workspace" >&2\nexit 3');
  await assert.rejects(openInEditor(root, env()), (error: unknown) => {
    assert.ok(error instanceof EditorUnavailableError);
    assert.equal(status(error), 501);
    assert.match((error as Error).message, /退出码 3/);
    assert.match((error as Error).message, /cannot open workspace/);
    return true;
  });
});

test('a CLI that never reports back is started, not called opened', async (t) => {
  const { root, script, env } = fixture(t);
  script('code', 'exec sleep 0.4');
  const result = await openInEditor(root, env(), 100);
  assert.equal(result.state, 'running', 'no exit yet means "requested", so the UI cannot claim it opened');
  assert.equal(result.path, root);
});

test('a machine without an editor fails with an actionable message', async (t) => {
  const { root, env } = fixture(t);
  await assert.rejects(openInEditor(root, env()), (error: unknown) => {
    assert.ok(error instanceof EditorUnavailableError);
    assert.equal(status(error), 501);
    assert.match((error as Error).message, /code/);
    return true;
  });
  assert.match(editorMissingMessage({}), /SESSIONDECK_EDITOR_COMMAND/);
  assert.match(editorMissingMessage({ [EDITOR_ENV]: '/bad/path' }), /\/bad\/path/);
});

test('a missing workspace directory is rejected before anything starts', async (t) => {
  const { root, script, env } = fixture(t);
  const record = join(root, 'record');
  script('code', 'printf started > "$RECORD"');
  await assert.rejects(openInEditor(join(root, 'absent'), env({ RECORD: record })), (error: unknown) => {
    assert.equal(status(error), 404);
    return true;
  });
  assert.equal(existsSync(record), false, 'no editor is launched for a directory that does not exist');
});
