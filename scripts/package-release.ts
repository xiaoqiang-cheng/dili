import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { name: string; version: string };
const version = packageJson.version;
const releaseDir = resolve(process.env.RELEASE_DIR || join(root, 'dist/releases'));
await mkdir(dirname(releaseDir), { recursive: true });
const staging = await mkdtemp(join(dirname(releaseDir), '.release-'));
const appName = `dili-${version}-linux-x86_64`;
const relayName = `dili-relay-${version}-linux-x86_64`;

async function copy(source: string, target: string) {
  await cp(join(root, source), join(staging, target), { recursive: true });
}
async function archive(name: string, source: string) {
  await mkdir(releaseDir, { recursive: true });
  await exec('tar', ['-czf', join(releaseDir, `${name}.tar.gz`), '-C', staging, source]);
}

try {
  await mkdir(join(staging, appName), { recursive: true });
  for (const path of ['dist/client', 'bin', 'server', 'shared', 'scripts', 'docs', 'package.json', 'package-lock.json', 'README.MD']) await copy(path, join(appName, path));
  // Release users run the prebuilt UI; never rebuild or reinstall during service startup.
  const appLauncher = ['#!/usr/bin/env bash', 'set -euo pipefail', 'root="$(CDPATH=\'\' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"', 'exec node "$root/bin/dili.mjs" "$@"', ''].join('\n');
  await writeFile(join(staging, appName, 'start.sh'), appLauncher, { mode: 0o755 });
  await writeFile(join(staging, appName, 'INSTALL.md'), '# Dili ' + version + ' for Linux x86_64\n\n需要 Node.js 24+。解压后执行 npm ci --omit=dev 安装运行依赖，再执行 ./start.sh。网页已经构建，启动时不会重新安装或编译。默认监听 4317；./start.sh service enable 配置下次登录自动运行，不会重启或停止现有实例。详细说明见 docs/installation.md。\n');
  await archive(appName, appName);

  await mkdir(join(staging, relayName, 'relay', 'clients'), { recursive: true });
  await copy('dist/relay/relay.mjs', join(relayName, 'relay/relay.mjs'));
  await copy('dist/relay/index.html', join(relayName, 'relay/index.html'));
  await copy('dist/relay/public.caddy', join(relayName, 'relay/public.caddy'));
  await copy('dist/relay/pwa.caddy', join(relayName, 'relay/pwa.caddy'));
  const clientArchive = `frp_${(await import('../shared/frp.ts')).FRP_VERSION}_linux_amd64.tar.gz`;
  await copy(`dist/relay/clients/${clientArchive}`, join(relayName, 'relay/clients', clientArchive));
  const launcher = ['#!/usr/bin/env bash', 'set -euo pipefail', 'root="$(CDPATH=\'\' cd -- \"$(dirname -- \"${BASH_SOURCE[0]}\")\" && pwd)"', 'export SESSIONDECK_RELAY_HTML="$root/relay/index.html"', 'export SESSIONDECK_RELAY_CLIENTS_DIR="$root/relay/clients"', 'exec node "$root/relay/relay.mjs"', ''].join('\n');
  await writeFile(join(staging, relayName, 'start-relay.sh'), launcher, { mode: 0o755 });
  await writeFile(join(staging, relayName, 'README.md'), '# Dili Relay ' + version + ' for Linux x86_64\n\n配置 SESSIONDECK_RELAY_URL（默认 https://dili.discoverpaw.com/connect）和可选的 SESSIONDECK_RELAY_DOMAINS 后执行 ./start-relay.sh。域名必须解析到同一台 Caddy／中继服务。还需单独安装并配置 frps 与 Caddy；本脚本仅启动配对服务，不会自动启动整套中继。自定义域名需完成 DNS、TLS、Caddy 配置并验收配对与隧道。\n');
  await archive(relayName, relayName);
  await exec(process.execPath, ['--import', 'tsx', 'scripts/build-pwa.ts'], { cwd: root });
  const pwaName = `dili-pwa-${version}-all-platforms`;
  await copy('dist/pwa', pwaName);
  await copy('docs/pwa.md', join(pwaName, 'INSTALL.md'));
  await archive(pwaName, pwaName);
  await exec('npm', ['pack', '--ignore-scripts', '--pack-destination', releaseDir], { cwd: root });
  const files = (await readdir(releaseDir)).filter(name => name.endsWith('.tar.gz') || name.endsWith('.tgz')).sort();
  const sums = await Promise.all(files.map(async name => `${createHash('sha256').update(await readFile(join(releaseDir, name))).digest('hex')}  ${name}`));
  await writeFile(join(releaseDir, 'SHA256SUMS'), sums.join('\n') + '\n');
  console.log(`发布包已生成：${releaseDir}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
