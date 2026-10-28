import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Name of the marker file left beside a published build, read by
 * scripts/needs-build.ts to decide whether a later commit changed its inputs. */
export const BUILD_MARKER = '.build-commit';

/** The current commit, or null outside a git checkout (e.g. a packaged install). */
export async function currentCommit(root: string): Promise<string | null> {
  try { return (await exec('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim() || null; }
  catch { return null; }
}

async function copyAtomically(source: string, target: string) {
  const temporary = join(dirname(target), `.${basename(target)}-${randomUUID()}.tmp`);
  try {
    await copyFile(source, temporary);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Keep old hashed chunks for open tabs and switch HTML only after all new
 * assets exist. Neither a failed build nor a rebuild empties the live site. */
export async function publishClientBuild(staging: string, destination: string) {
  const index = join(staging, 'index.html');
  if (!(await stat(index)).isFile()) throw new Error('前端构建缺少 index.html');
  async function copyDirectory(source: string, target: string) {
    await mkdir(target, { recursive: true });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      const from = join(source, entry.name), to = join(target, entry.name);
      if (from === index) continue;
      if (entry.isDirectory()) await copyDirectory(from, to);
      else if (entry.isFile()) await copyAtomically(from, to);
      else throw new Error(`前端构建包含不支持的文件类型：${entry.name}`);
    }
  }
  await copyDirectory(staging, destination);
  await copyAtomically(index, join(destination, 'index.html'));
  await pruneStaleAssets(join(staging, 'assets'), join(destination, 'assets'));
}

/** Old hashed chunks stay for a week so long-open tabs can still lazy-load them;
 * anything older that the current build no longer ships is removed. Without this
 * every rebuild accumulates another copy of every chunk. Each publish rewrites the
 * current build's files, so their modification time is always fresh. */
export async function pruneStaleAssets(current: string, live: string, maxAgeMs = 7 * 86400_000, now = Date.now()) {
  const shipped = new Set(await readdir(current).catch(() => [] as string[]));
  let removed = 0;
  for (const entry of await readdir(live, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || shipped.has(entry.name)) continue;
    const path = join(live, entry.name);
    if (now - (await stat(path)).mtimeMs < maxAgeMs) continue;
    await rm(path, { force: true }); removed++;
  }
  return removed;
}

async function buildClient() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const destination = resolve(process.env.SESSIONDECK_CLIENT_DIR || join(root, 'dist/client'));
  await mkdir(dirname(destination), { recursive: true });
  const staging = await mkdtemp(join(dirname(destination), '.sessiondeck-build-'));
  try {
    const { build } = await import('vite');
    await build({ root, build: { outDir: staging, emptyOutDir: true } });
    const commit = await currentCommit(root);
    if (commit) await writeFile(join(staging, BUILD_MARKER), commit + '\n');
    await publishClientBuild(staging, destination);
    console.log(`前端构建就绪：${destination}`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildClient();
