import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { existingDataDir } from '../server/data-dir.ts';
import type { Group, Session } from '../shared/types.ts';
import { groupWorkspacePatch, sessionWorkspacePatch, type WorkspaceFieldRemap, type WorkspaceSkip } from '../shared/workspace-paths.ts';

/**
 * Repairs stored workspace paths after the Dili checkout (or any directory a
 * contact works in) was renamed or moved. It rewrites only the old prefix and
 * only when the new directory exists, so it cannot point a contact somewhere
 * new. Preview by default; `--apply` writes to the same SQLite store the server
 * uses. SQLite makes that safe while the service runs, but the running process
 * keeps its in-memory snapshot, so restart Dili for the fixed paths to show up.
 */

const DATABASE = 'sessiondeck.sqlite';

export interface WorkspaceChange {
  id: string;
  title: string;
  archived: boolean;
  fields: WorkspaceFieldRemap[];
  patch: Record<string, unknown>;
}
export interface MissingWorkspace extends WorkspaceSkip { id: string; title: string }
export interface WorkspaceRepairPlan {
  database: string;
  from: string;
  to: string;
  sessions: WorkspaceChange[];
  groups: WorkspaceChange[];
  missing: MissingWorkspace[];
}

const isDirectory = (path: string): boolean => {
  try { return statSync(path).isDirectory(); } catch { return false; }
};

function collect(db: DatabaseSync, database: string, from: string, to: string): WorkspaceRepairPlan {
  const sessions: WorkspaceChange[] = [];
  const groups: WorkspaceChange[] = [];
  const missing: MissingWorkspace[] = [];
  for (const row of db.prepare('SELECT data FROM sessions ORDER BY rowid').all() as Array<{ data: string }>) {
    const session = JSON.parse(row.data) as Session;
    const planned = sessionWorkspacePatch(session, from, to, isDirectory);
    for (const skip of planned.skipped) missing.push({ id: session.id, title: session.title, ...skip });
    if (planned.fields.length) sessions.push({ id: session.id, title: session.title, archived: session.archived, fields: planned.fields, patch: planned.patch });
  }
  for (const row of db.prepare('SELECT data FROM groups ORDER BY rowid').all() as Array<{ data: string }>) {
    const group = JSON.parse(row.data) as Group;
    const planned = groupWorkspacePatch(group, from, to, isDirectory);
    for (const skip of planned.skipped) missing.push({ id: group.id, title: group.title, ...skip });
    if (planned.fields.length) groups.push({ id: group.id, title: group.title, archived: group.archived === true, fields: planned.fields, patch: planned.patch });
  }
  return { database, from, to, sessions, groups, missing };
}

/** Reads the store without modifying it. */
export function planWorkspaces(options: { dataDir: string; from: string; to: string }): WorkspaceRepairPlan {
  const database = join(resolve(options.dataDir), DATABASE);
  canOpen(database, options.dataDir);
  const db = new DatabaseSync(database, { readOnly: true });
  try { return collect(db, database, options.from, options.to); }
  finally { db.close(); }
}

/**
 * Rewrites the stored paths in one transaction. Rows are re-read inside the
 * transaction, so a concurrent update from the running server is not clobbered
 * by the preview snapshot.
 */
export function applyWorkspaces(options: { dataDir: string; from: string; to: string }): WorkspaceRepairPlan & { writtenSessions: number; writtenGroups: number } {
  const database = join(resolve(options.dataDir), DATABASE);
  canOpen(database, options.dataDir);
  const db = new DatabaseSync(database);
  try {
    db.exec('PRAGMA busy_timeout=5000');
    db.exec('BEGIN IMMEDIATE');
    try {
      const plan = collect(db, database, options.from, options.to);
      let writtenSessions = 0, writtenGroups = 0;
      for (const [table, changes] of [['sessions', plan.sessions], ['groups', plan.groups]] as const) {
        const read = db.prepare(`SELECT data FROM ${table} WHERE id = ?`);
        const write = db.prepare(`UPDATE ${table} SET data = ? WHERE id = ?`);
        for (const change of changes) {
          const row = read.get(change.id) as { data: string } | undefined;
          if (!row) continue;
          write.run(JSON.stringify({ ...(JSON.parse(row.data) as object), ...change.patch }), change.id);
          if (table === 'sessions') writtenSessions++;
          else writtenGroups++;
        }
      }
      db.exec('COMMIT');
      return { ...plan, writtenSessions, writtenGroups };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally { db.close(); }
}

function canOpen(database: string, dataDir: string) {
  if (!isDirectory(resolve(dataDir))) throw new Error(`数据目录不存在：${resolve(dataDir)}；可用 --data-dir 或 SESSIONDECK_DATA_DIR 指定`);
  try { if (!statSync(database).isFile()) throw new Error('not a file'); }
  catch { throw new Error(`数据目录里没有 ${DATABASE}：${resolve(dataDir)}`); }
}

function usage() {
  console.log(`Dili 工作区路径修复

用法：npm run repair:workspaces -- --from <旧目录> --to <新目录> [--apply] [--data-dir <目录>]
（等价于 npx tsx scripts/repair-workspaces.ts，需在 Dili checkout 内运行）

  --from       被重命名或移动的目录（绝对路径）；只有它和它下面的路径会被改写
  --to         它的新位置（必须已经存在）
  --data-dir   Dili 数据目录，默认 $SESSIONDECK_DATA_DIR 或 ~/.local/share/dili（迁移前回退旧目录）
  --apply      真正写入；不加只预览

场景：把源码目录从 ~/Develop/sessiondeck 改名为 ~/Develop/dili 之类。
联系人保留原生会话 ID，但工作目录仍是旧路径，启动会报“工作目录不存在或无法访问”。
本工具只改写旧前缀下的路径，并跳过新目录不存在的情况。写入前建议先运行 npm run backup。
写入后需要重启 Dili（运行中的实例仍持有旧路径的内存快照）。`);
}

function describe(change: WorkspaceChange): string[] {
  return change.fields.map(field => `  ${field.field}  ${field.from} → ${field.to}`);
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      'data-dir': { type: 'string' },
      apply: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });
}

export function main(argv: string[]): number {
  let parsed: ReturnType<typeof parse>;
  try { parsed = parse(argv); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    usage();
    return 2;
  }
  const values = parsed.values;
  if (values.help) { usage(); return 0; }
  if (!values.from || !values.to) { usage(); return 2; }
  const dataDir = resolve(values['data-dir'] || existingDataDir());
  const from = resolve(values.from);
  const to = resolve(values.to);
  if (from === to) { console.error('--from 与 --to 相同，没有需要修复的路径。'); return 2; }
  if (from === '/') { console.error('拒绝以根目录为改写前缀，请指定具体目录。'); return 2; }
  if (!isDirectory(to)) { console.error(`新目录不存在或不是目录：${to}`); return 2; }

  let applied: ReturnType<typeof applyWorkspaces> | null = null;
  let plan: WorkspaceRepairPlan;
  try {
    if (values.apply) applied = applyWorkspaces({ dataDir, from, to });
    plan = applied ?? planWorkspaces({ dataDir, from, to });
  } catch (error) {
    console.error(`修复失败：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  console.log(`Dili 工作区路径修复（${applied ? '已写入' : '预览，不写入'}）\n`);
  console.log(`数据目录：${dataDir}`);
  console.log(`改写规则：${from} → ${to}`);
  if (isDirectory(from)) console.log(`注意：旧目录仍然存在（${from}）——如果这不是重命名，请确认要把旧路径改成新目录。`);
  console.log('');
  for (const change of plan.sessions) console.log(`会话${change.archived ? '（已归档）' : ''}「${change.title}」${change.id.slice(0, 8)}\n${describe(change).join('\n')}`);
  for (const change of plan.groups) console.log(`群组「${change.title}」${change.id.slice(0, 8)}\n${describe(change).join('\n')}`);
  if (!plan.sessions.length && !plan.groups.length) console.log('没有需要修复的路径。');

  if (plan.missing.length) {
    console.log('\n跳过（新目录不存在，保留原路径）：');
    for (const skip of plan.missing) console.log(`  「${skip.title}」${skip.field}  ${skip.from} → ${skip.target}`);
  }

  if (applied) {
    console.log(`\n已写入 ${applied.writtenSessions} 个会话、${applied.writtenGroups} 个群组。`);
    console.log('运行中的实例内存里仍是旧路径；重启 Dili 后生效（例如 scripts/restart-service.sh）。');
  } else if (plan.sessions.length || plan.groups.length) {
    console.log(`\n共 ${plan.sessions.length} 个会话、${plan.groups.length} 个群组需要修复。`);
    console.log('先确认上面的改写，再运行 npm run backup，然后加 --apply 写入。');
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
