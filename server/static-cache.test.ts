import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

async function freePort() {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return address.port;
}

test('hashed assets are cached for a year; the shell, service worker and manifest are always revalidated', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sessiondeck-static-cache-'));
  const client = join(directory, 'client');
  await mkdir(join(client, 'assets'), { recursive: true });
  await writeFile(join(client, 'index.html'), '<!doctype html><script src="/assets/app-abc123.js"></script>');
  await writeFile(join(client, 'assets/app-abc123.js'), 'console.log(1)');
  await writeFile(join(client, 'sw.js'), '// worker');
  await writeFile(join(client, 'manifest.webmanifest'), '{}');
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: { ...process.env, PORT: String(port), SESSIONDECK_PORT: String(port), SESSIONDECK_HOST: '127.0.0.1', HOST: '127.0.0.1', SESSIONDECK_DEMO: '1', SESSIONDECK_DATA_DIR: join(directory, 'data'), SESSIONDECK_CLIENT_DIR: client },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = ''; child.stdout?.on('data', chunk => { logs += chunk; }); child.stderr?.on('data', chunk => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill('SIGTERM'); const hard = setTimeout(() => child.kill('SIGKILL'), 3000);
      await ended.finally(() => clearTimeout(hard));
    }
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (child.exitCode !== null) assert.fail(`server exited: ${logs}`);
    try { if ((await fetch(`${base}/api/config`)).ok) break; } catch { /* not ready */ }
    await delay(50);
  }
  const asset = await fetch(`${base}/assets/app-abc123.js`);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  // A missing hashed asset is a 404, never the HTML shell cached for a year.
  const missing = await fetch(`${base}/assets/gone-zzz999.js`);
  assert.equal(missing.status, 404);
  assert.doesNotMatch(missing.headers.get('cache-control') ?? '', /immutable/);
  for (const path of ['/sw.js', '/manifest.webmanifest']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('cache-control'), 'no-cache', path);
  }
  const shell = await fetch(`${base}/`);
  assert.equal(shell.headers.get('cache-control'), 'no-store');
});
