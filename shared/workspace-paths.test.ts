import assert from 'node:assert/strict';
import test from 'node:test';
import { groupWorkspacePatch, remapWorkspacePath, sessionWorkspacePatch, tidyWorkspacePath } from './workspace-paths.ts';

const OLD = '/home/me/Develop/old';
const NEW = '/home/me/Develop/new';
const only = (paths: string[]) => (path: string) => paths.includes(path);

test('tidyWorkspacePath drops trailing separators but keeps the root', () => {
  assert.equal(tidyWorkspacePath('/a/b/'), '/a/b');
  assert.equal(tidyWorkspacePath('/'), '/');
  assert.equal(tidyWorkspacePath('/a//'), '/a');
});

test('remapWorkspacePath rewrites the exact directory and everything inside it', () => {
  assert.equal(remapWorkspacePath(OLD, OLD, NEW), NEW);
  assert.equal(remapWorkspacePath(`${OLD}/src/app.ts`, OLD, NEW), `${NEW}/src/app.ts`);
  assert.equal(remapWorkspacePath(`${OLD}/`, OLD, NEW), NEW);
  assert.equal(remapWorkspacePath(`${OLD}/a/`, `${OLD}/`, `${NEW}/`), `${NEW}/a`);
});

test('remapWorkspacePath never touches lookalike or unrelated directories', () => {
  assert.equal(remapWorkspacePath(`${OLD}-2`, OLD, NEW), null);
  assert.equal(remapWorkspacePath('/home/me/Develop/olden/x', OLD, NEW), null);
  assert.equal(remapWorkspacePath('/home/me/Develop/other', OLD, NEW), null);
  assert.equal(remapWorkspacePath('', OLD, NEW), null);
});

test('remapWorkspacePath handles a root source without a double separator', () => {
  assert.equal(remapWorkspacePath('/srv/app', '/', '/data'), '/data/srv/app');
});

test('sessionWorkspacePatch rewrites cwd, extra directories and a worktree pair', () => {
  const plan = sessionWorkspacePatch({
    cwd: OLD,
    additionalDirectories: [`${OLD}/docs`, '/home/me/elsewhere'],
    worktree: { path: `${OLD}/wt`, branch: 'dili/x', repository: OLD, base: 'abc123' },
  }, OLD, NEW, only([NEW, `${NEW}/docs`, `${NEW}/wt`]));
  assert.deepEqual(plan.patch, {
    cwd: NEW,
    additionalDirectories: [`${NEW}/docs`, '/home/me/elsewhere'],
    worktree: { path: `${NEW}/wt`, branch: 'dili/x', repository: NEW, base: 'abc123' },
  });
  assert.deepEqual(plan.skipped, []);
  assert.deepEqual(plan.fields.map(field => field.field), ['cwd', 'additionalDirectories', 'worktree.path', 'worktree.repository']);
});

test('sessionWorkspacePatch leaves a field alone when its new directory is missing', () => {
  const plan = sessionWorkspacePatch({ cwd: OLD, additionalDirectories: [`${OLD}/gone`] }, OLD, NEW, only([]));
  assert.deepEqual(plan.patch, {});
  assert.deepEqual(plan.fields, []);
  assert.deepEqual(plan.skipped, [
    { field: 'cwd', from: OLD, target: NEW },
    { field: 'additionalDirectories', from: `${OLD}/gone`, target: `${NEW}/gone` },
  ]);
});

test('sessionWorkspacePatch keeps the worktree directory and repository together', () => {
  const plan = sessionWorkspacePatch({
    cwd: OLD,
    worktree: { path: `${OLD}/wt`, branch: 'dili/x', repository: OLD, base: 'abc123' },
  }, OLD, NEW, only([NEW, `${NEW}/wt`]));
  // The repository remap succeeded, so the pair is applied as a whole.
  assert.deepEqual(plan.patch, { cwd: NEW, worktree: { path: `${NEW}/wt`, branch: 'dili/x', repository: NEW, base: 'abc123' } });

  const missingRepository = sessionWorkspacePatch({
    cwd: OLD,
    worktree: { path: `${OLD}/wt`, branch: 'dili/x', repository: `${OLD}/repo`, base: 'abc123' },
  }, OLD, NEW, only([NEW, `${NEW}/wt`]));
  assert.deepEqual(missingRepository.patch, { cwd: NEW });
  assert.deepEqual(missingRepository.fields.map(field => field.field), ['cwd']);
  assert.deepEqual(missingRepository.skipped, [{ field: 'worktree.repository', from: `${OLD}/repo`, target: `${NEW}/repo` }]);
});

test('sessionWorkspacePatch is a no-op for contacts outside the old checkout', () => {
  const plan = sessionWorkspacePatch({ cwd: '/home/me/other' }, OLD, NEW, only([NEW]));
  assert.deepEqual(plan.patch, {});
  assert.deepEqual(plan.fields, []);
  assert.deepEqual(plan.skipped, []);
});

test('groupWorkspacePatch rewrites only an existing new group workspace', () => {
  assert.deepEqual(groupWorkspacePatch({ workspace: OLD }, OLD, NEW, only([NEW])).patch, { workspace: NEW });
  assert.deepEqual(groupWorkspacePatch({ workspace: `${OLD}/sub` }, OLD, NEW, only([NEW])).skipped, [
    { field: 'workspace', from: `${OLD}/sub`, target: `${NEW}/sub` },
  ]);
  assert.deepEqual(groupWorkspacePatch({}, OLD, NEW, only([NEW])).patch, {});
  assert.deepEqual(groupWorkspacePatch({ workspace: '/home/me/other' }, OLD, NEW, only([NEW])).fields, []);
});
