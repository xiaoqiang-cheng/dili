import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { AgentSetup, codexApiLogin } from './agent-setup.ts';
import { StartupService, unitQuote } from './startup.ts';
import { authorize } from './access.ts';

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'dili-setup-'));
  const logins: string[][] = [];
  const setup = new AgentSetup({ home, find: async id => `/native/${id}`, login: async (file, key) => { logins.push([file, key]); } });
  return { home, setup, logins, clean: () => rm(home, { recursive: true, force: true }) };
}

test('Claude config uses native settings, retains unrelated fields and backs up with private permissions', async () => {
  const f = await fixture();
  try {
    const dir = join(f.home, '.claude'); await mkdir(dir);
    const path = join(dir, 'settings.json');
    const previous = JSON.stringify({ env: { OTHER: 'keep', ANTHROPIC_API_KEY: 'old-secret' }, permissions: { allow: ['Read'] }, model: 'previous' });
    await writeFile(path, previous);
    const result = await f.setup.save('claude', { apiKey: 'new-secret', baseUrl: 'https://api.example/v1', model: 'custom-model' });
    const config = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(config.env.ANTHROPIC_API_KEY, 'new-secret'); assert.equal(config.env.OTHER, 'keep'); assert.deepEqual(config.permissions, { allow: ['Read'] });
    assert.equal(config.model, 'custom-model'); assert.equal(config.env.ANTHROPIC_BASE_URL, 'https://api.example/v1');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const backup = (await readdir(dir)).find(name => name.includes('dili-backup'))!;
    assert.equal(await readFile(join(dir, backup), 'utf8'), previous); assert.equal((await stat(join(dir, backup))).mode & 0o777, 0o600);
    assert.doesNotMatch(JSON.stringify(result), /new-secret|old-secret/);
    await f.setup.save('claude', { apiKey: '', baseUrl: '', model: '' });
    const reset = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(reset.env.ANTHROPIC_API_KEY, 'new-secret'); assert.equal(reset.env.ANTHROPIC_BASE_URL, undefined); assert.equal(reset.model, undefined);
  } finally { await f.clean(); }
});

test('Codex saves native TOML and sends API key to native login separately, preserving projects/providers', async () => {
  const f = await fixture();
  try {
    const dir = join(f.home, '.codex'); await mkdir(dir);
    const path = join(dir, 'config.toml');
    await writeFile(path, 'model = "original"\n[projects."/work"]\ntrust_level = "trusted"\n[model_providers.previous]\nname = "Previous"\n');
    const result = await f.setup.save('codex', { apiKey: 'private-key', baseUrl: 'https://api.example/v1', model: 'new-model' });
    const config = JSON.parse(JSON.stringify(parse(await readFile(path, 'utf8'))));
    assert.equal(config.model_provider, 'dili'); assert.equal(config.model, 'new-model');
    assert.deepEqual(config.projects, { '/work': { trust_level: 'trusted' } });
    assert.deepEqual((config.model_providers as Record<string, unknown>).previous, { name: 'Previous' });
    assert.deepEqual((config.model_providers as Record<string, unknown>).dili, { name: 'Dili custom API', base_url: 'https://api.example/v1', wire_api: 'responses', requires_openai_auth: true });
    assert.deepEqual(f.logins, [['/native/codex', 'private-key']]);
    assert.doesNotMatch(await readFile(path, 'utf8'), /private-key/); assert.doesNotMatch(JSON.stringify(result), /private-key/);
    await f.setup.save('codex', { baseUrl: '' });
    assert.equal(parse(await readFile(path, 'utf8')).model_provider, undefined);
  } finally { await f.clean(); }
});

test('malformed configs, symlinks, insecure URLs and control characters fail without overwriting or leaking source', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.home, '.codex')); const path = join(f.home, '.codex/config.toml');
    const invalid = 'private-key-secret = "unterminated'; await writeFile(path, invalid);
    await assert.rejects(f.setup.save('codex', { apiKey: 'secret' }), error => { assert.doesNotMatch(String(error), /private-key-secret/); return true; });
    assert.deepEqual(f.logins, []); assert.equal(await readFile(path, 'utf8'), invalid);
    for (const input of [{ baseUrl: 'http://api.example' }, { baseUrl: 'https://user:secret@api.example' }, { baseUrl: 'https://api.example?key=secret' }, { apiKey: 'line\nbreak' }, { model: 'x\u0000y' }]) await assert.rejects(f.setup.save('claude', input));
    await mkdir(join(f.home, '.claude')); await symlink(path, join(f.home, '.claude/settings.json'));
    await assert.rejects(f.setup.save('claude', { model: 'x' })); assert.equal(await readFile(path, 'utf8'), invalid);
    await assert.rejects(f.setup.save('dsh', { apiKey: 'x' }), /原生 Web/);
  } finally { await f.clean(); }
});

test('installation commands are allowlisted and detected executables are shell quoted', async () => {
  const f = await fixture();
  try {
    assert.equal(await f.setup.command('dsh', 'install'), 'npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui');
    await assert.rejects(f.setup.command('claude', 'delete' as never), /未知/);
    const setup = new AgentSetup({ home: f.home, find: async () => "/path/a'$(touch anything)" });
    assert.equal(await setup.command('codex', 'login'), `'` + `/path/a'"'"'$(touch anything)` + `' login --device-auth`);
  } finally { await f.clean(); }
});

test('native Codex key login uses stdin and does not expose child output or arguments', async () => {
  const f = await fixture();
  try {
    const script = join(f.home, 'fake-codex');
    await writeFile(script, '#!/usr/bin/env node\nlet input="";process.stdin.on("data",c=>input+=c);process.stdin.on("end",()=>{console.error(input);process.exit(JSON.stringify(process.argv.slice(2))===JSON.stringify(["login","--with-api-key"])&&input==="private-key\\n"?0:1)});\n'); await chmod(script, 0o700);
    await codexApiLogin(script, 'private-key');
    await assert.rejects(codexApiLogin(script, 'wrong-key'), error => { assert.doesNotMatch(String(error), /wrong-key/); return true; });
  } finally { await f.clean(); }
});

test('systemd future startup toggles without stopping/restarting active services, unit keeps runtime paths', async () => {
  const f = await fixture();
  let enabled = false;
  const calls: string[][] = [];
  const runner = async (file: string, args: string[]) => {
    calls.push([file, ...args]);
    if (args.includes('is-enabled')) return { stdout: enabled ? 'enabled\n' : 'disabled\n', code: enabled ? 0 : 1 };
    if (args.includes('is-active')) return { stdout: 'active\n', code: 0 };
    if (file === 'loginctl') return { stdout: 'no\n', code: 0 };
    if (args.includes('enable')) enabled = true;
    if (args.includes('disable')) enabled = false;
    return { stdout: '', code: 0 };
  };
  try {
    const service = new StartupService({ root: '/npm prefix/dili', configDir: f.home, dataDir: join(f.home, 'data'), cwd: '/my project', port: 4567, platform: 'linux', wsl: false, runner });
    assert.equal((await service.change(true)).enabled, true);
    const path = join(f.home, 'systemd/user/dili.service'), unit = await readFile(path, 'utf8');
    assert.match(unit, /^WorkingDirectory=\/my project$/m); assert.match(unit, /SESSIONDECK_PORT=4567/); assert.match(unit, /bin\/dili.mjs/);
    assert.doesNotMatch(unit, /API_KEY|AUTH_TOKEN|npm start|start.sh/);
    assert.equal((await service.change(false)).active, true); assert.equal(enabled, false);
    assert.equal(await readFile(path, 'utf8'), unit);
    assert.ok(!calls.some(call => call.some(arg => ['stop', 'restart', 'start', '--now', 'enable-linger'].includes(arg))));
    assert.equal(unitQuote('a%$b"c', true), '"a%%$$b\\"c"');
    assert.equal(unitQuote('a%$b'), '"a%%$b"');
    assert.throws(() => unitQuote('bad\nvalue'));
  } finally { await f.clean(); }
});

test('legacy sessiondeck.service migrates to dili.service by disabling it, never stopping it', async () => {
  const f = await fixture();
  const enabled = new Set(['sessiondeck.service']);
  const calls: string[][] = [];
  const runner = async (file: string, args: string[]) => {
    calls.push([file, ...args]);
    const name = args.at(-1)!;
    if (args.includes('is-enabled')) return enabled.has(name) ? { stdout: 'enabled\n', code: 0 } : { stdout: 'disabled\n', code: 1 };
    if (args.includes('is-active')) return name === 'sessiondeck.service' ? { stdout: 'active\n', code: 0 } : { stdout: 'inactive\n', code: 3 };
    if (file === 'loginctl') return { stdout: 'no\n', code: 0 };
    if (args.includes('enable')) enabled.add(name);
    if (args.includes('disable')) enabled.delete(name);
    return { stdout: '', code: 0 };
  };
  try {
    const legacyPath = join(f.home, 'systemd/user/sessiondeck.service'); await mkdir(join(legacyPath, '..'), { recursive: true });
    const legacyUnit = `[Service]\nWorkingDirectory="/my project"\nEnvironment="SESSIONDECK_DATA_DIR=${join(f.home, 'data')}"\nEnvironment="SESSIONDECK_PORT=4567"\nExecStart="/usr/bin/node" ${unitQuote('/npm prefix/dili/bin/dili.mjs', true)}\n`;
    await writeFile(legacyPath, legacyUnit);
    const service = new StartupService({ root: '/npm prefix/dili', configDir: f.home, dataDir: join(f.home, 'data'), cwd: '/my project', port: 4567, platform: 'linux', wsl: false, runner });
    const before = await service.status();
    assert.deepEqual([before.legacy, before.enabled, before.active, before.conflict], [true, true, true, false]);
    assert.match(before.note, /dili\.service/);
    const after = await service.change(true);
    assert.deepEqual([after.legacy, after.enabled], [false, true]);
    assert.deepEqual([...enabled], ['dili.service']);
    assert.match(await readFile(join(f.home, 'systemd/user/dili.service'), 'utf8'), /^WorkingDirectory=\/my project$/m);
    assert.equal(await readFile(legacyPath, 'utf8'), legacyUnit);
    assert.ok(!calls.some(call => call.some(arg => ['stop', 'restart', 'start', '--now'].includes(arg))));
    // Turning auto-start off with only the legacy unit enabled disables it as well.
    enabled.clear(); enabled.add('sessiondeck.service');
    await rm(join(f.home, 'systemd/user/dili.service'));
    assert.equal((await service.change(false)).enabled, false);
    assert.equal(enabled.size, 0);
  } finally { await f.clean(); }
});

test('a unit pinning the pre-rename data directory still matches after the migration', async () => {
  const f = await fixture();
  const runner = async (file: string, args: string[]) => {
    if (file === 'loginctl') return { stdout: 'no\n', code: 0 };
    if (args.includes('is-enabled')) return { stdout: 'enabled\n', code: 0 };
    if (args.includes('is-active')) return { stdout: 'active\n', code: 0 };
    return { stdout: '', code: 0 };
  };
  try {
    const share = join(f.home, '.local/share');
    const legacy = join(share, 'sessiondeck'), canonical = join(share, 'dili');
    await mkdir(canonical, { recursive: true });
    // What migrateDataDir leaves behind: the old path is a link to the new one.
    await symlink(canonical, legacy, 'dir');
    const path = join(f.home, 'systemd/user/dili.service');
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, `[Service]\nWorkingDirectory="/my project"\nEnvironment="SESSIONDECK_DATA_DIR=${legacy}"\nEnvironment="SESSIONDECK_PORT=4567"\nExecStart="/usr/bin/node" ${unitQuote('/npm prefix/dili/bin/dili.mjs', true)}\n`);
    const service = new StartupService({ root: '/npm prefix/dili', configDir: f.home, dataDir: canonical, cwd: '/my project', port: 4567, platform: 'linux', wsl: false, runner });
    const status = await service.status();
    assert.deepEqual([status.conflict, status.enabled, status.active], [false, true, true]);
  } finally { await f.clean(); }
});

test('startup refuses another installation and reports WSL without systemd accurately', async () => {
  const f = await fixture(); let changes = 0;
  try {
    const path = join(f.home, 'systemd/user/sessiondeck.service'); await mkdir(join(path, '..'), { recursive: true });
    const unit = '[Service]\nExecStart=/some/other/start.sh\n'; await writeFile(path, unit);
    // A pre-rename unit of another installation blocks creating dili.service too.
    const service = new StartupService({ root: '/new/install', configDir: f.home, platform: 'linux', runner: async (_file, args) => { if (args.includes('enable') || args.includes('disable')) changes++; return { stdout: '', code: 0 }; } });
    assert.equal((await service.status()).conflict, true); await assert.rejects(service.change(true), /其他安装/);
    assert.equal(changes, 0); assert.equal(await readFile(path, 'utf8'), unit);
    const wsl = new StartupService({ root: '/new/install', configDir: f.home, platform: 'linux', wsl: true, runner: async () => ({ stdout: '', code: 1 }) });
    assert.equal((await wsl.status()).supported, false); assert.match((await wsl.status()).note, /WSL 启用 systemd/);
  } finally { await f.clean(); }
});

test('native configuration and auto-start changes are local-only and shares cannot read setup', () => {
  const remote = { kind: 'owner', local: false, deviceId: 'remote' } as const;
  const local = { kind: 'owner', local: true } as const;
  for (const path of ['/api/setup/agents/claude/config', '/api/setup/agents/codex/terminal', '/api/setup/startup']) {
    assert.equal(authorize(remote, true, 'POST', path).allowed, false);
    assert.equal(authorize(local, false, 'POST', path).allowed, true);
  }
  const share = { kind: 'share', deviceId: 'd', shareId: 's', sessionId: 'mine', mode: 'write', name: 'A' } as const;
  assert.equal(authorize(share, true, 'GET', '/api/setup/agents').allowed, false);
  assert.equal(authorize(share, true, 'GET', '/api/setup/startup').allowed, false);
});
