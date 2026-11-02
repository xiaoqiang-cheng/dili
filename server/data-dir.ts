import { existsSync, lstatSync, mkdirSync, renameSync, realpathSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { acquireInstanceLock } from './instance-lock.ts';

/**
 * The local metadata directory. Dili used to store it under the `sessiondeck`
 * name; the canonical name is now `dili`. One start migrates the old default
 * (see `migrateDataDir`), and the legacy path is left as a symlink so older
 * binaries, units and hand-written `SESSIONDECK_DATA_DIR` values keep reading
 * the same store instead of creating a second, empty one.
 */

export const DATA_DIR_NAME = 'dili';
export const LEGACY_DATA_DIR_NAME = 'sessiondeck';

export interface DataDirOptions { demo?: boolean; home?: string }

const shareRoot = (options: DataDirOptions) => join(options.home ?? homedir(), '.local/share');

export function defaultDataDir(options: DataDirOptions = {}): string {
  return join(shareRoot(options), options.demo ? `${DATA_DIR_NAME}-demo` : DATA_DIR_NAME);
}

export function legacyDataDir(options: DataDirOptions = {}): string {
  return join(shareRoot(options), options.demo ? `${LEGACY_DATA_DIR_NAME}-demo` : LEGACY_DATA_DIR_NAME);
}

/** Explicit `SESSIONDECK_DATA_DIR` wins, including a relative value. */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return resolve(env.SESSIONDECK_DATA_DIR || defaultDataDir({ demo: env.SESSIONDECK_DEMO === '1', home }));
}

/**
 * The directory a maintenance command should read before a service restart has
 * performed the migration: the requested directory when it exists (or was set
 * explicitly), otherwise the pre-rename default that still holds the data.
 */
export function existingDataDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const wanted = resolveDataDir(env, home);
  if (existsSync(wanted) || env.SESSIONDECK_DATA_DIR) return wanted;
  const legacy = legacyDataDir({ demo: env.SESSIONDECK_DEMO === '1', home });
  return existsSync(legacy) ? legacy : wanted;
}

export interface DataDirMigration {
  /** Directory to use for this process. */
  dataDir: string;
  migratedFrom: string | null;
  /** Set when the legacy directory cannot be moved right now. */
  note: string | null;
}

/**
 * Moves a pre-rename default directory to the canonical location, once.
 *
 * The legacy lease is held across the rename: an older install starting in that
 * window fails its own lock instead of creating a second, empty store. A unit
 * that pins the legacy default is safe too, because the symlink keeps that exact
 * path readable. Explicit non-default directories are never moved.
 */
export async function migrateDataDir(
  requested: string,
  options: { demo?: boolean; explicit: boolean; home?: string; log?: (message: string) => void },
): Promise<DataDirMigration> {
  const log = options.log ?? (() => {});
  const legacy = legacyDataDir({ demo: options.demo, home: options.home });
  // A unit written before the rename can pin the old default explicitly. That
  // is the one explicit value still safe to move, because the symlink keeps the
  // very same path readable; the canonical directory is the real target then.
  const target = requested === legacy ? defaultDataDir({ demo: options.demo, home: options.home }) : requested;
  const settled: DataDirMigration = { dataDir: target, migratedFrom: null, note: null };
  if (options.explicit && requested !== legacy) return settled;
  if (existsSync(target)) {
    // An explicit old path may still hold a separate store. Never silently
    // select a different database just because the canonical path also exists.
    if (requested === legacy && existsSync(legacy) && realpathSync(legacy) !== realpathSync(target)) {
      return { dataDir: legacy, migratedFrom: null, note: `新旧数据目录都存在，本次保留显式指定的 ${legacy}；不会自动合并数据` };
    }
    return settled;
  }
  if (!existsSync(legacy)) return settled;

  let stats;
  try { stats = lstatSync(legacy); } catch { return settled; }
  if (stats.isSymbolicLink()) {
    // Someone already wired the paths deliberately; follow it, do not rename it.
    return { dataDir: legacy, migratedFrom: null, note: `数据目录 ${legacy} 是符号链接，保持原样；如需迁移请先移除该链接` };
  }
  if (!stats.isDirectory()) return settled;

  const lease = await acquireInstanceLock(legacy).catch(() => null);
  if (!lease) return { dataDir: legacy, migratedFrom: null, note: `旧数据目录 ${legacy} 正被另一个实例使用，本次沿用旧目录，下次启动再迁移` };
  try {
    try {
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      renameSync(legacy, target);
    } catch (error) {
      return { dataDir: legacy, migratedFrom: null, note: `无法把 ${legacy} 迁移到 ${target}（${error instanceof Error ? error.message : String(error)}），本次沿用旧目录` };
    }
    // Keep the legacy lease until its compatibility path has been restored.
    // Releasing it first yields to other starters while the old path is absent.
    try {
      symlinkSync(target, legacy, 'dir');
    } catch (error) {
      log(`数据目录已迁移，但未能保留兼容链接 ${legacy}：${error instanceof Error ? error.message : String(error)}`);
      return { dataDir: target, migratedFrom: legacy, note: `兼容链接未创建，旧版本不能继续使用 ${legacy}` };
    }
    log(`数据目录已从 ${legacy} 迁移到 ${target}（旧路径保留为兼容链接）`);
  } finally {
    await lease.release();
  }
  return { dataDir: target, migratedFrom: legacy, note: null };
}
