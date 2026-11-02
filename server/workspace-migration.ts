import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { Store } from './store.ts';
import { groupWorkspacePatch, sessionWorkspacePatch, type WorkspaceSkip } from '../shared/workspace-paths.ts';

/**
 * A contact stores absolute directories, so moving the Dili checkout leaves
 * every contact created under the old path pointing at a directory that no
 * longer exists. The data directory records the checkouts Dili has run from;
 * when one of them disappears, contacts under it are rewritten to the current
 * checkout at the next start. Only a root that is really gone and whose parent
 * still exists counts: a temporarily unmounted disk must not rewrite anything.
 */

const RECORD = 'install-root.json';
const MAX_ROOTS = 8;

export function readInstallRoots(dataDir: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, RECORD), 'utf8')) as { roots?: unknown };
    if (!Array.isArray(parsed.roots)) return [];
    return parsed.roots
      .filter((item): item is string => typeof item === 'string' && item.startsWith('/'))
      .slice(0, MAX_ROOTS);
  } catch { return []; }
}

/** Atomic, private, and tolerant of a read-only data directory. */
export function recordInstallRoot(dataDir: string, root: string): string[] {
  const roots = [root, ...readInstallRoots(dataDir).filter(item => item !== root)].slice(0, MAX_ROOTS);
  const file = join(dataDir, RECORD);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, roots, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
  return roots;
}

const isDirectory = (path: string): boolean => {
  try { return statSync(path).isDirectory(); } catch { return false; }
};

/** Recorded checkouts that are gone, deepest first so nested roots win. */
export function lostInstallRoots(
  roots: readonly string[],
  root: string,
  exists: (path: string) => boolean = path => isDirectory(path),
): string[] {
  return roots
    .filter(item => item !== root && !exists(item) && exists(dirname(item)))
    .sort((a, b) => b.length - a.length);
}

export interface RelocationReport {
  sessions: number;
  groups: number;
  skipped: WorkspaceSkip[];
}

type WorkspaceStore = Pick<Store, 'sessions' | 'groups' | 'updateSession' | 'updateGroup'>;

/**
 * Rewrites stored directories from vanished checkouts to the current one and
 * records the current checkout. Runs before any state is published, so the
 * first snapshot already contains the fixed paths.
 */
export function relocateStoredWorkspaces(
  store: WorkspaceStore,
  options: { dataDir: string; root: string; exists?: (path: string) => boolean; log?: (message: string) => void },
): RelocationReport {
  const exists = options.exists ?? isDirectory;
  const report: RelocationReport = { sessions: 0, groups: 0, skipped: [] };
  for (const from of lostInstallRoots(readInstallRoots(options.dataDir), options.root, exists)) {
    for (const session of store.sessions()) {
      const planned = sessionWorkspacePatch(session, from, options.root, exists);
      report.skipped.push(...planned.skipped);
      if (!planned.fields.length) continue;
      store.updateSession(session.id, planned.patch);
      report.sessions += 1;
    }
    for (const group of store.groups()) {
      const planned = groupWorkspacePatch(group, from, options.root, exists);
      report.skipped.push(...planned.skipped);
      if (!planned.fields.length) continue;
      store.updateGroup(group.id, planned.patch);
      report.groups += 1;
    }
  }
  try { recordInstallRoot(options.dataDir, options.root); }
  catch (error) {
    options.log?.(`未能记录安装目录 ${options.root}：${error instanceof Error ? error.message : String(error)}`);
  }
  if (report.sessions || report.groups) {
    options.log?.(`项目目录已移动：已把 ${report.sessions} 个联系人、${report.groups} 个群组的工作目录改写为 ${options.root}`);
  }
  if (report.skipped.length) {
    options.log?.(`${report.skipped.length} 个目录在 ${options.root} 下找不到对应位置，保留原路径；可运行 npm run repair:workspaces 查看`);
  }
  return report;
}
