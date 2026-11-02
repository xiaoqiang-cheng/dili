import type { Group, MemberWorktree, Session } from './types.ts';

/**
 * Pure workspace-path rewriting. Dili stores absolute directories (a contact's
 * `cwd`, a group workspace, worktree roots). Those stay valid when the project
 * is renamed in place, but a contact created from `/old/checkout` keeps pointing
 * at `/old/checkout` after the directory becomes `/new/checkout`, and starting it
 * fails with "工作目录不存在或无法访问". These helpers rewrite only the stored
 * prefix, never guess a different directory.
 */

/** Trailing separators do not change which directory a path names. */
export function tidyWorkspacePath(value: string): string {
  const trimmed = value.replace(/\/+$/u, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * Returns the path under the new root, or null when `value` is outside `from`.
 * A sibling with a shared prefix (`/a/old-2` vs `/a/old`) is not a match.
 */
export function remapWorkspacePath(value: string, from: string, to: string): string | null {
  if (!value || !from) return null;
  const source = tidyWorkspacePath(from);
  const target = tidyWorkspacePath(to);
  const path = tidyWorkspacePath(value);
  if (path === source) return target;
  if (source === '/') return target + path;
  if (!path.startsWith(`${source}/`)) return null;
  return target + path.slice(source.length);
}

export interface WorkspaceFieldRemap { field: string; from: string; to: string }
export interface WorkspaceSkip { field: string; from: string; target: string }

type SessionPatch = { cwd?: string; additionalDirectories?: string[]; worktree?: MemberWorktree };

/**
 * Rewrites a contact's stored directories only when the new directory exists:
 * a rewrite that points at another missing directory would trade one broken
 * contact for another. `fields` lists applied rewrites; `skipped` says why not.
 */
export function sessionWorkspacePatch(
  session: Pick<Session, 'cwd' | 'additionalDirectories' | 'worktree'>,
  from: string,
  to: string,
  isDirectory: (path: string) => boolean,
): { patch: SessionPatch; fields: WorkspaceFieldRemap[]; skipped: WorkspaceSkip[] } {
  const fields: WorkspaceFieldRemap[] = [];
  const skipped: WorkspaceSkip[] = [];
  const patch: SessionPatch = {};

  const remap = (field: string, value: string): string | null => {
    const target = remapWorkspacePath(value, from, to);
    if (target === null) return null;
    if (!isDirectory(target)) {
      skipped.push({ field, from: value, target });
      return null;
    }
    fields.push({ field, from: value, to: target });
    return target;
  };

  const cwd = remap('cwd', session.cwd);
  if (cwd !== null) patch.cwd = cwd;

  if (session.additionalDirectories?.length) {
    const remapped: string[] = [];
    let touched = false;
    for (const directory of session.additionalDirectories) {
      const target = remap('additionalDirectories', directory);
      if (target === null) { remapped.push(directory); continue; }
      touched = true;
      remapped.push(target);
    }
    if (touched) patch.additionalDirectories = remapped;
  }

  if (session.worktree) {
    // The worktree directory and the repository it merges into form one pair;
    // rewriting only one of them would leave the merge target inconsistent.
    const before = fields.length;
    const path = remap('worktree.path', session.worktree.path);
    const repository = remap('worktree.repository', session.worktree.repository);
    if (path !== null && repository !== null) patch.worktree = { ...session.worktree, path, repository };
    else fields.length = before;
  }

  return { patch, fields, skipped };
}

export function groupWorkspacePatch(
  group: Pick<Group, 'workspace'>,
  from: string,
  to: string,
  isDirectory: (path: string) => boolean,
): { patch: { workspace?: string }; fields: WorkspaceFieldRemap[]; skipped: WorkspaceSkip[] } {
  const fields: WorkspaceFieldRemap[] = [];
  const skipped: WorkspaceSkip[] = [];
  const patch: { workspace?: string } = {};
  if (!group.workspace) return { patch, fields, skipped };
  const target = remapWorkspacePath(group.workspace, from, to);
  if (target === null) return { patch, fields, skipped };
  if (!isDirectory(target)) {
    skipped.push({ field: 'workspace', from: group.workspace, target });
    return { patch, fields, skipped };
  }
  patch.workspace = target;
  fields.push({ field: 'workspace', from: group.workspace, to: target });
  return { patch, fields, skipped };
}
