import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createProbe } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

async function freePort(): Promise<number> {
  const probe = createProbe();
  await new Promise<void>((accept, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', accept); });
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((accept, reject) => probe.close(error => error ? reject(error) : accept()));
  return port;
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(accept => child.once('exit', () => accept()));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await exited; } finally { clearTimeout(timer); }
}

test('the owner can proxy an allowlisted local service', { timeout: 30_000 }, async t => {
  const upstream = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ url: req.url, host: req.headers.host, method: req.method, body }));
    });
  });
  await new Promise<void>(accept => upstream.listen(0, '127.0.0.1', accept));
  const targetAddress = upstream.address();
  assert.ok(targetAddress && typeof targetAddress === 'object');
  const target = `http://127.0.0.1:${targetAddress.port}`;

  const port = await freePort();
  const directory = mkdtempSync(join(tmpdir(), 'sessiondeck-proxy-api-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      SESSIONDECK_PORT: String(port),
      SESSIONDECK_DEMO: '1',
      SESSIONDECK_DATA_DIR: directory,
      SESSIONDECK_WEB_PROXY_TARGETS: target,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout?.on('data', chunk => { logs = (logs + chunk).slice(-8000); });
  child.stderr?.on('data', chunk => { logs = (logs + chunk).slice(-8000); });
  t.after(async () => {
    await stop(child);
    await new Promise<void>(accept => upstream.close(() => accept()));
    rmSync(directory, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  let config: { csrfToken: string } | undefined;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture exited: ${logs}`);
    try {
      const response = await fetch(`${base}/api/config`);
      if (response.ok) { config = await response.json() as { csrfToken: string }; break; }
    } catch { /* startup */ }
    await delay(25);
  }
  assert.ok(config?.csrfToken, `server did not start: ${logs}`);

  const denied = await fetch(`${base}/api/web-proxy`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: `${target}/` }),
  });
  assert.equal(denied.status, 403);

  const minted = await fetch(`${base}/api/web-proxy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sessiondeck-token': config.csrfToken },
    body: JSON.stringify({ url: `${target}/app` }),
  });
  assert.equal(minted.status, 201);
  const proxy = await minted.json() as { path: string };
  assert.match(proxy.path, /^\/web-proxy\/[A-Za-z0-9_-]+\/$/);

  const proxied = await (await fetch(`${base}${proxy.path}hello?x=1`)).json() as { url: string; host: string };
  assert.equal(proxied.url, '/app/hello?x=1');
  assert.equal(proxied.host, `127.0.0.1:${targetAddress.port}`);

  // Dili's global JSON parser must not consume a proxied app's POST body.
  const posted = await (await fetch(`${base}${proxy.path}echo`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"value":42}',
  })).json() as { body: string; method: string };
  assert.equal(posted.method, 'POST');
  assert.equal(posted.body, '{"value":42}');

  const blocked = await fetch(`${base}/api/web-proxy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sessiondeck-token': config.csrfToken },
    body: JSON.stringify({ url: 'http://127.0.0.1:9/' }),
  });
  assert.equal(blocked.status, 403);
});
