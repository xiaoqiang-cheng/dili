import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Browser baseline: Chrome/Edge/Firefox 111, Safari/iOS 16.2. */
const BANNED: { pattern: RegExp; why: string }[] = [
  { pattern: /\(\?<=/, why: '后行断言在 Safari 16.2 上会直接抛 SyntaxError' },
  { pattern: /\(\?<!</, why: '后行断言在 Safari 16.2 上会直接抛 SyntaxError' },
  { pattern: /\bAbortSignal\.timeout\b/, why: 'Safari 16.4 才支持；使用 client/timeout-signal.ts' },
  { pattern: /\bPromise\.withResolvers\b/, why: 'Safari 17.4 才支持' },
  { pattern: /\bObject\.groupBy\b/, why: 'Safari 17.4 才支持' },
  { pattern: /\bURL\.canParse\b/, why: 'Safari 17 才支持' },
  { pattern: /\bArray\.fromAsync\b/, why: 'Safari 16.4 才支持' },
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    // The helper exists precisely to replace a banned API; its comment mentions it.
    return /\.(?:ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name) && name !== 'timeout-signal.ts' ? [path] : [];
  });
}

test('client code stays inside the declared browser baseline', () => {
  const files = sourceFiles(join(root, 'client'));
  assert.ok(files.length > 50, 'the scan must cover the real client tree');
  const violations: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const { pattern, why } of BANNED) {
      if (pattern.test(source)) violations.push(`${relative(root, file)}: ${pattern} — ${why}`);
    }
  }
  assert.deepEqual(violations, []);
});

test('the browser baseline is declared in one place', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { browserslist?: string[] };
  assert.deepEqual(pkg.browserslist, ['Chrome >= 111', 'Edge >= 111', 'Firefox >= 111', 'Safari >= 16.2', 'iOS >= 16.2']);
  const vite = readFileSync(join(root, 'vite.config.ts'), 'utf8');
  assert.match(vite, /target: \[/);
  assert.match(vite, /safari16\.2/);
});
