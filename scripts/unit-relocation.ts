import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * A systemd unit stores absolute paths, so renaming or moving the checkout
 * leaves it pointing at the old directory: restarting then either fails or
 * starts the old tree. This rewrites just the lines that name the checkout and
 * keeps every other line, so custom `Environment=` entries (CODEX_HOME, a
 * pinned data directory, …) survive. A unit that is not ours is left for the
 * caller to reinstall.
 */

const PLAIN_PATH = /^\/[^\s\\"%$]*$/u;

export interface UnitRelocation {
  action: 'none' | 'rewrite' | 'reinstall';
  /** The checkout directory the unit named, when it could be found. */
  from?: string;
  text?: string;
  reason?: string;
}

/** Splits one `ExecStart=` value into its command and arguments. */
function commandTokens(value: string): string[] {
  return [...value.matchAll(/"([^"]*)"|(\S+)/gu)].map(match => match[1] ?? match[2]);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
}

/** The checkout a unit was installed from, from `ExecStart=`. */
export function unitCheckout(execStart: string): string | null {
  for (const token of commandTokens(execStart)) {
    const path = unquote(token);
    if (path.endsWith('/bin/dili.mjs')) return path.slice(0, -'/bin/dili.mjs'.length);
    if (path.endsWith('/start.sh')) return path.slice(0, -'/start.sh'.length);
  }
  return null;
}

/** Replaces a directory prefix only where it ends at a path boundary. */
function replacePrefix(line: string, before: string, after: string): string {
  let index = 0;
  let result = '';
  let replaced = false;
  while (true) {
    const at = line.indexOf(before, index);
    if (at < 0) { result += line.slice(index); break; }
    const boundary = line[at + before.length];
    // `/a/b` must not rewrite a sibling such as `/a/b-old`.
    if (boundary === undefined || boundary === '/' || boundary === '"' || boundary === ' ' || boundary === '\t') {
      result += line.slice(index, at) + after;
      replaced = true;
    } else {
      result += line.slice(index, at + before.length);
    }
    index = at + before.length;
  }
  return replaced ? result : line;
}

/** Pure half of the CLI: decides and rewrites without touching the disk. */
export function planUnitRelocation(text: string, projectDir: string): UnitRelocation {
  const lines = text.split('\n');
  const execStart = lines.find(line => line.startsWith('ExecStart='));
  if (!execStart) return { action: 'reinstall', reason: '单元没有 ExecStart=' };
  const checkout = unitCheckout(execStart.slice('ExecStart='.length));
  if (!checkout) return { action: 'reinstall', reason: 'ExecStart 不是 Dili 的启动命令' };
  const working = lines.find(line => line.startsWith('WorkingDirectory='));
  const from = checkout !== projectDir
    ? checkout
    : working && unquote(working.slice('WorkingDirectory='.length)) !== projectDir
      ? unquote(working.slice('WorkingDirectory='.length))
      : '';
  if (!from) return { action: 'none' };
  if (!PLAIN_PATH.test(from) || !PLAIN_PATH.test(projectDir)) {
    return { action: 'reinstall', from, reason: '路径包含 systemd 转义字符，无法安全改写' };
  }
  const rewritten = lines.map((line) => {
    if (!/^(?:WorkingDirectory|ExecStart|Environment)=/u.test(line)) return line;
    return replacePrefix(line, from, projectDir);
  }).join('\n');
  if (rewritten === text) return { action: 'reinstall', from, reason: '单元里找不到旧目录' };
  return { action: 'rewrite', from, text: rewritten };
}

function main(argv: string[]): number {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!['--unit', '--project'].includes(name) || !value) { console.error('用法：scripts/unit-relocation.ts --unit <单元文件> --project <本项目目录>'); return 2; }
    values[name.slice(2)] = value;
  }
  if (!values.unit || !values.project) { console.error('用法：scripts/unit-relocation.ts --unit <单元文件> --project <本项目目录>'); return 2; }
  const plan = planUnitRelocation(readFileSync(values.unit, 'utf8'), values.project);
  if (plan.action === 'rewrite') {
    writeFileSync(values.unit, plan.text ?? '');
    console.log(`rewrite ${plan.from}`);
  } else if (plan.action === 'reinstall') {
    console.log(`reinstall ${plan.reason}`);
  } else {
    console.log('none');
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
