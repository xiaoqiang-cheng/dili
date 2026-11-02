#!/usr/bin/env node
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const usage = `Dili · 嘀哩工作台 ${metadata.version}

Usage: dili [start] [--port 4317] [--host 127.0.0.1] [--data-dir PATH]
       dili doctor [--port PORT] [--data-dir PATH]
       dili service status|enable|disable [--port PORT] [--data-dir PATH]

Node.js 24+ required. Ctrl+C stops the foreground server.
Data defaults to ~/.local/share/dili and survives upgrades;
~/.local/share/sessiondeck is migrated on the first start after the rename.
service enable/disable changes auto-start only; it never restarts a live server.
On WSL, auto-start applies after the distribution has started.
`;

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return; }
  if (args.length === 1 && ['--version', '-v'].includes(args[0])) { console.log(metadata.version); return; }
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Dili requires Node.js 24+.');
  const command = args[0] && !args[0].startsWith('-') ? args.shift() : 'start';
  if (!['start', 'doctor', 'service'].includes(command)) throw new Error(`Unknown command: ${command}. Run dili --help.`);
  const action = command === 'service' ? args.shift() : undefined;
  if (command === 'service' && !['status', 'enable', 'disable'].includes(action)) throw new Error('Use dili service status|enable|disable.');
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i], value = args[i + 1];
    if (!['--port', '--host', '--data-dir'].includes(name) || !value || value.startsWith('--')) throw new Error(`Invalid option: ${name}`);
    if (name === '--port') {
      if (!/^\d+$/.test(value) || Number(value) < 1024 || Number(value) > 65535) throw new Error('Port must be between 1024 and 65535.');
      process.env.PORT = process.env.SESSIONDECK_PORT = value;
    } else if (name === '--host') process.env.HOST = process.env.SESSIONDECK_HOST = value;
    else process.env.SESSIONDECK_DATA_DIR = resolve(value);
  }
  const register = pathToFileURL(require.resolve('tsx/esm')).href;
  if (command === 'service') {
    await import(register);
    const { StartupService } = await import(pathToFileURL(join(root, 'server/startup.ts')).href);
    const service = new StartupService({ root });
    console.log(JSON.stringify(action === 'status' ? await service.status() : await service.change(action === 'enable'), null, 2));
    return;
  }
  if (command === 'start') {
    if (!existsSync(join(root, 'dist/client/index.html')) && !process.env.SESSIONDECK_CLIENT_DIR) throw new Error('Web assets missing. In a source checkout run npm run build first.');
    // Port/data checks run before creating locks, children or writable files.
    const { spawnSync } = await import('node:child_process');
    const probe = spawnSync(process.execPath, [join(root, 'scripts/check-start.mjs')], { stdio: 'inherit', env: process.env });
    if (probe.error) throw probe.error;
    if (probe.status !== 0) { process.exitCode = probe.status ?? 1; return; }
    await import(register);
    const { checkPty } = await import(pathToFileURL(join(root, 'server/pty-health.ts')).href);
    await checkPty();
    // Keep the CLI as the actual service process. cwd remains the user's project.
    await import(pathToFileURL(join(root, 'server/index.ts')).href);
  } else {
    const child = spawn(process.execPath, ['--import', register, join(root, 'scripts/doctor.ts')], { stdio: 'inherit', env: process.env });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
    child.once('error', error => { console.error(error.message); process.exitCode = 1; });
    child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
  }
}
main().catch(error => { console.error(`Dili: ${error.message}`); process.exitCode = 1; });
